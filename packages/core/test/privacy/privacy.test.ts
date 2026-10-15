import { responseOutcome, TestPlatform } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { chunkKey, markerKey, storeKey } from '../../src';
import {
  consentConfig,
  CONSENT_COOKIE,
  IDENTITY_COOKIE,
  KEY_HASH,
  otherPage,
  PrivacyPage,
  SESSION_COOKIE,
} from './privacy-test-support';

// The port of the Android PrivacyTest (Privacy 1 to 4, Android log 6.5) for Web Privacy 1 to 3 and
// Web Logging 4, with the refused state of the contract of 2026-10-14 and the user's answers of
// 2026-10-15 (plan section 15, step 6.5). Not ported: "isOptedOut before the writer has loaded reads
// device json once" and "calls before the stored choice is known apply in order once it is" (every
// call reads the decision from storage on the web; there is no load step). Inverted by the contract
// of 2026-10-14: "events queued before still go" (they wait for `optIn()`) and "only pending closes
// the upload gate" (only granted opens it); "identify, register and reset still update local state"
// holds for this page's memory only, and "events are written but not sent" while pending is memory
// only (Web Privacy 1).

const DAY = 24 * 60 * 60 * 1000;
const OK = responseOutcome(200);

function newPage(config: Record<string, unknown> = {}, options: { readonly domain?: string } = {}): PrivacyPage {
  return new PrivacyPage(new TestPlatform(), { config, ...options });
}

/** The stored `.device` diagnostics; empty when there is none. */
function diagnostics(page: PrivacyPage): { readonly dropped?: Record<string, number> } {
  return (
    (page.record('device')?.['diagnostics'] as { dropped?: Record<string, number> } | undefined) ?? { dropped: {} }
  );
}

function names(events: readonly { readonly event?: string; readonly type: string }[]): string[] {
  return events.map((event) => event.event ?? event.type);
}

