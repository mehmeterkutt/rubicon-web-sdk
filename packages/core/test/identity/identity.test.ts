import { MemoryCookieJar, MemoryCookieStore, MemoryStorage, TestClock } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { encodeIdentityCookie, IDENTITY_MATRIX, isDeviceId, MAX_EVENT_BYTES } from '../../src';
import type { IdentifyDecision, IdentityMatrixRow } from '../../src';
import { plant } from '../storage/store-test-support';
import { COOKIE_NAME, openIdentityPage } from './identity-test-support';
import type { IdentityPage, IdentityPageOptions } from './identity-test-support';

const A = '0191d0c2-1a2b-7c3d-9e4f-5a6b7c8d9e0f';
const B = '0191d0c2-1a2b-7c3d-9e4f-000000000001';
const EPOCH = '0123456789abcdef';
const COOKIE_A = `1.${A}.${EPOCH}.`;

/** A browser profile: one cookie store on a clock, the page on `https://a.rubicon.test/`. */
function browser(page: { readonly host?: string; readonly secure?: boolean } = {}): MemoryCookieJar {
  return new MemoryCookieJar(new MemoryCookieStore(new TestClock()), page);
}

/** A page of a new browser profile. */
function newPage(options: IdentityPageOptions = {}): IdentityPage {
  return openIdentityPage(browser(), options);
}

/** A second tab of `first`'s origin: the same cookies and storage, its own memory. */
function secondTab(first: IdentityPage, options: IdentityPageOptions = {}): IdentityPage {
  return openIdentityPage(first.cookies.jar.otherPage(), { storage: first.storage.otherPage(), seed: 2, ...options });
}

function deviceRecord(deviceId: string): string {
  return JSON.stringify({ v: 1, device_id: deviceId });
}

function sent(decision: IdentifyDecision | undefined): Extract<IdentifyDecision, { kind: 'send' }> {
  if (decision?.kind !== 'send') throw new Error('expected an identify event');
  return decision;
}

