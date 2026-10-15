import { TestClock } from 'rubicon-analytics-testing';
import { describe, expect, it } from 'vitest';
import { encodeSessionCookie, HEARTBEAT_MS, isDeviceId, MAX_SESSION_DURATION_MS } from '../../src';
import type { SessionState } from '../../src';
import {
  browser,
  endedOf,
  kinds,
  openSessionPage,
  otherTab,
  rawSessionCookie,
  SESSION_COOKIE,
  sessionCookie,
  TIMEOUT,
} from './session-test-support';
import type { SessionPage, SessionPageOptions } from './session-test-support';

const T0 = TestClock.DEFAULT_START;
const MINUTE = 60_000;

function newPage(options: SessionPageOptions = {}): SessionPage {
  return openSessionPage(browser(), options);
}

/** Writes a session cookie as another tab, another SDK version or another script would. */
function plantSession(page: SessionPage, value: string): void {
  page.cookies.jar.write({
    name: SESSION_COOKIE,
    value,
    path: '/',
    maxAgeSeconds: 3600,
    sameSite: 'Lax',
    secure: true,
  });
}

function sessionErrors(page: SessionPage): string[] {
  return page.sink.lines
    .filter((line) => line.level !== 'debug' && line.message.includes('session cookie'))
    .map((line) => line.message);
}