describe('Privacy', () => {
  describe('the starting state (Privacy 2, 4)', () => {
    it('granted by default collects, stores and sends, and is not opted out', () => {
      const page = newPage();

      page.track('Opened');
      page.writer.flush();
      page.run();

      expect(page.privacy.isOptedOut()).toBe(false);
      expect(page.privacy.state()).toBe('granted');
      expect(names(page.sent().flat())).toEqual(['Session Started', 'Opened']);
    });

    it('pending is opted out, meaning nothing is sent now', () => {
      const page = newPage(consentConfig('pending'));

      page.track('Waiting');
      page.writer.flush();
      page.run();

      expect(page.privacy.isOptedOut()).toBe(true);
      expect(page.privacy.state()).toBe('pending');
      expect(page.uploads).toEqual([]);
    });

    it('a stored decision beats the default', () => {
      const first = newPage(consentConfig('pending'));
      first.privacy.optIn();

      const reload = otherPage(first, { config: consentConfig('pending') });

      expect(reload.privacy.state()).toBe('granted');
      expect(reload.stores.accessLevel).toBe('full');
    });

    it('a stored opt-out survives a reload', () => {
      const first = newPage();
      first.privacy.optOut();

      const reload = otherPage(first);
      reload.track('Ignored');
      reload.run();

      expect(reload.privacy.state()).toBe('denied');
      expect(reload.privacy.isOptedOut()).toBe(true);
      expect(reload.stored()).toEqual([]);
    });

    it('without persistConsent the stored decision is neither read nor written', () => {
      const first = newPage();
      first.privacy.optOut();
      const stored = first.cookie(CONSENT_COOKIE);

      const reload = otherPage(first, { config: consentConfig('granted', false) });
      expect(reload.privacy.state()).toBe('granted');
      reload.privacy.optIn();
      reload.privacy.optOut();
      reload.privacy.optIn();

      expect(reload.cookie(CONSENT_COOKIE)).toBe(stored);
      expect(reload.record('consent')?.['state']).toBe('denied');
      expect(reload.privacy.state()).toBe('granted');
    });

    it('with no stored decision, pending continues after a reload', () => {
      const first = newPage(consentConfig('pending'));
      first.track('Waiting');
      first.run();

      const reload = otherPage(first, { config: consentConfig('pending') });

      expect(reload.privacy.state()).toBe('pending');
      expect(reload.record('consent')).toBeUndefined();
    });
  });

  describe('the consent cookie and its mirror (Web Privacy 2)', () => {
    it('a decision writes only { state, decided_at } to the cookie and the mirror, never an identifier', () => {
      const page = newPage(consentConfig('pending'));
      const decidedAt = page.test.clock.now();

      page.privacy.optOut();

      expect(page.cookie(CONSENT_COOKIE)).toBe(`1.denied.${String(decidedAt)}`);
      const cookie = page.test.cookies.store.cookies().find((stored) => stored.name === CONSENT_COOKIE);
      expect(cookie).toMatchObject({ path: '/', sameSite: 'Lax', secure: true, hostOnly: true });
      expect(cookie?.expiresAt).toBe(decidedAt + 365 * DAY);
      expect(page.record('consent')).toEqual({ v: 1, state: 'denied', decided_at: decidedAt });
      expect(page.cookieNames()).toEqual([CONSENT_COOKIE]);
      expect(page.storageKeys()).toEqual([storeKey(KEY_HASH, 'consent')]);
    });

    it('the cookie goes to the identity cookie’s domain, so another subdomain reads it', () => {
      const www = newPage({}, { domain: 'rubicon.test' });
      www.privacy.optOut();

      const shop = otherPage(www, { host: 'b.rubicon.test', domain: 'rubicon.test' });

      expect(shop.privacy.state()).toBe('denied');
      expect(shop.record('consent')).toBeUndefined();
    });

    it('the later decision wins between the cookie and the mirror', () => {
      const page = newPage(consentConfig('pending'));
      page.privacy.optIn();
      const now = page.test.clock.now();

      page.test.storage.area.entries.set(
        storeKey(KEY_HASH, 'consent'),
        JSON.stringify({ v: 1, state: 'denied', decided_at: now + 1 }),
      );
      expect(page.privacy.state()).toBe('denied');

      page.test.cookies.write({
        name: CONSENT_COOKIE,
        value: `1.granted.${String(now + 2)}`,
        path: '/',
        maxAgeSeconds: 3600,
        sameSite: 'Lax',
        secure: true,
      });
      expect(page.privacy.state()).toBe('granted');
    });

    it('an unreadable cookie leaves the mirror to answer, and a new decision overwrites it', () => {
      const page = newPage(consentConfig('pending'));
      page.privacy.optOut();
      page.test.cookies.write({
        name: CONSENT_COOKIE,
        value: '2.denied.1',
        path: '/',
        maxAgeSeconds: 3600,
        sameSite: 'Lax',
        secure: true,
      });

      expect(page.privacy.state()).toBe('denied');
      expect(page.privacy.state()).toBe('denied');
      expect(page.counted.filter((code) => code === 'STORE_UNREADABLE')).toHaveLength(2);
      const lines = page.sink.lines.filter((line) => line.message.startsWith('STORE_UNREADABLE'));
      expect(lines.filter((line) => line.level === 'warn')).toHaveLength(1);

      page.privacy.optIn();

      expect(page.cookie(CONSENT_COOKIE)).toBe(`1.granted.${String(page.test.clock.now())}`);
      expect(page.privacy.state()).toBe('granted');
    });

    it('a cookie write that does not stick leaves the decision with the mirror and the page', () => {
      const page = newPage(consentConfig('pending'));
      page.test.cookies.blockWrites = true;

      page.privacy.optOut();
      page.privacy.optIn();

      expect(page.cookie(CONSENT_COOKIE)).toBeUndefined();
      expect(page.record('consent')?.['state']).toBe('granted');
      expect(page.privacy.state()).toBe('granted');
      const lines = page.sink.lines.filter((line) => line.message.startsWith('STORAGE_WRITE_FAILED'));
      expect(lines.filter((line) => line.level === 'error' && line.message.includes('consent cookie'))).toHaveLength(1);
    });

    it('in the memory-only mode the decision is per page and nothing is written', () => {
      const page = newPage(consentConfig('pending'));
      page.stores.accessLevel = 'none';

      page.privacy.optIn();

      expect(page.privacy.state()).toBe('granted');
      expect(page.stores.accessLevel).toBe('none');
      expect(page.cookieNames()).toEqual([]);
      expect(page.storageKeys()).toEqual([]);
    });

    it('an opt-out in one tab stops new events in another at its next call', () => {
      const first = newPage();
      const second = otherPage(first);
      second.track('Before');
      second.run();

      first.privacy.optOut();
      second.track('After');
      second.run();

      expect(names(second.stored())).toEqual(['Session Started', 'Before']);
      expect(second.stores.accessLevel).toBe('consent');
    });

    it('a pending tab picks up a decision on the storage event', () => {
      const first = newPage(consentConfig('pending'));
      const second = otherPage(first, { config: consentConfig('pending') });
      second.track('Waiting');
      second.run();

      first.privacy.optIn();
      second.run();

      expect(second.stores.accessLevel).toBe('full');
      expect(names(second.sent().flat())).toEqual(['Session Started', 'Waiting']);
    });

    it('a pending tab on another subdomain picks it up when it becomes visible', () => {
      const www = newPage(consentConfig('pending'), { domain: 'rubicon.test' });
      const shop = otherPage(www, { config: consentConfig('pending'), host: 'b.rubicon.test', domain: 'rubicon.test' });
      shop.track('Waiting');
      shop.run();
      shop.test.lifecycle.hide();

      www.privacy.optOut();
      expect(shop.stores.accessLevel).toBe('consent');
      shop.test.lifecycle.show();

      expect(shop.privacy.state()).toBe('denied');
      expect(shop.chunks.walk()).toEqual([]);
    });
  });

  describe('pending consent (Web Privacy 1)', () => {
    it('a pending page’s whole flow writes nothing to the browser and requests nothing', () => {
      const page = newPage(consentConfig('pending'));

      page.track('Opened', { plan: 'pro' });
      page.identify('user-42', { tier: 'gold' });
      page.register('theme', 'dark');
      page.reset();
      page.track('Again');
      page.writer.flush();
      page.run();
      page.test.lifecycle.pagehide();
      page.test.lifecycle.hide();
      page.test.scheduler.advanceBy(10 * 60 * 1000);
      page.test.lifecycle.show();
      page.privacy.state();

      expect(page.storageKeys()).toEqual([]);
      expect(page.cookieNames()).toEqual([]);
      expect(page.test.storage.writeCount).toBe(0);
      expect(page.test.transport.requests).toEqual([]);
    });

    it('optIn adopts the temporary id, writes the waiting events and sends them', () => {
      const page = newPage(consentConfig('pending'));
      const temporary = page.deviceId;
      page.track('Waiting');
      page.run();

      page.privacy.optIn();
      page.run();

      expect(page.deviceId).toBe(temporary);
      expect(page.cookie(IDENTITY_COOKIE)?.split('.')[1]).toBe(temporary);
      const sent = page.sent().flat();
      expect(names(sent)).toEqual(['Session Started', 'Waiting']);
      expect(sent.every((event) => event.device_id === temporary)).toBe(true);
      expect(page.configRequests).toHaveLength(1);
    });

    it('optIn with a stored identity: the stored device id wins, written into the waiting events', () => {
      // The app owns consent (`persistConsent: false`), so an identity from an earlier visit exists.
      const earlier = newPage(consentConfig('granted', false));
      earlier.register('plan', 'pro');
      earlier.run();
      const stored = earlier.deviceId;
      const page = otherPage(earlier, { config: consentConfig('pending', false) });
      page.track('Anonymous');
      page.identify('user-42');
      page.register('theme', 'dark');
      page.track('Identified');
      page.run();
      expect(page.deviceId).not.toBe(stored);

      page.privacy.optIn();
      page.run();

      expect(page.deviceId).toBe(stored);
      const sent = page.sent().flat();
      expect(names(sent)).toEqual(['Session Started', 'Anonymous', 'identify', 'Identified']);
      expect(sent.map((event) => event.device_id)).toEqual([stored, stored, stored, stored]);
      expect(sent.map((event) => event.user_id)).toEqual([null, null, 'user-42', 'user-42']);
      expect(page.identity.snapshot()).toMatchObject({
        deviceId: stored,
        userId: 'user-42',
        superProperties: { plan: 'pro', theme: 'dark' },
      });
      page.run();
      expect(page.record('person')).toMatchObject({ user_id: 'user-42', device_id: stored });
    });

    it('optOut drops the waiting events without counting them and writes only the decision', () => {
      const page = newPage(consentConfig('pending'));
      page.track('Waiting');
      page.track('Waiting');
      page.run();

      page.privacy.optOut();
      page.privacy.optIn();
      page.writer.flush();
      page.run();

      expect(page.sent().flat()).toEqual([]);
      expect(page.drops.size).toBe(0);
      expect(page.dropped()).toEqual([]);
      expect(diagnostics(page).dropped).toEqual({});
    });
  });

  describe('refused consent (Web Logging 4)', () => {
    it('only the decision is written, whatever the page does', () => {
      const page = newPage();
      page.track('Before');
      page.run();
      page.privacy.optOut();
      const keys = page.storageKeys();
      const cookies = page.cookieNames();
      const records = page.test.storage.area.snapshot();

      page.track('After');
      page.identify('user-42', { tier: 'gold' });
      page.register('theme', 'dark');
      page.reset();
      page.writer.flush();
      page.run();
      page.test.lifecycle.pagehide();
      page.test.lifecycle.hide();
      page.test.scheduler.advanceBy(10 * 60 * 1000);

      expect(page.storageKeys()).toEqual(keys);
      expect(page.test.storage.area.snapshot()).toEqual(records);
      expect(page.cookieNames()).toEqual(cookies);
      expect(cookies).not.toContain(SESSION_COOKIE);
      expect(page.uploads).toEqual([]);
      expect(page.configRequests).toEqual([]);
    });

    it('the open session ends without Session Ended; optIn produces no event and the next one starts a session', () => {
      const page = newPage();
      page.track('Opened');
      page.run();
      const session = page.stored()[0]?.context?.session?.id;

      page.privacy.optOut();
      expect(page.cookie(SESSION_COOKIE)).toBeUndefined();
      page.privacy.optIn();
      page.track('Back');
      page.writer.flush();
      page.run();

      const sent = page.sent().flat();
      expect(names(sent)).toEqual(['Session Started', 'Opened', 'Session Started', 'Back']);
      expect(sent[3]?.context?.session?.id).not.toBe(session);
      expect(page.sink.lines.some((line) => line.level === 'info' && line.message.includes('opted in'))).toBe(true);
    });

    it('events accepted before the opt-out and not yet written are not stored and not counted', () => {
      const page = newPage();
      page.track('Accepted');

      page.privacy.optOut();
      page.run();

      expect(page.stored()).toEqual([]);
      expect(page.drops.size).toBe(0);
      expect(page.dropped()).toEqual([]);
    });

    it('an opt-out leaves the queue unsent and an optIn sends it', () => {
      const page = newPage();
      page.track('Queued');
      page.run();

      page.privacy.optOut();
      page.writer.flush();
      page.test.lifecycle.hide();
      page.run();
      expect(page.uploads).toEqual([]);
      expect(names(page.stored())).toEqual(['Session Started', 'Queued']);

      page.test.lifecycle.show();
      page.privacy.optIn();
      page.run();

      expect(names(page.sent().flat())).toEqual(['Session Started', 'Queued']);
      expect(page.stored()).toEqual([]);
    });

    it('a request in flight completes and its chunks leave storage, so optIn sends nothing twice', () => {
      const page = newPage();
      page.track('InFlight');
      page.answer({ outcome: OK, delayMs: 1_000 });
      page.writer.flush();
      page.run();
      expect(page.uploader.busy).toBe(true);

      page.privacy.optOut();
      page.test.scheduler.advanceBy(1_000);

      expect(page.stored()).toEqual([]);
      expect(page.updates.filter((update) => update.type === 'sent')).toHaveLength(1);
      page.privacy.optIn();
      page.writer.flush();
      page.run();
      expect(page.uploads).toHaveLength(1);
    });

    it('a rejected batch in flight is deleted and counted in memory only', () => {
      const page = newPage();
      page.track('Rejected');
      page.answer({ outcome: responseOutcome(400), delayMs: 1_000 });
      page.writer.flush();
      page.run();
      const device = page.record('device');

      page.privacy.optOut();
      page.test.scheduler.advanceBy(1_000);

      expect(page.stored()).toEqual([]);
      expect(page.drops.get('rejected')).toBe(2);
      expect(page.record('device')).toEqual(device);
    });

    it('a failure in flight keeps the chunks and its retry state stays in memory until optIn', () => {
      const page = newPage();
      page.track('Failing');
      page.answer({ outcome: responseOutcome(503), delayMs: 1_000 });
      page.writer.flush();
      page.run();
      const device = page.record('device');

      page.privacy.optOut();
      page.test.scheduler.advanceBy(1_000);

      expect(names(page.stored())).toEqual(['Session Started', 'Failing']);
      expect(page.record('device')).toEqual(device);
      expect(page.stores.device.state.retry.step).toBe(1);
      page.privacy.optIn();
      page.run();
      expect((page.record('device')?.['retry'] as { step?: number } | undefined)?.step).toBe(1);
    });

    it('the stored queue keeps the 3-day rule: at start and at an upload trigger, counted in memory', () => {
      const first = newPage();
      first.track('Old');
      first.run();
      first.privacy.optOut();
      first.test.clock.advanceBy(3 * DAY + 1);

      const reload = otherPage(first);
      expect(reload.stored()).toEqual([]);
      expect(reload.drops.get('expired')).toBe(2);

      first.test.clock.advanceBy(-3 * DAY - 1);
      first.privacy.optIn();
      first.track('Later');
      first.run();
      first.privacy.optOut();
      first.test.clock.advanceBy(3 * DAY + 1);
      reload.writer.flush();
      reload.run();

      expect(reload.stored()).toEqual([]);
      expect(reload.drops.get('expired')).toBe(4);
      expect(diagnostics(reload).dropped).toEqual({});
    });

    it('makes no remote configuration request; optIn makes one', () => {
      const page = newPage(consentConfig('pending'));
      page.privacy.optOut();
      page.remote.fetchIfDue(page.privacy.state());
      page.run();
      expect(page.configRequests).toEqual([]);

      page.privacy.optIn();
      page.run();

      expect(page.configRequests).toHaveLength(1);
    });

    it('deviceId is the stored id; identify and reset build on it in memory and are written at optIn', () => {
      const first = newPage();
      first.identify('user-1');
      first.run();
      const stored = first.deviceId;
      const cookie = first.cookie(IDENTITY_COOKIE);
      first.privacy.optOut();

      const page = otherPage(first);
      expect(page.deviceId).toBe(stored);
      page.identify('user-2');
      page.register('theme', 'dark');
      expect(page.identity.snapshot()).toMatchObject({ deviceId: stored, userId: 'user-2' });
      expect(page.cookie(IDENTITY_COOKIE)).toBe(cookie);

      page.privacy.optIn();
      page.run();

      expect(page.deviceId).toBe(stored);
      expect(page.identity.snapshot()).toMatchObject({ userId: 'user-2', superProperties: { theme: 'dark' } });
      const [, deviceId, epoch, userId] = (page.cookie(IDENTITY_COOKIE) ?? '').split('.');
      expect([deviceId, userId]).toEqual([stored, 'user-2']);
      expect(epoch).not.toBe(cookie?.split('.')[2]);
      expect(page.record('person')).toMatchObject({ user_id: 'user-2', device_id: stored, person_epoch: epoch });
      expect(page.sent().flat()).toEqual([]);
    });

    it('counts made while refused are never stored', () => {
      const page = newPage();
      page.privacy.optOut();
      page.stores.device.countDropped('backpressure', 3);

      page.privacy.optIn();
      page.run();

      expect(diagnostics(page).dropped).toEqual({});
    });
  });

  describe('start, listeners and failures', () => {
    it('start sets the access level from the decision before anything reads storage', () => {
      expect(newPage().stores.accessLevel).toBe('full');
      expect(newPage(consentConfig('pending')).stores.accessLevel).toBe('consent');
      const first = newPage();
      first.privacy.optOut();
      expect(otherPage(first).stores.accessLevel).toBe('consent');
    });

    it('stop removes the listeners: a storage event no longer reads the decision', () => {
      const first = newPage(consentConfig('pending'));
      const second = otherPage(first, { config: consentConfig('pending') });
      second.privacy.stop();

      first.privacy.optIn();

      expect(second.stores.accessLevel).toBe('consent');
      expect(second.privacy.state()).toBe('granted');
      expect(second.stores.accessLevel).toBe('full');
    });

    it('with cookies and storage throwing, every entry point returns normally', () => {
      for (const defaultConsent of ['granted', 'pending'] as const) {
        const page = newPage(consentConfig(defaultConsent));
        page.track('Before');
        page.run();
        page.test.cookies.failAccess = true;
        page.test.storage.failAccess = true;

        expect(() => {
          page.privacy.state();
          page.privacy.isOptedOut();
          page.privacy.optOut();
          page.track('Refused');
          page.privacy.clearLocalData();
          page.privacy.optIn();
          page.track('Again');
          page.privacy.clearLocalData();
          page.test.lifecycle.hide();
          page.test.lifecycle.show();
          page.run();
        }).not.toThrow();
        expect(page.privacy.state()).toBe('granted');
      }
    });
  });

  describe('clearLocalData (Web Privacy 3, Web Logging 4 point 6)', () => {
    function stocked(config: Record<string, unknown> = {}): PrivacyPage {
      const page = newPage(config);
      page.identify('user-42');
      page.register('plan', 'pro');
      page.track('Before');
      page.run();
      page.stores.remote.save({ etag: '"e"', values: { flush_at: 50 }, fetchedAt: page.test.clock.now() });
      page.stores.pause.write(() => ({ until: page.test.clock.now() + 60_000, kind: 'throttle', host: 'h' }));
      page.test.storage.area.entries.set(markerKey(KEY_HASH, 'aaaaaaaaaaaaaaaa'), '');
      page.test.storage.area.entries.set(
        chunkKey({
          keyHash: KEY_HASH,
          writtenAt: 1,
          newestEventAt: page.test.clock.now(),
          pageId: 'aaaaaaaaaaaaaaaa',
          seq: 0,
          count: 1,
          chars: 3,
        }),
        '{}\n',
      );
      return page;
    }

    it('granted: deletes events and the person, renews the device id, keeps consent, remote and pause', () => {
      const page = stocked();
      page.privacy.optIn();
      const before = page.deviceId;

      page.privacy.clearLocalData();
      page.track('After');
      page.run();

      const deviceId = page.deviceId;
      expect(deviceId).not.toBe(before);
      expect(page.cookie(IDENTITY_COOKIE)?.split('.')[1]).toBe(deviceId);
      expect(names(page.stored())).toEqual(['Session Started', 'After']);
      expect(page.stored().every((event) => event.device_id === deviceId && event.user_id === null)).toBe(true);
      expect(page.record('person')?.['super_properties']).toBeUndefined();
      expect(page.record('consent')?.['state']).toBe('granted');
      expect(page.record('remote')).toBeDefined();
      expect(page.record('pause')).toBeDefined();
      expect(page.record('device')?.['device_id']).toBe(deviceId);
      expect(page.dropped()).toEqual([]);
      expect(page.drops.size).toBe(0);
    });

    it('produces no Session Ended and counts nothing', () => {
      const page = newPage();
      page.track('Opened');
      page.run();

      page.privacy.clearLocalData();
      page.run();

      expect(names(page.stored())).toEqual([]);
      expect(page.dropped()).toEqual([]);
      expect(page.drops.size).toBe(0);
    });

    it('refused: deletes what is stored but the consent records and .remote, and writes no identity', () => {
      const page = stocked();
      page.privacy.optOut();
      const before = page.deviceId;

      page.privacy.clearLocalData();

      expect(page.storageKeys()).toEqual([storeKey(KEY_HASH, 'consent'), storeKey(KEY_HASH, 'remote')]);
      expect(page.cookieNames()).toEqual([CONSENT_COOKIE]);
      const renewed = page.deviceId;
      expect(renewed).not.toBe(before);

      page.privacy.optIn();
      expect(page.deviceId).toBe(renewed);
      expect(page.cookie(IDENTITY_COOKIE)?.split('.')[1]).toBe(renewed);
    });

    it('pending: deletes the same but keeps .pause', () => {
      const page = stocked(consentConfig('granted', false));
      const pending = otherPage(page, { config: consentConfig('pending', false) });
      const before = page.deviceId;

      pending.privacy.clearLocalData();

      expect(pending.storageKeys()).toEqual([storeKey(KEY_HASH, 'pause'), storeKey(KEY_HASH, 'remote')]);
      expect(pending.cookieNames()).toEqual([]);
      pending.privacy.optIn();
      expect(pending.deviceId).not.toBe(before);
      expect(pending.cookie(IDENTITY_COOKIE)?.split('.')[1]).toBe(pending.deviceId);
    });

    it('in the memory-only mode only the page’s memory is cleared', () => {
      const page = stocked();
      const keys = page.storageKeys();
      page.stores.accessLevel = 'none';
      const before = page.deviceId;

      page.privacy.clearLocalData();

      expect(page.storageKeys()).toEqual(keys);
      expect(page.deviceId).not.toBe(before);
    });
  });
});