describe('Identity', () => {
  describe('the read matrix (Web Identity 1)', () => {
    type Cell = 'cookie A' | 'missing' | 'unreadable';
    type MirrorCell = 'A' | 'B' | 'missing' | 'unreadable';
    interface Row {
      readonly row: IdentityMatrixRow;
      readonly cookie: Cell;
      readonly mirror: MirrorCell;
      readonly result: 'A' | 'new' | 'temporary';
    }
    const rows: readonly Row[] = [
      { row: 'id/same', cookie: 'cookie A', mirror: 'A', result: 'A' },
      { row: 'id/different', cookie: 'cookie A', mirror: 'B', result: 'A' },
      { row: 'id/missing', cookie: 'cookie A', mirror: 'missing', result: 'A' },
      { row: 'id/unreadable', cookie: 'cookie A', mirror: 'unreadable', result: 'A' },
      { row: 'missing/id', cookie: 'missing', mirror: 'A', result: 'A' },
      { row: 'missing/missing', cookie: 'missing', mirror: 'missing', result: 'new' },
      { row: 'missing/unreadable', cookie: 'missing', mirror: 'unreadable', result: 'temporary' },
      { row: 'unreadable/id', cookie: 'unreadable', mirror: 'A', result: 'A' },
      { row: 'unreadable/missing', cookie: 'unreadable', mirror: 'missing', result: 'temporary' },
      { row: 'unreadable/unreadable', cookie: 'unreadable', mirror: 'unreadable', result: 'temporary' },
    ];

    function setUp(row: Row): IdentityPage {
      const page = newPage();
      if (row.cookie === 'cookie A') page.cookies.plant(COOKIE_A);
      if (row.cookie === 'unreadable') page.cookies.plant('garbage');
      if (row.mirror === 'A') plant(page.storage, 'device', deviceRecord(A));
      if (row.mirror === 'B') plant(page.storage, 'device', deviceRecord(B));
      if (row.mirror === 'unreadable') plant(page.storage, 'device', deviceRecord('not-a-uuid'));
      page.cookies.writes = [];
      return page;
    }

    it('covers every row of the page exactly once', () => {
      expect(rows.map((row) => row.row).sort()).toEqual(Object.keys(IDENTITY_MATRIX).sort());
    });

    it.each(rows)('$row: $cookie and $mirror give $result', (row) => {
      const page = setUp(row);
      const cookieBefore = page.cookies.raw();
      const deviceBefore = page.raw('device');
      const outcome = IDENTITY_MATRIX[row.row];

      const deviceId = page.identity.deviceId;

      if (row.result === 'A') expect(deviceId).toBe(A);
      else expect(isDeviceId(deviceId) && deviceId !== A && deviceId !== B).toBe(true);
      expect(outcome.use).toBe(
        row.result === 'new'
          ? 'new'
          : row.result === 'temporary'
            ? 'temporary'
            : row.cookie === 'cookie A'
              ? 'cookie'
              : 'mirror',
      );
      // The cookie: written with the id used, or left exactly as it was.
      expect(page.cookies.writes).toHaveLength(outcome.writeCookie ? 1 : 0);
      if (outcome.writeCookie) expect(page.cookies.value()?.deviceId).toBe(deviceId);
      else expect(page.cookies.raw()).toBe(cookieBefore);
      // The mirror: rewritten with the id used, or left exactly as it was.
      if (outcome.writeMirror) expect(page.stored('device')?.['device_id']).toBe(deviceId);
      else expect(page.raw('device')).toBe(deviceBefore);
      // Nothing readable: a temporary id and a WARN, and the same id for the rest of the page.
      if (row.result === 'temporary') {
        expect(page.logged('STORE_UNREADABLE')).toBe(true);
        expect(page.identity.deviceId).toBe(deviceId);
      }
      if (row.cookie === 'unreadable' || row.mirror === 'unreadable')
        expect(page.logged('STORE_UNREADABLE')).toBe(true);
      else expect(page.sink.lines.filter((line) => line.level !== 'debug')).toEqual([]);
    });

    it('a cookie whose access throws is unreadable', () => {
      const page = newPage();
      plant(page.storage, 'device', deviceRecord(A));
      page.cookies.jar.failAccess = true;

      expect(page.identity.deviceId).toBe(A);
      expect(page.logged('STORE_UNREADABLE')).toBe(true);
      expect(page.raw('device')).toBe(deviceRecord(A));
    });

    it('a mirror whose access throws is unreadable', () => {
      const page = newPage();
      page.cookies.plant(COOKIE_A);
      page.storage.failAccess = true;

      expect(page.identity.deviceId).toBe(A);
      expect(page.logged('STORE_UNREADABLE')).toBe(true);
    });

    it('a mirror that is not a JSON record is unreadable and never overwritten', () => {
      const page = newPage();
      plant(page.storage, 'device', '{"v":2,"device_id":"x"}');

      const deviceId = page.identity.deviceId;
      page.identity.identify('user-42', {});

      expect(isDeviceId(deviceId)).toBe(true);
      expect(page.raw('device')).toBe('{"v":2,"device_id":"x"}');
      expect(page.cookies.raw()).toBeUndefined();
    });

    it('a cookie of a newer grammar is unreadable and never overwritten, also by identify and reset', () => {
      const page = newPage();
      page.cookies.plant(`2.${A}.${EPOCH}.`);
      plant(page.storage, 'device', deviceRecord(A));

      page.identity.identify('user-42', {});
      page.identity.reset();

      expect(page.identity.deviceId).toBe(A);
      expect(page.cookies.raw()).toBe(`2.${A}.${EPOCH}.`);
    });

    it('nothing readable at all gives a temporary id for the page and never throws', () => {
      const page = newPage();
      page.cookies.jar.failAccess = true;
      page.storage.failAccess = true;

      const first = page.identity.snapshot();
      page.identity.identify('user-42', { plan: 'pro' });
      page.identity.register('theme', 'dark');
      page.identity.reset();
      page.identity.clearLocalData();
      page.identity.unregister('theme');

      expect(isDeviceId(first.deviceId)).toBe(true);
      expect(isDeviceId(page.identity.deviceId)).toBe(true);
      expect(page.logged('STORE_UNREADABLE')).toBe(true);
    });

    it('the cookie wins over another id in .person: a stale record is deleted with its super properties', () => {
      const page = newPage();
      page.cookies.plant(COOKIE_A);
      plant(
        page.storage,
        'person',
        JSON.stringify({ v: 1, user_id: 'old', super_properties: { plan: 'pro' }, device_id: B }),
      );

      const snapshot = page.identity.snapshot();

      expect(snapshot.userId).toBeNull();
      expect(snapshot.superProperties).toEqual({});
      expect(page.raw('person')).toBeNull();
    });

    it('a cookie rebuilt from the mirror takes the user id and epoch of the .person of that device', () => {
      const page = newPage();
      plant(page.storage, 'device', deviceRecord(A));
      plant(
        page.storage,
        'person',
        JSON.stringify({
          v: 1,
          user_id: 'user-42',
          super_properties: { plan: 'pro' },
          device_id: A,
          person_epoch: EPOCH,
        }),
      );

      const snapshot = page.identity.snapshot();

      expect(snapshot).toEqual({
        deviceId: A,
        userId: 'user-42',
        personEpoch: EPOCH,
        superProperties: { plan: 'pro' },
      });
      expect(page.cookies.value()).toEqual({ deviceId: A, userId: 'user-42', personEpoch: EPOCH });
    });

    it('a .person of another epoch is stale; one without an epoch, from an older writer, is kept and stamped', () => {
      const stale = newPage();
      stale.cookies.plant(COOKIE_A);
      plant(
        stale.storage,
        'person',
        JSON.stringify({
          v: 1,
          user_id: null,
          super_properties: { plan: 'pro' },
          device_id: A,
          person_epoch: 'ffffffffffffffff',
        }),
      );
      expect(stale.identity.snapshot().superProperties).toEqual({});
      expect(stale.raw('person')).toBeNull();

      const older = newPage();
      older.cookies.plant(COOKIE_A);
      plant(
        older.storage,
        'person',
        JSON.stringify({ v: 1, user_id: null, super_properties: { plan: 'pro' }, device_id: A }),
      );
      expect(older.identity.snapshot().superProperties).toEqual({ plan: 'pro' });
      older.identity.register('theme', 'dark');
      older.stores.persist();
      expect(older.stored('person')).toMatchObject({ device_id: A, person_epoch: EPOCH });
    });

    it('a cookie rebuilt from the mirror of an older .person without an epoch takes a new one', () => {
      const page = newPage();
      plant(page.storage, 'device', deviceRecord(A));
      plant(page.storage, 'person', JSON.stringify({ v: 1, user_id: 'user-42', super_properties: {}, device_id: A }));

      const snapshot = page.identity.snapshot();

      expect(snapshot).toMatchObject({ deviceId: A, userId: 'user-42' });
      expect(snapshot.personEpoch).toMatch(/^[0-9a-f]{16}$/);
      expect(page.cookies.value()).toEqual({ deviceId: A, userId: 'user-42', personEpoch: snapshot.personEpoch });
    });
    it('an identity that disappears while the page lives, such as after clearing site data, is not brought back', () => {
      const page = newPage();
      page.identity.identify('user-42', {});
      const before = page.identity.snapshot();

      page.cookies.jar.write({
        name: COOKIE_NAME,
        value: '',
        path: '/',
        maxAgeSeconds: 0,
        sameSite: 'Lax',
        secure: true,
      });
      page.storage.area.entries.clear();

      const after = page.identity.snapshot();
      expect(after.deviceId).not.toBe(before.deviceId);
      expect(after.userId).toBeNull();
      expect(page.cookies.value()?.deviceId).toBe(after.deviceId);
    });

    it('with an unreadable cookie, identify and reset in one tab reach another through .person', () => {
      const a = newPage();
      a.cookies.plant('garbage');
      plant(a.storage, 'device', deviceRecord(A));
      const b = secondTab(a);

      a.identity.identify('user-42', {});
      expect(b.identity.snapshot()).toMatchObject({ deviceId: A, userId: 'user-42' });
      a.identity.reset();
      expect(b.identity.snapshot()).toMatchObject({ deviceId: A, userId: null });
      expect(a.cookies.raw()).toBe('garbage');
    });
  });

  describe('writes that do not stick (Web Identity 1)', () => {
    it('blocked cookies keep the id read, log once and are not written again for the same value', () => {
      const page = newPage();
      page.cookies.jar.blockWrites = true;

      const first = page.identity.deviceId;
      const second = page.identity.deviceId;
      const third = page.identity.deviceId;

      expect(second).toBe(first);
      expect(third).toBe(first);
      expect(page.stored('device')?.['device_id']).toBe(first);
      expect(page.cookies.writes).toHaveLength(1);
      expect(page.sink.lines.filter((line) => line.message.startsWith('STORAGE_WRITE_FAILED:'))).toHaveLength(1);
    });

    it('a cookie write that throws is a write that did not stick, never an exception', () => {
      const page = newPage();
      plant(page.storage, 'device', deviceRecord(A));
      page.cookies.jar.failAccess = true;

      expect(() => page.identity.identify('user-42', {})).not.toThrow();
      expect(page.identity.snapshot().userId).toBe('user-42');
    });

    it('when neither store can be written the id is this page load only', () => {
      const page = newPage();
      page.cookies.jar.blockWrites = true;
      page.storage.failWrites = true;

      const deviceId = page.identity.deviceId;

      expect(page.identity.deviceId).toBe(deviceId);
      expect(page.storage.area.entries.size).toBe(0);
      expect(newPage({ storage: page.storage.otherPage(), seed: 2 }).identity.deviceId).not.toBe(deviceId);
      expect(page.logged('STORAGE_WRITE_FAILED')).toBe(true);
    });
  });

  describe('two pages at once (Web Identity 3)', () => {
    it('a page that reads again before generating takes the id another page wrote meanwhile', () => {
      const a = newPage();
      const b = secondTab(a);
      let fromB = '';
      a.cookies.beforeRead = { at: 2, run: () => (fromB = b.identity.deviceId) };

      const fromA = a.identity.deviceId;

      expect(fromA).toBe(fromB);
      expect(a.generated()).toBe(0);
    });

    it('two pages that generate at the same moment end with one id in both stores and both pages', () => {
      const a = newPage();
      const b = secondTab(a);
      let fromB = '';
      a.hooks.onGenerate = () => (fromB = b.identity.deviceId);

      const fromA = a.identity.deviceId;

      // The losing page's first call carried its own id, which Web Identity 3 accepts.
      expect(fromB).not.toBe(fromA);
      expect(b.identity.deviceId).toBe(fromA);
      expect(a.identity.deviceId).toBe(fromA);
      expect(a.cookies.value()?.deviceId).toBe(fromA);
      expect(a.stored('device')?.['device_id']).toBe(fromA);
    });

    it('a cookie another page wrote between this page write and its read-back is adopted', () => {
      const a = newPage();
      const other = encodeIdentityCookie({ deviceId: B, userId: null, personEpoch: EPOCH });
      a.cookies.afterWrite = () => {
        a.cookies.plant(other);
        plant(a.storage, 'device', deviceRecord(B));
      };

      expect(a.identity.deviceId).toBe(B);
      expect(a.identity.snapshot().personEpoch).toBe(EPOCH);
    });

    it('interleaved writes in a hundred random orders never leave two ids behind', () => {
      for (let seed = 1; seed <= 100; seed += 1) {
        const a = newPage({ seed });
        const b = secondTab(a, { seed: seed + 1000 });
        const hook = (): void => {
          b.identity.snapshot();
        };
        if (seed % 4 === 0) a.hooks.onGenerate = hook;
        if (seed % 4 === 1) a.cookies.beforeWrite = hook;
        if (seed % 4 === 2) a.cookies.afterWrite = hook;
        if (seed % 4 === 3) a.cookies.beforeRead = { at: 2, run: hook };

        a.identity.snapshot();

        const ids = new Set([a.identity.deviceId, b.identity.deviceId, a.cookies.value()?.deviceId]);
        ids.add(a.stored('device')?.['device_id'] as string);
        expect(ids.size, `seed ${String(seed)}`).toBe(1);
      }
    });

    it('identify in one tab is carried by the next call of another', () => {
      const a = newPage();
      const b = secondTab(a);
      b.identity.snapshot();

      a.identity.identify('user-42', {});

      expect(b.identity.snapshot()).toMatchObject({ userId: 'user-42', deviceId: a.identity.deviceId });
    });

    it('reset in one tab gives another tab the anonymous person and the new epoch at its next call', () => {
      const a = newPage();
      const b = secondTab(a);
      a.identity.identify('user-42', {});
      a.identity.register('plan', 'pro');
      a.stores.persist();
      expect(b.identity.snapshot().superProperties).toEqual({ plan: 'pro' });

      a.identity.reset();

      const seen = b.identity.snapshot();
      expect(seen.userId).toBeNull();
      expect(seen.superProperties).toEqual({});
      expect(seen.personEpoch).toBe(a.identity.snapshot().personEpoch);
    });

    it('two identify calls at the same moment end with the last writer', () => {
      const a = newPage();
      const b = secondTab(a);
      a.identity.snapshot();
      a.cookies.afterWrite = () => void b.identity.identify('bob', {});

      a.identity.identify('alice', {});

      expect(a.identity.snapshot().userId).toBe('bob');
      expect(b.identity.snapshot().userId).toBe('bob');
    });
  });

  describe('subdomains (Web Identity 2)', () => {
    it('the ids cross subdomains in the cookie while super properties stay per host', () => {
      const jar = browser({ host: 'a.rubicon.test' });
      const a = openIdentityPage(jar, { domain: 'rubicon.test' });
      const b = openIdentityPage(jar.otherPage({ host: 'b.rubicon.test' }), {
        storage: new MemoryStorage(),
        domain: 'rubicon.test',
      });

      a.identity.identify('user-42', {});
      a.identity.register('plan', 'pro');
      a.stores.persist();

      expect(b.identity.snapshot()).toEqual({
        deviceId: a.identity.deviceId,
        userId: 'user-42',
        personEpoch: a.identity.snapshot().personEpoch,
        superProperties: {},
      });
      expect(a.cookies.writes.every((cookie) => cookie.domain === 'rubicon.test')).toBe(true);
    });

    describe("a change of person on another subdomain (section 15, step 6.1, the user's answer)", () => {
      function site(): { readonly www: IdentityPage; readonly shop: IdentityPage } {
        const jar = browser({ host: 'www.rubicon.test' });
        const www = openIdentityPage(jar, { domain: 'rubicon.test' });
        const shop = openIdentityPage(jar.otherPage({ host: 'shop.rubicon.test' }), {
          storage: new MemoryStorage(),
          domain: 'rubicon.test',
          seed: 2,
        });
        return { www, shop };
      }

      it('another user identified on shop makes the .person of www stale', () => {
        const { www, shop } = site();
        www.identity.identify('alice', {});
        www.identity.register('plan', 'pro');
        www.stores.persist();

        shop.identity.identify('bob', {});

        expect(www.identity.snapshot()).toMatchObject({ userId: 'bob', superProperties: {} });
        expect(www.raw('person')).toBeNull();
      });

      it('reset and a login as the same user on shop make the .person of www stale', () => {
        const { www, shop } = site();
        www.identity.identify('alice', {});
        www.identity.register('plan', 'pro');
        www.stores.persist();

        shop.identity.reset();
        shop.identity.identify('alice', {});

        expect(www.identity.snapshot()).toMatchObject({ userId: 'alice', superProperties: {} });
        expect(www.raw('person')).toBeNull();
      });

      it('anonymous to identified on shop keeps the .person of www and its super properties', () => {
        const { www, shop } = site();
        www.identity.register('plan', 'pro');
        www.stores.persist();

        shop.identity.identify('alice', {});

        expect(www.identity.snapshot()).toMatchObject({ userId: 'alice', superProperties: { plan: 'pro' } });
        expect(www.stored('person')).toMatchObject({
          device_id: www.identity.deviceId,
          super_properties: { plan: 'pro' },
        });
      });
    });

    it('a host-only cookie is not seen on another subdomain', () => {
      const jar = browser({ host: 'a.rubicon.test' });
      const a = openIdentityPage(jar);
      const b = openIdentityPage(jar.otherPage({ host: 'b.rubicon.test' }), { storage: new MemoryStorage(), seed: 2 });

      expect(b.identity.deviceId).not.toBe(a.identity.deviceId);
    });

    it('the cookie has the decided attributes', () => {
      const page = openIdentityPage(browser(), { domain: 'rubicon.test' });
      page.identity.snapshot();

      expect(page.cookies.writes[0]).toMatchObject({
        name: COOKIE_NAME,
        domain: 'rubicon.test',
        path: '/',
        maxAgeSeconds: 365 * 24 * 60 * 60,
        sameSite: 'Lax',
        secure: true,
      });
      expect(openIdentityPage(browser({ secure: false })).identity.deviceId).toMatch(/-/);
    });

    it('an http page writes the cookie without Secure', () => {
      const page = openIdentityPage(browser({ secure: false }));
      page.identity.snapshot();

      expect(page.cookies.writes[0]?.secure).toBe(false);
      expect(page.cookies.value()?.deviceId).toBe(page.identity.deviceId);
    });
  });

  describe('when the cookie is written (Web Session 5)', () => {
    it('only on the first visit, identify, reset and clearLocalData', () => {
      const page = newPage();
      const writes = (): number => page.cookies.writes.length;

      page.identity.snapshot();
      expect(writes()).toBe(1);
      page.identity.snapshot();
      page.identity.register('a', 1);
      page.identity.unregister('a');
      page.stores.persist();
      page.identity.snapshot();
      expect(writes()).toBe(1);
      page.identity.identify('user-42', {});
      expect(writes()).toBe(2);
      page.identity.identify('user-42', {});
      page.identity.identify('user-42', { plan: 'pro' });
      expect(writes()).toBe(2);
      page.identity.reset();
      expect(writes()).toBe(3);
      page.identity.clearLocalData();
      expect(writes()).toBe(4);
      page.identity.snapshot();
      expect(writes()).toBe(4);
    });

    it('reads the cookie on every call and parses it only when the text changed', () => {
      const page = newPage();
      page.identity.snapshot();
      const before = page.cookies.reads;

      page.identity.snapshot();
      page.identity.snapshot();

      expect(page.cookies.reads).toBe(before + 2);
    });
  });

  describe('identify rules (Identity 3 and 4)', () => {
    it('anonymous: the id is set and an identify event is sent', () => {
      const page = newPage();

      const event = sent(page.identity.identify('user-42', { plan: 'pro' }));

      expect(event.traits).toEqual({ plan: 'pro' });
      expect(event.traitsOversize).toBe(false);
      expect(event.identity).toMatchObject({ userId: 'user-42', deviceId: page.identity.deviceId });
      expect(page.cookies.value()?.userId).toBe('user-42');
      expect(page.stored('person')?.['user_id']).toBe('user-42');
    });

    it('anonymous to identified keeps the epoch, the session and the super properties', () => {
      const page = newPage();
      page.identity.register('plan', 'pro');
      const before = page.identity.snapshot();

      page.identity.identify('user-42', {});

      const after = page.identity.snapshot();
      expect(after.personEpoch).toBe(before.personEpoch);
      expect(after.superProperties).toEqual({ plan: 'pro' });
      expect(page.cleared).toEqual([]);
    });

    it('anonymous without traits still sends the identify event', () => {
      expect(sent(newPage().identity.identify('user-42', undefined)).traits).toEqual({});
    });

    it('the same id with traits sends an identify event', () => {
      const page = newPage();
      page.identity.identify('user-42', {});

      expect(sent(page.identity.identify('user-42', { plan: 'free' })).traits).toEqual({ plan: 'free' });
    });

    it('the same id without traits does nothing', () => {
      const page = newPage();
      page.identity.identify('user-42', {});
      page.identity.register('plan', 'pro');

      expect(page.identity.identify('user-42', {})).toEqual({ kind: 'none' });
      expect(page.identity.snapshot().superProperties).toEqual({ plan: 'pro' });
      expect(page.cleared).toEqual([]);
    });

    it("a different id clears the person's state first, logs INFO without ids and sends", () => {
      const page = newPage();
      page.identity.identify('user-42', {});
      page.identity.register('plan', 'pro');
      const before = page.identity.snapshot();

      const event = sent(page.identity.identify('user-77', {}));

      expect(event.identity).toMatchObject({ userId: 'user-77', deviceId: before.deviceId, superProperties: {} });
      expect(event.identity.personEpoch).not.toBe(before.personEpoch);
      expect(page.cleared).toEqual([before]);
      expect(page.stored('person')).toMatchObject({ user_id: 'user-77', super_properties: {} });
      const info = page.sink.lines.filter((line) => line.level === 'info');
      expect(info).toHaveLength(1);
      expect(info[0]?.message).not.toMatch(/user-42|user-77/);
    });

    it('while opted out the id changes but no event is sent', () => {
      const page = newPage();
      page.hooks.eventsAllowed = false;

      expect(page.identity.identify('user-42', { plan: 'pro' })).toEqual({ kind: 'none' });
      expect(page.identity.snapshot().userId).toBe('user-42');
    });

    it('traits are normalized and never stored', () => {
      const page = newPage();

      const event = sent(page.identity.identify('user-42', { trait_plan: 'trait-value', at: Symbol('x') }));
      page.stores.persist();

      expect(event.traits).toEqual({ trait_plan: 'trait-value' });
      expect(page.logged('PROPERTY_DROPPED')).toBe(true);
      expect(page.raw('person')).not.toMatch(/trait/);
      expect(page.raw('device')).not.toMatch(/trait/);
      expect(page.cookies.raw()).not.toMatch(/trait/);
    });

    it('the traits of an identify event are a copy, flagged when over the size limit', () => {
      const page = newPage();
      const traits = { tags: ['a'] };

      const event = sent(page.identity.identify('user-42', traits));
      traits.tags.push('b');
      const big = sent(page.identity.identify('user-42', { list: Array.from({ length: 40 }, () => 'x'.repeat(1024)) }));

      expect(event.traits).toEqual({ tags: ['a'] });
      expect(big.traitsOversize).toBe(true);
    });

    it('identify then a snapshot carries the new id', () => {
      const page = newPage();

      page.identity.identify('user-42', {});

      expect(page.identity.snapshot().userId).toBe('user-42');
    });

    it('a lone surrogate in the user id becomes U+FFFD and the length does not change', () => {
      const page = newPage();

      page.identity.identify('a\udc00b', {});

      expect(page.identity.snapshot().userId).toBe('a�b');
    });
  });

  describe('invalid user ids (Identity 3, Web Public API 4)', () => {
    const invalid: readonly unknown[] = ['', '   ', '\t\n', 'x'.repeat(256), '😀'.repeat(128), 42, null, undefined];

    it('are ignored with INVALID_USER_ID and never the id in the line', () => {
      const page = newPage();

      for (const userId of invalid) expect(page.identity.identify(userId, {})).toBeUndefined();

      expect(page.identity.snapshot().userId).toBeNull();
      expect(page.logged('INVALID_USER_ID')).toBe(true);
      expect(page.sink.lines.map((line) => line.message).join('\n')).not.toMatch(/xxxxxxxxxx|😀/);
      expect(page.cookies.writes).toHaveLength(1);
    });

    it('with debug the line is the developer-error form and nothing throws', () => {
      const page = newPage({ debug: true });

      expect(() => page.identity.identify(' ', {})).not.toThrow();

      expect(page.sink.lines).toContainEqual({
        level: 'error',
        message: 'INVALID_USER_ID: identify was called with a user id that is blank; the call is ignored',
        developerErrorForm: true,
      });
    });

    it('without debug the line is a WARN', () => {
      const page = newPage({ debug: false });

      page.identity.identify('x'.repeat(256), {});

      expect(page.sink.lines).toContainEqual({
        level: 'warn',
        message:
          'INVALID_USER_ID: identify was called with a user id that is longer than 255 characters; the call is ignored',
        developerErrorForm: false,
      });
    });

    it('logging level off silences it, with or without debug', () => {
      for (const debug of [true, false]) {
        const page = newPage({ debug, level: 'off' });

        page.identity.identify(42, {});

        expect(page.sink.lines).toEqual([]);
      }
    });

    it('255 code units are fine and ids are never trimmed', () => {
      const page = newPage();

      page.identity.identify('x'.repeat(255), {});
      expect(page.identity.snapshot().userId).toHaveLength(255);
      page.identity.identify(' user-42 ', {});
      expect(page.identity.snapshot().userId).toBe(' user-42 ');
    });
  });

  describe('reset (Identity 5)', () => {
    it('clears the user and all super properties, keeps the device id, renews the epoch and sends nothing', () => {
      const page = newPage();
      page.identity.identify('user-42', {});
      page.identity.register('theme', 'dark');
      const before = page.identity.snapshot();

      page.identity.reset();

      const after = page.identity.snapshot();
      expect(after.userId).toBeNull();
      expect(after.superProperties).toEqual({});
      expect(after.deviceId).toBe(before.deviceId);
      expect(after.personEpoch).not.toBe(before.personEpoch);
      expect(page.generated()).toBe(1);
      expect(page.cookies.value()).toEqual({ deviceId: before.deviceId, userId: null, personEpoch: after.personEpoch });
      expect(page.stored('person')).toEqual({
        v: 1,
        user_id: null,
        super_properties: {},
        device_id: before.deviceId,
        person_epoch: after.personEpoch,
      });
      expect(page.cleared).toEqual([before]);
    });

    it('an anonymous reset also renews the epoch, so the open session ends (Web Session 5)', () => {
      const page = newPage();
      const before = page.identity.snapshot();

      page.identity.reset();

      expect(page.identity.snapshot().personEpoch).not.toBe(before.personEpoch);
      expect(page.cleared).toHaveLength(1);
    });
  });

  describe('super properties (Event Model 1, Web Identity 2)', () => {
    it('a null super property is stored and sent as null', () => {
      const page = newPage();

      expect(page.identity.register('coupon', null)).toBe(true);
      page.stores.persist();

      expect(page.identity.snapshot().superProperties).toEqual({ coupon: null });
      expect(page.raw('person')).toContain('"coupon":null');
    });

    it('are validated at register', () => {
      const page = newPage();

      expect(page.identity.register('at', Symbol('x'))).toBe(false);
      expect(page.identity.register('', 'x')).toBe(false);
      expect(page.identity.register(42, 'x')).toBe(false);
      expect(page.identity.register('nothing', undefined)).toBe(false);
      expect(page.identity.register('long', 'y'.repeat(2_000))).toBe(true);

      const superProperties = page.identity.snapshot().superProperties;
      expect(Object.keys(superProperties)).toEqual(['long']);
      expect(superProperties['long']).toHaveLength(1024);
      expect(page.logged('PROPERTY_DROPPED')).toBe(true);
    });

    it('a value over the size limit is stored as the normalizer cut it (section 15, step 2.5)', () => {
      const page = newPage();

      expect(
        page.identity.register(
          'list',
          Array.from({ length: 40 }, () => 'x'.repeat(1024)),
        ),
      ).toBe(true);

      const stored = page.identity.snapshot().superProperties['list'] as string[];
      expect(stored.length).toBeLessThan(40);
      expect(JSON.stringify(stored).length).toBeGreaterThan(MAX_EVENT_BYTES);
    });

    it('unregister removes a key; a key that is not a string names none', () => {
      const page = newPage();
      page.identity.register('a', 1);
      page.identity.register('b', 2);

      page.identity.unregister('a');
      page.identity.unregister('missing');
      page.identity.unregister(42);

      expect(page.identity.snapshot().superProperties).toEqual({ b: 2 });
    });

    it('a lone surrogate in the key is replaced at register and unregister alike', () => {
      const page = newPage();
      page.identity.register('k\ud800', 1);

      expect(page.identity.snapshot().superProperties).toEqual({ 'k�': 1 });
      page.identity.unregister('k\ud800');
      expect(page.identity.snapshot().superProperties).toEqual({});
    });

    it('register and unregister ask the writer to persist and stamp .person with its device id and epoch', () => {
      const page = newPage();

      page.identity.register('a', 1);
      page.identity.unregister('b');
      page.stores.persist();

      expect(page.persistRequests()).toBe(2);
      expect(page.stored('person')).toEqual({
        v: 1,
        user_id: null,
        super_properties: { a: 1 },
        device_id: page.identity.deviceId,
        person_epoch: page.identity.snapshot().personEpoch,
      });
    });

    it('the snapshot is a deep copy, __proto__ included as a key', () => {
      const page = newPage();
      page.identity.register('tags', ['a']);
      page.identity.register('nested', { level: { deep: 1 } });
      page.identity.register('__proto__', 'x');
      page.stores.persist();

      const first = page.identity.snapshot();
      (first.superProperties['tags'] as string[]).push('b');
      (first.superProperties['nested'] as { level: { deep: number } }).level.deep = 2;

      const second = page.identity.snapshot().superProperties;
      expect([second['tags'], second['nested']]).toEqual([['a'], { level: { deep: 1 } }]);
      expect(Object.keys(first.superProperties)).toEqual(['tags', 'nested', '__proto__']);
      expect(first.superProperties['__proto__']).toBe('x');
    });
  });

  describe('clearLocalData (Web Privacy 3)', () => {
    it('renews device id and epoch without a user, clears counters, retry state and .person, keeps the rest', () => {
      const page = newPage();
      page.identity.identify('user-42', {});
      page.identity.register('plan', 'pro');
      page.stores.persist();
      const before = page.identity.snapshot();
      plant(
        page.storage,
        'device',
        JSON.stringify({
          v: 1,
          device_id: before.deviceId,
          retry: { step: 3, rev: 2, suspects: { 'p.0': { f: 5 } } },
          diagnostics: { period_start: 1, dropped: { queue_full: 4 }, issues: { QUEUE_FULL: 1 } },
          last_logged: { QUEUE_FULL: 5 },
          future: true,
        }),
      );

      page.identity.clearLocalData();

      const after = page.identity.snapshot();
      expect(isDeviceId(after.deviceId) && after.deviceId !== before.deviceId).toBe(true);
      expect(after.personEpoch).not.toBe(before.personEpoch);
      expect(after.userId).toBeNull();
      expect(after.superProperties).toEqual({});
      expect(page.cookies.value()).toEqual({ deviceId: after.deviceId, userId: null, personEpoch: after.personEpoch });
      expect(page.stored('device')).toEqual({
        v: 1,
        device_id: after.deviceId,
        retry: { step: 0, rev: 0, suspects: {} },
        diagnostics: { dropped: {}, issues: {} },
        last_logged: { QUEUE_FULL: 5 },
        future: true,
      });
      expect(page.raw('person')).toBeNull();
      expect(page.cleared).toEqual([]);
    });

    it('another tab takes the new identity at its next call and drops its stale .person', () => {
      const a = newPage();
      const b = secondTab(a);
      b.identity.snapshot();

      a.identity.clearLocalData();

      expect(b.identity.deviceId).toBe(a.identity.deviceId);
    });

    it('overwrites an unreadable cookie, as an erasure', () => {
      const page = newPage();
      page.cookies.plant('garbage');

      page.identity.clearLocalData();

      expect(page.cookies.value()?.deviceId).toBe(page.identity.deviceId);
    });
  });

  describe('consent pending or refused, and the memory-only mode (Web Privacy 1, Web Logging 4, Web Disk 4)', () => {
    it.each(['consent', 'none'] as const)(
      'with access %s nothing is read or written and the id is temporary',
      (access) => {
        const page = newPage({ access });
        page.cookies.plant(COOKIE_A);
        page.cookies.writes = [];

        const deviceId = page.identity.deviceId;
        page.identity.identify('user-42', {});
        page.identity.register('plan', 'pro');
        page.identity.reset();
        page.stores.persist();

        expect(deviceId).not.toBe(A);
        expect(page.identity.deviceId).toBe(deviceId);
        expect(page.cookies.writes).toEqual([]);
        expect(page.cookies.reads).toBe(0);
        expect(page.storage.writeCount).toBe(0);
      },
    );

    it('identify changes the person in memory while pending', () => {
      const page = newPage({ access: 'consent' });

      sent(page.identity.identify('user-42', { plan: 'pro' }));

      expect(page.identity.snapshot().userId).toBe('user-42');
    });

    it('on access the temporary identity is written when the stores are empty', () => {
      const page = newPage({ access: 'consent' });
      const temporary = page.identity.deviceId;
      page.identity.identify('user-42', {});
      page.identity.register('plan', 'pro');

      page.stores.accessLevel = 'full';
      const snapshot = page.identity.snapshot();
      page.stores.persist();

      expect(snapshot).toMatchObject({ deviceId: temporary, userId: 'user-42', superProperties: { plan: 'pro' } });
      expect(page.cookies.value()?.deviceId).toBe(temporary);
      expect(page.stored('device')?.['device_id']).toBe(temporary);
      expect(page.stored('person')).toMatchObject({ user_id: 'user-42', device_id: temporary });
    });

    it('on access the held person changes join the stored record and are stamped with its identity', () => {
      const page = newPage({ access: 'consent' });
      page.cookies.plant(COOKIE_A);
      plant(
        page.storage,
        'person',
        JSON.stringify({ v: 1, user_id: null, super_properties: { x: 1 }, device_id: A, person_epoch: EPOCH }),
      );
      page.identity.register('plan', 'pro');

      page.stores.accessLevel = 'full';
      const snapshot = page.identity.snapshot();
      page.stores.persist();

      expect(snapshot.superProperties).toEqual({ x: 1, plan: 'pro' });
      expect(page.stored('person')).toEqual({
        v: 1,
        user_id: null,
        super_properties: { x: 1, plan: 'pro' },
        device_id: A,
        person_epoch: EPOCH,
      });
    });

    it('on access a stored identity wins over the temporary one', () => {
      const page = newPage({ access: 'consent' });
      page.cookies.plant(COOKIE_A);
      const temporary = page.identity.deviceId;

      page.stores.accessLevel = 'full';

      expect(temporary).not.toBe(A);
      expect(page.identity.deviceId).toBe(A);
    });

    it('clearLocalData while pending makes a new id that is written when access comes', () => {
      const page = newPage({ access: 'consent' });
      page.cookies.plant(COOKIE_A);
      page.identity.clearLocalData();
      const renewed = page.identity.deviceId;
      page.cookies.jar.write({
        name: COOKIE_NAME,
        value: '',
        path: '/',
        maxAgeSeconds: 0,
        sameSite: 'Lax',
        secure: true,
      });

      page.stores.accessLevel = 'full';

      expect(page.identity.deviceId).toBe(renewed);
      expect(page.cookies.value()?.deviceId).toBe(renewed);
    });

    it('clearLocalData without access makes a new temporary id and drops the held person changes', () => {
      const page = newPage({ access: 'consent' });
      const before = page.identity.deviceId;
      page.identity.register('plan', 'pro');

      page.identity.clearLocalData();

      expect(page.identity.deviceId).not.toBe(before);
      expect(page.identity.snapshot().superProperties).toEqual({});
      expect(page.cookies.writes).toEqual([]);
    });
  });
});
