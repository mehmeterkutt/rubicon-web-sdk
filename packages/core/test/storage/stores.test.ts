import { MemoryStorage, parseWithPython, TestClock } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { CONSENT_FIELDS, keyHash, PAUSE_FIELDS, REMOTE_FIELDS, STORE_NAMES, storeKey } from '../../src';
import type { PauseRecord, RemoteConfigRecord } from '../../src';
import { KEY_HASH, openPage, plant } from './store-test-support';

const REMOTE: RemoteConfigRecord = {
  etag: '"abc"',
  values: { enabled: true, flush_at: 10, autocapture_off: ['page_views'] },
  fetchedAt: 1_759_147_200_000,
};

const PAUSE: PauseRecord = { until: 1_759_150_800_000, kind: 'throttle', host: '0123456789abcdef' };

describe('the store records', () => {
  describe('keys (Web Identity 4, Web Disk 2)', () => {
    it('are rubicon.<keyHash>.<name> for the five stores', () => {
      expect(STORE_NAMES).toEqual(['device', 'person', 'remote', 'consent', 'pause']);
      expect(KEY_HASH).toBe(keyHash('test-api-key'));
      expect(KEY_HASH).toMatch(/^[0-9a-f]{16}$/);

      const page = openPage();

      expect([
        page.stores.device.key,
        page.stores.person.key,
        page.stores.remote.key,
        page.stores.consent.key,
        page.stores.pause.key,
      ]).toEqual(STORE_NAMES.map((name) => `rubicon.${KEY_HASH}.${name}`));
      expect(storeKey(KEY_HASH, 'pause')).toBe(`rubicon.${KEY_HASH}.pause`);
    });

    it('a run writes no other key, and another key hash is never touched (Web Identity 4)', () => {
      const page = openPage();
      plant(page.storage, 'device', '{"v":1,"device_id":"mine"}');
      const foreign = `rubicon.${keyHash('another-key')}.device`;
      page.storage.area.entries.set(foreign, '{"v":1,"device_id":"theirs"}');
      page.storage.area.entries.set('host-key', 'host value');

      page.stores.device.countDropped('corrupt');
      page.stores.person.register('plan', 'pro');
      page.stores.persist();
      page.stores.remote.save(REMOTE);
      page.stores.consent.save({ state: 'granted', decidedAt: 1 });
      page.stores.pause.write(() => PAUSE);

      expect(Array.from(page.storage.area.entries.keys()).sort()).toEqual(
        [foreign, 'host-key', ...STORE_NAMES.map((name) => storeKey(KEY_HASH, name))].sort(),
      );
      expect(page.storage.area.entries.get(foreign)).toBe('{"v":1,"device_id":"theirs"}');
      expect(page.storage.area.entries.get('host-key')).toBe('host value');
    });

    it('every record is JSON that Python parses with strict UTF-8 (Web Serialization 3)', () => {
      const page = openPage();
      page.stores.person.register('name', 'Gül 🍀');
      page.stores.person.register('line', 'a\nb c');
      page.stores.device.countDropped('queue_full');
      page.stores.persist();
      page.stores.remote.save(REMOTE);
      page.stores.consent.save({ state: 'denied', decidedAt: 2 });
      page.stores.pause.write(() => PAUSE);

      const records = STORE_NAMES.map((name) => page.raw(name)!);
      const answers = parseWithPython(records);

      expect(answers.map((answer) => (answer.ok ? answer.value : answer.error))).toEqual(
        records.map((text) => JSON.parse(text) as unknown),
      );
    });
  });

  describe('.consent (Web Disk 3, Web Privacy 2)', () => {
    it('has exactly the decided keys and reads back as written', () => {
      const page = openPage();
      page.stores.consent.save({ state: 'denied', decidedAt: 1_759_147_200_000 });

      expect(page.raw('consent')).toBe('{"v":1,"state":"denied","decided_at":1759147200000}');
      expect(Object.keys(page.stored('consent')!).sort()).toEqual(['v', ...CONSENT_FIELDS].sort());
      expect(openPage(page.storage.otherPage()).stores.consent.read()).toEqual({
        status: 'present',
        state: { state: 'denied', decidedAt: 1_759_147_200_000 },
      });
    });

    it('is read and written while consent is pending or refused, and not in the memory-only mode', () => {
      const pending = openPage(new MemoryStorage(), new TestClock(), { access: 'consent' });
      expect(pending.stores.consent.save({ state: 'granted', decidedAt: 1 })).toBe('written');
      pending.stores.person.register('plan', 'pro');
      pending.stores.persist();
      expect(Array.from(pending.storage.area.entries.keys())).toEqual([storeKey(KEY_HASH, 'consent')]);

      const memoryOnly = openPage(new MemoryStorage(), new TestClock(), { access: 'none' });
      plant(memoryOnly.storage, 'consent', '{"v":1,"state":"denied","decided_at":1}');
      expect(memoryOnly.stores.consent.read()).toEqual({ status: 'missing' });
      expect(memoryOnly.stores.consent.save({ state: 'granted', decidedAt: 2 })).toBe('held');
      expect(memoryOnly.raw('consent')).toBe('{"v":1,"state":"denied","decided_at":1}');
    });

    it('an opt-out is never undone by counter, retry or person writes of another page (Web Disk 3)', () => {
      const clock = new TestClock();
      const page = openPage(new MemoryStorage(), clock);
      const other = openPage(page.storage.otherPage(), clock);
      page.stores.consent.save({ state: 'granted', decidedAt: clock.now() });
      expect(other.stores.consent.read()).toMatchObject({ state: { state: 'granted' } });
      other.stores.device.countDropped('queue_full');
      other.stores.person.register('plan', 'pro');

      clock.advanceBy(1_000);
      page.stores.consent.save({ state: 'denied', decidedAt: clock.now() });
      other.stores.device.persist();
      other.stores.person.persist();
      other.stores.device.write((state) => ({ ...state, retry: { ...state.retry, step: 1, rev: 1 } }));
      other.log.warn('QUEUE_FULL', () => 'full');

      expect(page.raw('consent')).toBe(`{"v":1,"state":"denied","decided_at":${String(clock.now())}}`);
      expect(other.stores.consent.read()).toMatchObject({ state: { state: 'denied' } });
    });

    it('keeps fields it does not know when a decision is written', () => {
      const page = openPage();
      plant(page.storage, 'consent', '{"v":1,"state":"granted","decided_at":1,"source":"cmp"}');

      page.stores.consent.save({ state: 'denied', decidedAt: 2 });

      expect(page.stored('consent')).toEqual({ v: 1, state: 'denied', decided_at: 2, source: 'cmp' });
    });

    it.each([
      ['an unknown state', '{"v":1,"state":"maybe","decided_at":1}'],
      ['pending is never stored', '{"v":1,"state":"pending","decided_at":1}'],
      ['no time', '{"v":1,"state":"denied"}'],
      ['no state', '{"v":1,"decided_at":1}'],
      ['a newer version', '{"v":2,"state":"denied","decided_at":1}'],
    ])('a record with %s is unreadable and left byte-identical', (_name, content) => {
      const page = openPage();
      plant(page.storage, 'consent', content);

      expect(page.stores.consent.read()).toEqual({ status: 'unreadable' });
      expect(page.stores.consent.save({ state: 'granted', decidedAt: 5 })).toBe('held');
      expect(page.raw('consent')).toBe(content);
      expect(page.logged('STORE_UNREADABLE')).toBe(true);
    });
  });

  describe('.pause (Web Retry 1)', () => {
    it('has exactly the decided keys and reads back as written', () => {
      const page = openPage();
      page.stores.pause.write(() => PAUSE);

      expect(page.raw('pause')).toBe('{"v":1,"until":1759150800000,"kind":"throttle","host":"0123456789abcdef"}');
      expect(Object.keys(page.stored('pause')!).sort()).toEqual(['v', ...PAUSE_FIELDS].sort());
      expect(openPage(page.storage.otherPage()).stores.pause.read()).toEqual({ status: 'present', state: PAUSE });
    });

    it('a write applies its change to the fresh record, so a later stored end can be kept', () => {
      const page = openPage();
      const other = openPage(page.storage.otherPage());
      page.stores.pause.write(() => PAUSE);

      other.stores.pause.write((stored) =>
        stored !== undefined && stored.until >= PAUSE.until - 1 ? stored : { ...PAUSE, until: PAUSE.until - 1 },
      );

      expect(page.stores.pause.read()).toEqual({ status: 'present', state: PAUSE });
      expect(page.storage.writeCount + other.storage.writeCount).toBe(1);
    });

    it('stays in memory while consent is refused (Web Logging 4) and is deleted by remove', () => {
      const page = openPage(new MemoryStorage(), new TestClock(), { access: 'consent' });

      expect(page.stores.pause.write(() => PAUSE)).toBe('held');
      expect(page.stores.pause.state).toEqual(PAUSE);
      expect(page.raw('pause')).toBeNull();

      page.stores.accessLevel = 'full';
      plant(page.storage, 'pause', '{"v":1,"until":1,"kind":"config","host":"h"}');
      expect(page.stores.pause.remove()).toBe(true);
      expect(page.raw('pause')).toBeNull();
      expect(page.stores.pause.state).toBeUndefined();
    });

    it.each([
      ['an unknown kind', '{"v":1,"until":1,"kind":"transient","host":"h"}'],
      ['no host', '{"v":1,"until":1,"kind":"config"}'],
      ['an end that is not a whole number', '{"v":1,"until":"soon","kind":"config","host":"h"}'],
    ])('a record with %s is unreadable and left byte-identical', (_name, content) => {
      const page = openPage();
      plant(page.storage, 'pause', content);

      expect(page.stores.pause.write(() => PAUSE)).toBe('held');
      expect(page.raw('pause')).toBe(content);
    });
  });

  describe('.remote (Web Configuration 5, Web Disk 3)', () => {
    it('has exactly the decided keys and reads back as written', () => {
      const page = openPage();
      page.stores.remote.save(REMOTE);

      expect(page.raw('remote')).toBe(
        '{"v":1,"etag":"\\"abc\\"","values":{"enabled":true,"flush_at":10,"autocapture_off":["page_views"]},' +
          '"fetched_at":1759147200000}',
      );
      expect(Object.keys(page.stored('remote')!).sort()).toEqual(['v', ...REMOTE_FIELDS].sort());
      expect(openPage(page.storage.otherPage()).stores.remote.read()).toEqual({ status: 'present', state: REMOTE });
    });

    it('is written whole: fields of the previous record are not kept', () => {
      const page = openPage();
      plant(page.storage, 'remote', '{"v":1,"etag":"old","values":{"sample_rate":0.5},"fetched_at":1,"extra":true}');

      page.stores.remote.save({ etag: undefined, values: { flush_at: 20 }, fetchedAt: 2 });

      expect(page.raw('remote')).toBe('{"v":1,"values":{"flush_at":20},"fetched_at":2}');
    });

    it('is never written over an unreadable record, and a missing or unreadable one is no cache', () => {
      const page = openPage();
      expect(page.stores.remote.read()).toEqual({ status: 'missing' });
      plant(page.storage, 'remote', '{"v":2,"values":{}}');

      expect(page.stores.remote.save(REMOTE)).toBe('held');
      expect(page.raw('remote')).toBe('{"v":2,"values":{}}');
      expect(page.stores.remote.read()).toEqual({ status: 'unreadable' });
    });

    it('a 404 deletes it', () => {
      const page = openPage();
      page.stores.remote.save(REMOTE);

      expect(page.stores.remote.remove()).toBe(true);

      expect(page.raw('remote')).toBeNull();
    });

    it('a failed save is not kept for a later write', () => {
      const page = openPage();
      page.storage.failWrites = true;

      expect(page.stores.remote.save(REMOTE)).toBe('failed');
      page.storage.failWrites = false;

      expect(page.raw('remote')).toBeNull();
      expect(page.logged('STORAGE_WRITE_FAILED')).toBe(true);
      expect(page.sink.lines.find((line) => line.message.startsWith('STORAGE_WRITE_FAILED'))?.message).toBe(
        'STORAGE_WRITE_FAILED: Could not write the remote store; the change is not stored',
      );
    });
  });

  describe('access', () => {
    it('reads and writes nothing in the memory-only mode, and keeps the changes for later', () => {
      const page = openPage(new MemoryStorage(), new TestClock(), { access: 'none' });
      plant(page.storage, 'person', '{"v":1,"user_id":"stored","super_properties":{}}');
      page.storage.failAccess = true;

      page.stores.person.register('plan', 'pro');
      page.stores.device.countDropped('corrupt');
      page.stores.persist();

      expect(page.stores.person.state.userId).toBeNull();
      expect(page.stores.person.state.superProperties.get('plan')).toBe('pro');
      expect(page.sink.lines).toEqual([]);

      page.storage.failAccess = false;
      page.stores.accessLevel = 'full';
      expect(page.stores.accessLevel).toBe('full');
      page.stores.persist();
      expect(page.stored('person')).toEqual({ v: 1, user_id: 'stored', super_properties: { plan: 'pro' } });
    });
  });
});