describe('SessionManager', () => {
  describe('starting a session (Session 2, 5, Web Session 1)', () => {
    it('the first event of a visible page starts it, with Session Started right before', () => {
      const page = newPage();

      const outcome = page.event();

      expect(kinds(outcome.before)).toEqual(['started']);
      const started = outcome.before[0];
      expect(started?.session.id).toBe(outcome.session?.id);
      expect(isDeviceId(outcome.session?.id)).toBe(true);
      expect(outcome.session?.startedAt).toBe(T0);
      expect(started?.session.startedAt).toBe(T0);
      expect(sessionCookie(page)).toEqual({
        id: outcome.session?.id,
        startedAt: T0,
        lastActivity: T0,
        personEpoch: page.epoch(),
      });
    });

    it('later events of a visible page continue it without session events', () => {
      const page = newPage();
      const first = page.event();
      page.clock.advanceBy(MINUTE);

      const outcome = page.event();

      expect(outcome.session?.id).toBe(first.session?.id);
      expect(outcome.before).toEqual([]);
    });

    it('a visible page without activity for the timeout ends it, where the Android foreground keeps it', () => {
      const page = newPage();
      const first = page.event();
      page.clock.advanceBy(TIMEOUT + 1);

      const outcome = page.event();

      expect(kinds(outcome.before)).toEqual(['ended', 'started']);
      expect(outcome.before[0]?.session.id).toBe(first.session?.id);
      expect(outcome.session?.id).not.toBe(first.session?.id);
    });

    it('a hidden page has no session until a visible event, and becoming visible alone starts none', () => {
      const page = newPage({ visible: false });

      expect(page.event()).toEqual({ session: undefined, before: [] });
      page.lifecycle.show();
      expect(page.events).toEqual([]);
      expect(rawSessionCookie(page)).toBeUndefined();
      expect(page.sessionWrites()).toBe(0);

      expect(kinds(page.event().before)).toEqual(['started']);
    });

    it('ids are kept with session events switched off', () => {
      const page = newPage({ emitEvents: false });

      const outcome = page.event();
      page.clock.advanceBy(TIMEOUT + 1);
      const next = page.event();

      expect(outcome.session?.startedAt).toBe(T0);
      expect(outcome.before).toEqual([]);
      expect(next.session?.id).not.toBe(outcome.session?.id);
      expect(next.before).toEqual([]);
    });
  });

  describe('inactivity (Web Session 1, 3)', () => {
    it('returning within the timeout continues the same session', () => {
      const page = newPage();
      const first = page.event();
      page.lifecycle.hide();
      page.clock.advanceBy(TIMEOUT - 1);

      page.lifecycle.show();

      expect(page.events.slice(1)).toEqual([]);
      expect(page.event().session?.id).toBe(first.session?.id);
    });

    it('returning after the timeout ends it, backdated to the hiding, and the next event starts another', () => {
      const page = newPage();
      const first = page.event();
      page.clock.advanceBy(90_000);
      page.lifecycle.hide();
      page.clock.advanceBy(TIMEOUT + 1);

      page.lifecycle.show();

      const ended = endedOf(page.events);
      expect(ended.session.id).toBe(first.session?.id);
      expect(ended.session.lastActivity).toBe(T0 + 90_000);
      expect(ended.durationMs).toBe(90_000);
      expect(ended.identity).toBeUndefined();
      expect(rawSessionCookie(page)).toBeUndefined();
      const next = page.event();
      expect(kinds(next.before)).toEqual(['started']);
      expect(next.session?.startedAt).toBe(page.clock.now());
    });

    it('the timeout itself is still inside the session; one millisecond more ends it', () => {
      const page = newPage();
      const first = page.event();
      page.lifecycle.hide();
      page.clock.advanceBy(TIMEOUT);

      expect(page.event().session?.id).toBe(first.session?.id);
      page.clock.advanceBy(1);
      const outcome = page.event();

      expect(outcome.session).toBeUndefined();
      expect(kinds(outcome.before)).toEqual(['ended']);
    });

    it("a hidden page's events use a valid session but never extend it", () => {
      const page = newPage();
      const first = page.event();
      page.lifecycle.hide();
      for (let minute = 1; minute <= 29; minute += 1) {
        page.clock.advanceBy(MINUTE);
        expect(page.event().session?.id).toBe(first.session?.id);
      }

      expect(sessionCookie(page)?.lastActivity).toBe(T0);
      page.clock.advanceBy(MINUTE + 1);
      page.lifecycle.show();
      expect(endedOf(page.events).session.lastActivity).toBe(T0);
    });

    it('the first hidden event after the timeout ends it and carries no session; later ones find nothing', () => {
      const page = newPage();
      const first = page.event();
      page.lifecycle.hide();
      page.clock.advanceBy(TIMEOUT + 1);

      const outcome = page.event();

      expect(outcome.session).toBeUndefined();
      expect(endedOf(outcome.before).session.id).toBe(first.session?.id);
      expect(rawSessionCookie(page)).toBeUndefined();
      expect(page.event()).toEqual({ session: undefined, before: [] });
    });

    it('a hidden tab never extends the session another tab started (Web Session 1)', () => {
      const visible = newPage();
      const first = visible.event();
      visible.lifecycle.hide();
      const hidden = otherTab(visible, { visible: false });
      for (let minute = 1; minute <= 30; minute += 1) {
        visible.clock.advanceBy(MINUTE);
        expect(hidden.event().session?.id).toBe(first.session?.id);
      }

      visible.clock.advanceBy(1);

      expect(hidden.event().session).toBeUndefined();
      expect(hidden.sessionWrites()).toBe(1);
      expect(endedOf(hidden.events).session.lastActivity).toBe(T0);
    });

    it('a shorter configured timeout ends the session sooner', () => {
      const page = newPage({ timeout: MINUTE });
      page.event();
      page.clock.advanceBy(MINUTE + 1);

      expect(kinds(page.event().before)).toEqual(['ended', 'started']);
    });
  });

  describe('the maximum of 12 hours (Session 4)', () => {
    it('a session ends after 12 hours and a new one starts with the visible event', () => {
      const page = newPage();
      const first = page.event();
      while (page.clock.now() + 25 * MINUTE <= T0 + MAX_SESSION_DURATION_MS) {
        page.clock.advanceBy(25 * MINUTE);
        expect(page.event().before).toEqual([]);
      }
      page.clock.set(T0 + MAX_SESSION_DURATION_MS);
      expect(page.event().session?.id).toBe(first.session?.id);
      page.clock.advanceBy(1);

      const outcome = page.event();

      expect(kinds(outcome.before)).toEqual(['ended', 'started']);
      const ended = endedOf(outcome.before);
      expect(ended.session.id).toBe(first.session?.id);
      // The last activity written is at most 30 seconds old (Web Session 4).
      expect(ended.durationMs).toBeGreaterThan(MAX_SESSION_DURATION_MS - HEARTBEAT_MS);
      expect(outcome.session?.startedAt).toBe(T0 + MAX_SESSION_DURATION_MS + 1);
    });

    it('it is also found on becoming visible', () => {
      const page = newPage();
      const first = page.event();
      for (let i = 1; i <= 23; i += 1) {
        page.clock.advanceBy(30 * MINUTE);
        page.event();
      }
      page.clock.set(T0 + MAX_SESSION_DURATION_MS - MINUTE);
      page.event();
      page.lifecycle.hide();
      page.clock.advanceBy(MINUTE + 1);

      page.lifecycle.show();

      expect(endedOf(page.events).session.id).toBe(first.session?.id);
    });
  });

  describe('page loads (Session 6 as Web Session 1, 2 and 4)', () => {
    it('a page loaded within the timeout continues the session', () => {
      const first = newPage();
      const started = first.event();
      first.lifecycle.hide();
      first.clock.advanceBy(TIMEOUT - 1000);

      const next = otherTab(first);

      expect(next.load()).toEqual([]);
      const outcome = next.event();
      expect(outcome.session?.id).toBe(started.session?.id);
      expect(outcome.before).toEqual([]);
    });

    it('a page loaded after the timeout ends it at load, backdated, and deletes the cookie', () => {
      const first = newPage();
      const started = first.event();
      first.clock.advanceBy(40_000);
      first.lifecycle.hide();
      first.clock.advanceBy(TIMEOUT + 1);

      const ended = endedOf(otherTab(first).load());

      expect(ended.session.id).toBe(started.session?.id);
      expect(ended.session.lastActivity).toBe(T0 + 40_000);
      expect(ended.durationMs).toBe(40_000);
      expect(rawSessionCookie(first)).toBeUndefined();
    });

    it('a page loaded hidden keeps counting from the last activity', () => {
      const first = newPage();
      const started = first.event();
      first.lifecycle.hide();
      first.clock.advanceBy(TIMEOUT - 10_000);
      const next = otherTab(first, { visible: false });

      expect(next.load()).toEqual([]);
      expect(next.event().session?.id).toBe(started.session?.id);
      next.clock.advanceBy(10_001);
      expect(next.event().session).toBeUndefined();
    });

    it('a page loaded past the maximum ends it', () => {
      const first = newPage();
      const started = first.event();
      first.clock.advanceBy(MAX_SESSION_DURATION_MS - 1000);
      // Kept alive by another page meanwhile.
      plantSession(
        first,
        encodeSessionCookie({
          id: started.session?.id ?? '',
          startedAt: T0,
          lastActivity: first.clock.now(),
          personEpoch: first.epoch(),
        }),
      );
      first.clock.advanceBy(2000);

      expect(endedOf(otherTab(first).load()).session.id).toBe(started.session?.id);
    });

    it('a page loaded with no session, or with a live one, does nothing and writes nothing', () => {
      const empty = newPage();
      expect(empty.load()).toEqual([]);
      expect(empty.sessionWrites()).toBe(0);

      empty.event();
      const next = otherTab(empty);
      expect(next.load()).toEqual([]);
      expect(next.sessionWrites()).toBe(0);
    });

    it("a page's first activity always writes, even right after another page's write (iOS log 6.2)", () => {
      const first = newPage();
      first.event();
      first.clock.advanceBy(5000);
      const next = otherTab(first);

      next.event();

      expect(next.sessionWrites()).toBe(1);
      expect(sessionCookie(first)?.lastActivity).toBe(T0 + 5000);
    });
  });

  describe('the clock (Web Session 4)', () => {
    it('a clock 60 seconds behind the last activity is no gap, and the last activity never moves back', () => {
      const page = newPage();
      const first = page.event();
      page.clock.advanceBy(10_000);
      page.lifecycle.hide();
      page.clock.advanceBy(-60_000);

      page.lifecycle.show();
      const outcome = page.event();

      expect(page.events.slice(1)).toEqual([]);
      expect(outcome.session?.id).toBe(first.session?.id);
      expect(sessionCookie(page)?.lastActivity).toBe(T0 + 10_000);
    });

    it('a clock 61 seconds behind ends the session, backdated to the saved last activity', () => {
      const page = newPage();
      const first = page.event();
      page.clock.advanceBy(10_000);
      page.lifecycle.hide();
      page.clock.advanceBy(-61_000);

      page.lifecycle.show();

      const ended = endedOf(page.events);
      expect(ended.session.id).toBe(first.session?.id);
      expect(ended.session.lastActivity).toBe(T0 + 10_000);
      const next = page.event();
      expect(kinds(next.before)).toEqual(['started']);
      expect(next.session?.startedAt).toBe(T0 - 51_000);
    });

    it('a clock 61 seconds behind ends the session at a visible event too, with Session Started after', () => {
      const page = newPage();
      page.event();
      page.clock.advanceBy(-61_000);

      expect(kinds(page.event().before)).toEqual(['ended', 'started']);
    });

    it('a clock set back before the start of a recent session ends it on becoming visible', () => {
      const page = newPage();
      page.event();
      page.lifecycle.hide();
      page.clock.advanceBy(-10 * MINUTE);

      page.lifecycle.show();

      expect(kinds(page.events)).toEqual(['started', 'ended']);
    });

    it('a page loaded with the clock set back by a day ends the saved session', () => {
      const first = newPage();
      const started = first.event();
      first.clock.advanceBy(MINUTE);
      first.lifecycle.hide();
      first.clock.advanceBy(-86_400_000);

      expect(endedOf(otherTab(first).load()).session.id).toBe(started.session?.id);
      expect(rawSessionCookie(first)).toBeUndefined();
    });

    it('a clock jumping forward past the timeout ends the session, as the wall clock is the only one', () => {
      const page = newPage();
      page.event();
      page.lifecycle.hide();
      page.clock.advanceBy(10 * TIMEOUT);

      page.lifecycle.show();

      expect(kinds(page.events)).toEqual(['started', 'ended']);
    });
  });

  describe('writing the last activity (Web Session 4)', () => {
    it('events write it at most every 30 seconds', () => {
      const page = newPage();
      page.event();
      const written: number[] = [];
      for (let i = 0; i < 12; i += 1) {
        page.clock.advanceBy(10_000);
        page.event();
        written.push(sessionCookie(page)?.lastActivity ?? 0);
      }

      expect(Array.from(new Set(written))).toEqual([T0, T0 + 30_000, T0 + 60_000, T0 + 90_000, T0 + 120_000]);
      expect(page.sessionWrites()).toBe(5);
    });

    it('hiding and pagehide write it at once', () => {
      const page = newPage();
      page.event();
      page.clock.advanceBy(5000);

      page.lifecycle.hide();
      expect(sessionCookie(page)?.lastActivity).toBe(T0 + 5000);

      page.lifecycle.show();
      page.clock.advanceBy(3000);
      page.lifecycle.pagehide();
      expect(sessionCookie(page)?.lastActivity).toBe(T0 + 8000);
    });

    it('becoming visible is activity, and a back/forward cache restore counts as becoming visible', () => {
      const page = newPage();
      page.event();
      page.lifecycle.hide();
      page.clock.advanceBy(20 * MINUTE);

      page.lifecycle.show();
      expect(sessionCookie(page)?.lastActivity).toBe(T0 + 20 * MINUTE);

      page.lifecycle.pagehide();
      page.lifecycle.hide();
      page.clock.advanceBy(20 * MINUTE);
      page.lifecycle.pageshowPersisted();
      expect(sessionCookie(page)?.lastActivity).toBe(T0 + 40 * MINUTE);
      expect(kinds(page.events)).toEqual(['started']);
    });

    it('a page that goes away without pagehide leaves an end at most 30 seconds early', () => {
      const page = newPage();
      page.event();
      page.clock.advanceBy(25_000);
      page.event();
      page.clock.advanceBy(25_000);
      page.event();
      // The page is gone here without pagehide.
      page.clock.advanceBy(TIMEOUT + MINUTE);

      const ended = endedOf(otherTab(page).load());

      expect(T0 + 50_000 - ended.session.lastActivity).toBeLessThanOrEqual(HEARTBEAT_MS);
    });

    it('every write has the attributes of the identity cookie and a Max-Age of 12 hours, renewed', () => {
      const page = newPage({ domain: 'rubicon.test' });
      page.event();
      page.lifecycle.hide();

      const writes = page.cookies.writes.filter((write) => write.name === SESSION_COOKIE);
      expect(writes).toHaveLength(2);
      for (const write of writes) {
        expect(write).toMatchObject({
          domain: 'rubicon.test',
          path: '/',
          maxAgeSeconds: 43_200,
          sameSite: 'Lax',
          secure: true,
        });
      }
      page.clock.advanceBy(12 * 60 * MINUTE - 1);
      expect(rawSessionCookie(page)).toBeDefined();
      page.clock.advanceBy(1);
      expect(rawSessionCookie(page)).toBeUndefined();
    });

    it('a replayed call inside the session moves the last activity only forward (Web Session 5)', () => {
      const first = newPage();
      first.event();
      first.clock.advanceBy(MINUTE);
      first.event();
      const next = otherTab(first);

      const outcome = next.event(T0 + 10_000, true);

      expect(outcome.session?.startedAt).toBe(T0);
      expect(sessionCookie(first)?.lastActivity).toBe(T0 + MINUTE);
    });
  });

  describe('several tabs and subdomains (Web Session 2)', () => {
    it('every tab of the site works on one session', () => {
      const first = newPage();
      const started = first.event();
      const second = otherTab(first);

      const outcome = second.event();

      expect(outcome.session?.id).toBe(started.session?.id);
      expect(outcome.before).toEqual([]);
    });

    it('a subdomain shares the session through the cookie domain', () => {
      const shop = openSessionPage(browser({ host: 'shop.rubicon.test' }), { domain: 'rubicon.test' });
      const started = shop.event();
      const www = otherTab(shop, { host: 'www.rubicon.test', domain: 'rubicon.test' });

      const outcome = www.event();

      expect(www.epoch()).toBe(shop.epoch());
      expect(outcome.session?.id).toBe(started.session?.id);
      expect(outcome.before).toEqual([]);
    });

    it('the tab that finds the end writes the new session, reads it back, then produces both events once', () => {
      const first = newPage();
      first.event();
      const second = otherTab(first);
      second.event();
      first.clock.advanceBy(TIMEOUT + 1);

      const outcome = first.event();
      const adopted = second.event();

      expect(kinds(outcome.before)).toEqual(['ended', 'started']);
      expect(adopted.session?.id).toBe(outcome.session?.id);
      expect(adopted.before).toEqual([]);
      expect(kinds(second.events)).toEqual([]);
    });

    it("a tab that reads back another tab's new session adopts it and produces no session events", () => {
      const first = newPage();
      first.event();
      first.clock.advanceBy(TIMEOUT + 1);
      const theirs: SessionState = {
        id: '0191d0c2-1a2b-7c3d-9e4f-000000000002',
        startedAt: first.clock.now(),
        lastActivity: first.clock.now(),
        personEpoch: first.epoch(),
      };
      // Another tab, which found the same end, writes its new session right after this tab's write.
      first.cookies.afterWrite = () => {
        plantSession(first, encodeSessionCookie(theirs));
      };

      const outcome = first.event();

      expect(outcome).toEqual({ session: { id: theirs.id, startedAt: theirs.startedAt }, before: [] });
      expect(sessionCookie(first)).toEqual(theirs);
    });

    it('two tabs that find the same end at the same moment may both report it (the documented race)', () => {
      const first = newPage();
      const started = first.event();
      const second = otherTab(first);
      first.clock.advanceBy(TIMEOUT + 1);
      // The second tab has read the ended session when the first one runs, then writes last.
      second.cookies.beforeWrite = () => first.event();

      const theirs = second.event();

      expect(kinds(first.events)).toEqual(['started', 'ended', 'started']);
      expect(kinds(second.events)).toEqual(['ended', 'started']);
      expect(endedOf(second.events).session.id).toBe(started.session?.id);
      // The first tab's session is an orphan of its Session Started; both tabs go on in the last write.
      expect(first.event().session?.id).toBe(theirs.session?.id);
      expect(first.events).toHaveLength(3);
    });

    it('a hidden tab that finds the end deletes the session, and the visible tab starts a new one without a second Session Ended', () => {
      const visible = newPage();
      visible.event();
      visible.lifecycle.hide();
      const hidden = otherTab(visible, { visible: false });
      visible.clock.advanceBy(TIMEOUT + 1);

      expect(kinds(hidden.event().before)).toEqual(['ended']);
      visible.lifecycle.show();
      const outcome = visible.event();

      expect(kinds(visible.events)).toEqual(['started', 'started']);
      expect(outcome.session?.startedAt).toBe(visible.clock.now());
    });
  });

  describe('a change of person (Web Session 5)', () => {
    it('reset ends the session first as the previous person, then the epoch changes and the cookie is cleared', () => {
      const page = newPage();
      page.identity.identify('user-42', undefined);
      const before = page.identity.snapshot();
      const started = page.event();
      page.clock.advanceBy(20_000);

      page.identity.reset();

      const ended = endedOf(page.events);
      expect(ended.session.id).toBe(started.session?.id);
      expect(ended.identity?.userId).toBe('user-42');
      expect(ended.identity?.personEpoch).toBe(before.personEpoch);
      // From a visible tab the end is now (Android log 6.2).
      expect(ended.session.lastActivity).toBe(T0 + 20_000);
      expect(ended.durationMs).toBe(20_000);
      expect(rawSessionCookie(page)).toBeUndefined();
      expect(page.cookies.value()?.personEpoch).not.toBe(before.personEpoch);
      const next = page.event();
      expect(kinds(next.before)).toEqual(['started']);
      expect(sessionCookie(page)?.personEpoch).toBe(page.cookies.value()?.personEpoch);
    });

    it("from a hidden tab the end is the session's last activity", () => {
      const page = newPage();
      page.event();
      page.clock.advanceBy(5000);
      page.lifecycle.hide();
      page.clock.advanceBy(MINUTE);

      page.identity.reset();

      expect(endedOf(page.events).session.lastActivity).toBe(T0 + 5000);
      expect(page.event().session).toBeUndefined();
    });

    it('a session that had already ended keeps its own last activity', () => {
      const page = newPage();
      page.event();
      page.clock.advanceBy(TIMEOUT + 5 * MINUTE);

      page.identity.reset();

      expect(endedOf(page.events).session.lastActivity).toBe(T0);
    });

    it('identify with another user ends the session as the previous user', () => {
      const page = newPage();
      page.identity.identify('user-42', undefined);
      page.event();

      page.identity.identify('user-43', undefined);

      expect(endedOf(page.events).identity?.userId).toBe('user-42');
      expect(kinds(page.event().before)).toEqual(['started']);
    });

    it('anonymous to identified keeps the session (Identity 3)', () => {
      const page = newPage();
      const started = page.event();

      page.identity.identify('user-42', undefined);

      expect(page.event().session?.id).toBe(started.session?.id);
      expect(kinds(page.events)).toEqual(['started']);
    });

    it('without an open session nothing is produced', () => {
      const page = newPage();

      page.identity.reset();

      expect(page.events).toEqual([]);
    });

    it("reset in one tab, then the other tab's heartbeat: no session is written back and no user returns", () => {
      const first = newPage();
      first.identity.identify('user-42', undefined);
      first.event();
      const second = otherTab(first);
      second.event();

      first.identity.reset();
      second.lifecycle.hide();

      expect(rawSessionCookie(first)).toBeUndefined();
      expect(first.cookies.value()?.userId).toBeNull();
      second.lifecycle.show();
      const outcome = second.event();
      expect(kinds(outcome.before)).toEqual(['started']);
      expect(sessionCookie(first)?.personEpoch).toBe(first.cookies.value()?.personEpoch);
      expect(kinds(second.events)).toEqual(['started']);
    });

    it('an interleaved race: a tab reads, another resets, the first writes; the old user never returns', () => {
      const first = newPage();
      first.identity.identify('user-42', undefined);
      const old = first.event();
      const second = otherTab(first);
      second.event();
      // The second tab has read both cookies when the first one resets, then writes its heartbeat.
      second.cookies.beforeWrite = () => {
        first.identity.reset();
      };
      first.clock.advanceBy(MINUTE);

      second.lifecycle.hide();

      // The stale session was written back, but under the old epoch, and the identity cookie was not.
      expect(sessionCookie(first)?.id).toBe(old.session?.id);
      expect(sessionCookie(first)?.personEpoch).not.toBe(first.cookies.value()?.personEpoch);
      expect(first.cookies.value()?.userId).toBeNull();
      expect(endedOf(first.events).identity?.userId).toBe('user-42');
      // Every tab ignores it: the next visible event starts a session of the new person, no second end.
      const next = first.event();
      expect(kinds(next.before)).toEqual(['started']);
      second.lifecycle.show();
      expect(second.event().session?.id).toBe(next.session?.id);
      expect(kinds(second.events)).toEqual([]);
      expect(first.cookies.value()?.userId).toBeNull();
      expect(second.identity.snapshot().userId).toBeNull();
    });

    it("a replayed call after another page's new session carries none and moves nothing back", () => {
      const first = newPage();
      first.event();
      first.clock.advanceBy(TIMEOUT + 1);
      const current = first.event();
      first.clock.advanceBy(1000);
      const replaying = otherTab(first);
      const cookie = rawSessionCookie(first);

      // Queued by the snippet five minutes into the previous session, visible then.
      const outcome = replaying.event(T0 + 5 * MINUTE, true);

      expect(outcome).toEqual({ session: undefined, before: [] });
      expect(replaying.sessionWrites()).toBe(0);
      expect(rawSessionCookie(first)).toBe(cookie);
      expect(sessionCookie(first)?.id).toBe(current.session?.id);
    });

    it('a replayed hidden call uses the session it belongs to and extends nothing', () => {
      const first = newPage();
      const started = first.event();
      first.clock.advanceBy(MINUTE);
      const replaying = otherTab(first);

      const outcome = replaying.event(T0 + 30_000, false);

      expect(outcome).toEqual({ session: { id: started.session?.id, startedAt: T0 }, before: [] });
      expect(replaying.sessionWrites()).toBe(0);
    });
  });

  describe('when the cookie cannot be used (Web Privacy 1, Web Disk 4, Web Identity 1)', () => {
    it.each(['consent', 'none'] as const)(
      'with access %s the session lives in memory under the same rules and no cookie is written',
      (access) => {
        const page = newPage({ access });
        const started = page.event();
        page.clock.advanceBy(MINUTE);
        page.lifecycle.hide();
        page.clock.advanceBy(TIMEOUT + 1);
        page.lifecycle.show();
        const next = page.event();

        expect(kinds(started.before)).toEqual(['started']);
        expect(kinds(page.events)).toEqual(['started', 'ended', 'started']);
        expect(endedOf(page.events).session.lastActivity).toBe(T0 + MINUTE);
        expect(next.session?.id).not.toBe(started.session?.id);
        expect(page.cookies.writes).toEqual([]);
      },
    );

    it('when access becomes full the session in memory is written to the empty cookie', () => {
      const page = newPage({ access: 'consent' });
      const started = page.event();
      page.clock.advanceBy(MINUTE);

      page.stores.accessLevel = 'full';
      const outcome = page.event();

      expect(outcome).toEqual({ session: started.session, before: [] });
      expect(sessionCookie(page)).toMatchObject({ id: started.session?.id, lastActivity: T0 + MINUTE });
    });

    it("when access becomes full another tab's session in the cookie wins", () => {
      const granted = newPage();
      const theirs = granted.event();
      const pending = otherTab(granted, { access: 'consent' });
      pending.event();

      pending.stores.accessLevel = 'full';

      expect(pending.event().session?.id).toBe(theirs.session?.id);
    });

    it('a write that does not stick keeps the session in memory, with one STORAGE_WRITE_FAILED', () => {
      const page = newPage();
      page.identity.snapshot();
      page.cookies.jar.blockWrites = true;

      const started = page.event();
      page.clock.advanceBy(MINUTE);
      const next = page.event();
      page.lifecycle.hide();

      expect(kinds(started.before)).toEqual(['started']);
      expect(next.session?.id).toBe(started.session?.id);
      expect(page.sessionWrites()).toBe(1);
      expect(page.logged('STORAGE_WRITE_FAILED')).toBe(true);
      expect(sessionErrors(page)).toHaveLength(1);
    });

    it('a cookie this version cannot read is never overwritten (Web Identity 1)', () => {
      const page = newPage();
      const newer = `2.${'0'.repeat(40)}`;
      plantSession(page, newer);

      const started = page.event();
      page.lifecycle.hide();
      page.identity.reset();

      expect(kinds(started.before)).toEqual(['started']);
      expect(rawSessionCookie(page)).toBe(newer);
      expect(page.sessionWrites()).toBe(0);
      expect(page.logged('STORE_UNREADABLE')).toBe(true);
    });

    it('a cookie access that throws degrades to memory and never throws', () => {
      const page = newPage();
      page.cookies.jar.failAccess = true;

      const started = page.event();
      page.lifecycle.hide();
      page.identity.reset();
      page.sessions.endSilently();
      page.sessions.clear();

      expect(kinds(started.before)).toEqual(['started']);
      expect(page.logged('STORE_UNREADABLE')).toBe(true);
    });

    it('a failing heartbeat write keeps the session in memory', () => {
      const page = newPage();
      const started = page.event();
      page.clock.advanceBy(MINUTE);
      page.cookies.beforeWrite = () => {
        throw new Error('write refused');
      };

      page.lifecycle.hide();
      page.lifecycle.show();

      expect(page.event().session?.id).toBe(started.session?.id);
      expect(page.logged('STORAGE_WRITE_FAILED')).toBe(true);
      expect(page.sessionWrites()).toBe(2);
    });
  });

  describe('opting out and clearing', () => {
    it('opting out ends the session silently and deletes the cookie (Privacy 1)', () => {
      const page = newPage();
      const started = page.event();

      page.sessions.endSilently();

      expect(rawSessionCookie(page)).toBeUndefined();
      expect(kinds(page.events)).toEqual(['started']);
      const next = page.event();
      expect(next.session?.id).not.toBe(started.session?.id);
      expect(kinds(next.before)).toEqual(['started']);
    });

    it('opting out while consent is pending forgets the session in memory', () => {
      const page = newPage({ access: 'consent' });
      const started = page.event();

      page.sessions.endSilently();

      expect(page.event().session?.id).not.toBe(started.session?.id);
    });

    it('clearLocalData deletes the session cookie, an unreadable one too, without an event (Web Privacy 3)', () => {
      const page = newPage();
      plantSession(page, 'garbage');

      page.sessions.clear();

      expect(rawSessionCookie(page)).toBeUndefined();
      expect(page.events).toEqual([]);
    });

    it('the memory-only mode clears memory only', () => {
      const page = newPage({ access: 'none' });
      const started = page.event();
      plantSession(page, 'garbage');

      page.sessions.clear();

      expect(rawSessionCookie(page)).toBe('garbage');
      expect(page.event().session?.id).not.toBe(started.session?.id);
    });
  });
});
