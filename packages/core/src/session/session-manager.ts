import type { SessionContext } from '../event/event-context';
import type { IdentitySnapshot } from '../identity/identity';
import type { Log } from '../log';
import type { Clock, CookieJar, LifecycleEvent } from '../platform';
import { cookieValues } from '../storage/cookie-text';
import type { StoreAccess } from '../storage/store-record';
import type { UuidV7Generator } from '../util/uuid-v7-generator';
import {
  decodeSessionCookie,
  encodeSessionCookie,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  sessionCookieName,
} from './session-cookie';
import type { SessionState } from './session-cookie';

/** An automatic session event for the pipeline to create (Session 5). */
export type SessionEvent =
  | {
      /** `Session Started`: timestamp `session.startedAt`, no properties, in the new session. */
      readonly kind: 'started';
      readonly session: SessionState;
    }
  | {
      /**
       * `Session Ended`: backdated to `session.lastActivity`, with `durationMs`, in the ended
       * session. `identity` is the previous person's when a reset or a change of user ended it
       * (Web Session 5); otherwise the identity of the call that found the end applies.
       */
      readonly kind: 'ended';
      readonly session: SessionState;
      readonly durationMs: number;
      readonly identity?: IdentitySnapshot;
    };

/** The session of an event and the session events to create right before it. */
export interface SessionOutcome {
  /** `undefined` when the event belongs to no session (Web Session 1, 5). */
  readonly session: SessionContext | undefined;
  readonly before: readonly SessionEvent[];
}

/** One event as the session sees it (Web Session 5). */
export interface SessionCall {
  /** `t`: the call time, or the time the snippet recorded for a queued call. */
  readonly time: number;
  /** `visibilityState` was `visible` at `time`: read in the call, or recorded by the snippet. */
  readonly visible: boolean;
}

/** What a {@link SessionManager} is made of. */
export interface SessionManagerOptions {
  /** The first 16 hex characters of the SHA-256 of the API key (Web Identity 4). */
  readonly keyHash: string;
  readonly cookies: CookieJar;
  readonly clock: Clock;
  /** The instance's generator: session ids are UUIDv7 like every other id (Web Event Model 3). */
  readonly ids: Pick<UuidV7Generator, 'next'>;
  readonly log: Log;
  /** `session.inactivityTimeoutMs` (Web Session 3). */
  readonly inactivityTimeoutMs: number;
  /**
   * Whether `sessions` autocapture is on in the configuration the page runs with, code restricted by
   * the saved remote values (Web Lifecycle 8: a remote switch-off applies from the next page load);
   * session ids are kept either way (Session 5). Asked whenever a session event could be produced.
   */
  readonly emitEvents: () => boolean;
  /** `Secure` on the cookie: an `https` page (Web Identity 1). */
  readonly secure: boolean;
  /** The cookie's `Domain`, `undefined` for host-only: the identity cookie's (Web Session 2, step 7.2). */
  readonly cookieDomain: () => string | undefined;
  /**
   * The stores' access level, which decides whether the cookie is used: only under `full`; while
   * consent is pending or refused and in the memory-only mode the session lives in this page's
   * memory (Web Session 2 as changed on 2026-10-14, Web Privacy 1, Web Disk 4).
   */
  readonly accessLevel: () => StoreAccess['level'];
}

/** Session 4: internal, not configurable. */
export const MAX_SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

/** Web Session 4: a tab writes the last activity at most this often, unless it must at once. */
export const HEARTBEAT_MS = 30_000;

/** Web Session 4: a clock up to this far behind the saved last activity is no gap. */
export const CLOCK_TOLERANCE_MS = 60_000;

/** Where a call's session comes from: the cookie, or this page's memory. */
interface View {
  readonly where: 'cookie' | 'memory';
  /** The session there, of any person; `undefined` when there is none. */
  readonly state: SessionState | undefined;
  /** The cookie's raw value when `where` is `cookie` and it holds `state`. */
  readonly text: string | undefined;
}

/** What a cookie write left: this page's value, another page's session, or nothing that sticks. */
type WriteOutcome =
  { readonly kind: 'own' } | { readonly kind: 'other'; readonly state: SessionState } | { readonly kind: 'failed' };

const NONE: SessionOutcome = { session: undefined, before: [] };
const LABEL = 'session cookie';

/**
 * Sessions on the web (Session 1, 2, 5, Web Session 1 to 5): one session per site in the cookie
 * `rubicon_<keyHash>_s`, shared by every tab and subdomain, ended by inactivity. The port of the
 * Android `SessionManager`, with the cookie as the source of truth instead of memory:
 *
 * - Every call reads the cookie (Web Identity 3); a session whose `person_epoch` is not the identity
 *   cookie's belongs to an earlier person and is ignored (Web Session 5).
 * - Activity is a call from a visible tab, a tab becoming visible, hidden or `pagehide` (Web Session
 *   1). A hidden tab's events use a valid session but never extend it; without one they carry none
 *   and start none. A session starts with a visible tab's event. No timers: the end is found at an
 *   event, at a tab becoming visible and at page load ({@link start}).
 * - One membership rule for every event at its time `t` (Web Session 5): epochs equal, `started_at
 *   <= t` (with the 60-second tolerance), `t <= last activity + timeout`, `t - started_at <= 12 h`.
 *   A session that started after `t` gives the event none and is not written. A clock more than 60
 *   seconds behind the saved last activity ends the session (Web Session 4).
 * - A tab that finds the end of a session writes the new session (or deletes the ended one when it
 *   starts none) and reads the cookie back; only when its own write holds does it produce the
 *   session events, else it adopts what another tab wrote, silently (Web Session 2).
 * - The last activity is written at most every 30 seconds per tab, at once on hiding, `pagehide`
 *   and a new session; the first activity of a page always writes; it only moves forward (Web
 *   Session 4, 5). Every write renews `Max-Age` of 12 hours.
 * - The cookie is never written while the stores may not be used, when it is unreadable (never
 *   overwritten), or after a write of this page did not stick: the session then lives in this page's
 *   memory under the same rules (Web Identity 1, Web Privacy 1, Web Disk 4).
 *
 * The session events are returned for the pipeline to create (step 6.3a). Nothing here throws; a
 * cookie failure is logged and degrades to memory.
 */
export class SessionManager {
  private readonly cookieName: string;
  // The session of this page when the cookie is not used, and the one carried into the cookie when
  // access becomes full while the cookie is empty (Web Privacy 1).
  private local: SessionState | undefined;
  // When this page last wrote the last activity; `undefined` before its first activity (iOS log 6.2).
  private lastWrittenAt: number | undefined;
  // A write of this page did not stick: the cookie is left alone for the rest of the page load.
  private cookieRefused = false;

  constructor(private readonly options: SessionManagerOptions) {
    this.cookieName = sessionCookieName(options.keyHash);
  }

  /**
   * The evaluation at page load (Web Session 1): a session of this person that has ended (timeout,
   * maximum, clock set back) is ended now, with `Session Ended` backdated to its last activity. Not
   * an activity: a valid session is left as it is until this page's first activity.
   */
  start(personEpoch: string): SessionEvent[] {
    const now = this.options.clock.now();
    const view = this.view();
    const session = belonging(view.state, personEpoch);
    if (session === undefined) return [];
    const reason = this.endReason(session, now, now);
    return reason === undefined ? [] : this.endWithoutSuccessor(view, session, reason);
  }

  /** The session for an event, ending or starting one first where the rules say (Web Session 5). */
  onEvent(call: SessionCall, personEpoch: string): SessionOutcome {
    const now = this.options.clock.now();
    const view = this.view();
    const session = belonging(view.state, personEpoch);
    if (session !== undefined) {
      const clockBack = now < session.lastActivity - CLOCK_TOLERANCE_MS;
      if (!clockBack && session.startedAt > call.time + CLOCK_TOLERANCE_MS) {
        // Another tab began this session after the call was queued: the previous one is no longer
        // known, and a missing session is better than a wrong one (Web Session 5).
        this.options.log.debug(() => 'The session started after the event; the event carries none');
        return NONE;
      }
      const reason = this.endReason(session, call.time, now);
      if (reason === undefined) {
        if (call.visible) this.touch(view, session, call.time, false);
        return { session: contextOf(session), before: [] };
      }
      if (!call.visible) return { session: undefined, before: this.endWithoutSuccessor(view, session, reason) };
      return this.startSession(view, call.time, personEpoch, { session, reason });
    }
    return call.visible ? this.startSession(view, call.time, personEpoch, undefined) : NONE;
  }

  /**
   * A tab becoming visible or restored from the back/forward cache finds an end and is activity; a
   * tab becoming hidden or `pagehide` is activity written at once (Web Session 1, 4). Only becoming
   * visible can produce an event, `Session Ended`; a session starts with the next visible event.
   */
  onLifecycle(event: LifecycleEvent, personEpoch: string): SessionEvent[] {
    const now = this.options.clock.now();
    const view = this.view();
    const session = belonging(view.state, personEpoch);
    if (session === undefined) return [];
    // At `now` a session that started later can only mean a clock set back, which ends it.
    const reason = this.endReason(session, now, now);
    const leaving = event === 'hidden' || event === 'pagehide';
    if (reason === undefined) {
      this.touch(view, session, now, leaving);
      return [];
    }
    // Leaving is activity only for a live session; the end is found at the next event or return.
    return leaving ? [] : this.endWithoutSuccessor(view, session, reason);
  }

  /**
   * `reset()` or a change of user, called before the identity cookie gets the new epoch: the open
   * session ends first, with the previous person's identity, at now from a visible tab and at its
   * last activity otherwise (Web Session 5, Android log 6.2); the session cookie is cleared. A session
   * that had already ended keeps its own last activity. The next visible event starts a new one.
   */
  onPersonCleared(previous: IdentitySnapshot, visible: boolean): SessionEvent[] {
    const now = this.options.clock.now();
    const view = this.view();
    const session = belonging(view.state, previous.personEpoch);
    if (session === undefined) return [];
    this.forget(view, session);
    const ended = this.endReason(session, now, now) !== undefined;
    const last = visible && !ended ? Math.max(session.lastActivity, now) : session.lastActivity;
    this.options.log.debug(() => 'The person changed; the session ended');
    return this.ended({ ...session, lastActivity: last }, previous);
  }

  /** Ends the open session without an event, for `optOut()` (Privacy 1). */
  endSilently(): void {
    const view = this.view();
    if (view.state !== undefined) this.forget(view, view.state);
    this.local = undefined;
  }

  /**
   * The session part of `clearLocalData()` (Web Privacy 3): the session cookie is deleted, an
   * unreadable one too, as an erasure; no event. The memory-only mode leaves the cookie alone.
   */
  clear(): void {
    this.local = undefined;
    this.lastWrittenAt = undefined;
    this.cookieRefused = false;
    if (this.options.accessLevel() === 'none') return;
    this.deleteCookie();
  }

  // The session a call works on: the cookie's, or this page's memory where the cookie is not used.
  private view(): View {
    if (this.options.accessLevel() !== 'full' || this.cookieRefused) return this.memoryView();
    let text: string;
    try {
      text = this.options.cookies.readAll();
    } catch (error) {
      this.reportUnreadable('The session cookie cannot be read', error);
      return this.memoryView();
    }
    // The first of several values wins; the order is the browser's (RFC 6265 section 5.4).
    const first = cookieValues(text, this.cookieName)[0];
    if (first === undefined) return { where: 'cookie', state: this.local, text: undefined };
    const state = decodeSessionCookie(first);
    if (state !== undefined) return { where: 'cookie', state, text: first };
    // Never overwritten: a newer SDK on another page of the site may have written it (Web Identity 1).
    this.reportUnreadable('The session cookie exists but cannot be read', undefined);
    return this.memoryView();
  }

  private memoryView(): View {
    return { where: 'memory', state: this.local, text: undefined };
  }

  // Why `session` has ended for an event at `time` found at `now`, or `undefined` while it holds.
  private endReason(session: SessionState, time: number, now: number): string | undefined {
    if (now < session.lastActivity - CLOCK_TOLERANCE_MS) return 'the clock was set back';
    if (time > session.lastActivity + this.options.inactivityTimeoutMs) return 'the inactivity timeout passed';
    if (time - session.startedAt > MAX_SESSION_DURATION_MS) return 'the maximum duration passed';
    return undefined;
  }

  // A visible event with no session at `time`: the new session is written and read back, and only a
  // write that holds produces the session events (Web Session 2).
  private startSession(
    view: View,
    time: number,
    personEpoch: string,
    previous: { readonly session: SessionState; readonly reason: string } | undefined,
  ): SessionOutcome {
    const next: SessionState = { id: this.options.ids.next(), startedAt: time, lastActivity: time, personEpoch };
    const outcome: WriteOutcome = view.where === 'memory' ? { kind: 'own' } : this.writeCookie(next);
    if (outcome.kind === 'other') {
      this.options.log.debug(() => 'Another page started a new session; this page adopts it');
      const adopted = belonging(outcome.state, personEpoch);
      const member = adopted !== undefined && adopted.startedAt <= time + CLOCK_TOLERANCE_MS;
      return { session: member ? contextOf(adopted) : undefined, before: [] };
    }
    this.local = view.where === 'memory' || outcome.kind === 'failed' ? next : undefined;
    this.lastWrittenAt = this.options.clock.now();
    if (previous !== undefined) this.options.log.debug(() => `The session ended: ${previous.reason}`);
    this.options.log.debug(() => 'A new session started');
    const before = previous === undefined ? [] : this.ended(previous.session, undefined);
    if (this.options.emitEvents()) before.push({ kind: 'started', session: next });
    return { session: contextOf(next), before };
  }

  // An end found where no session starts (a hidden event, a tab becoming visible, page load): the
  // ended session is deleted and the cookie read back; `Session Ended` only when no other tab has
  // already replaced it (Web Session 2).
  private endWithoutSuccessor(view: View, session: SessionState, reason: string): SessionEvent[] {
    if (view.where === 'cookie' && view.text !== undefined) {
      const after = this.deleteCookie();
      if (after !== undefined && after.id !== session.id) {
        this.options.log.debug(() => 'Another page ended the session first');
        return [];
      }
      if (after !== undefined) this.refuse(undefined);
    }
    if (this.local?.id === session.id) this.local = undefined;
    this.options.log.debug(() => `The session ended: ${reason}`);
    return this.ended(session, undefined);
  }

  private ended(session: SessionState, identity: IdentitySnapshot | undefined): SessionEvent[] {
    if (!this.options.emitEvents()) return [];
    const durationMs = Math.max(0, session.lastActivity - session.startedAt);
    return [
      identity === undefined
        ? { kind: 'ended', session, durationMs }
        : { kind: 'ended', session, durationMs, identity },
    ];
  }

  // Activity at `time` in a live session: the last activity moves forward only, written when it must
  // be at once, on a page's first activity, and else at most every 30 seconds (Web Session 4, 5).
  private touch(view: View, session: SessionState, time: number, force: boolean): void {
    const next: SessionState = { ...session, lastActivity: Math.max(session.lastActivity, time) };
    if (view.where === 'memory') {
      this.local = next;
      return;
    }
    const now = this.options.clock.now();
    const since = this.lastWrittenAt;
    // A session carried over from memory (the cookie is empty) is written at once, so other tabs see it.
    const carried = view.text === undefined;
    const due = force || carried || since === undefined || now < since || now - since >= HEARTBEAT_MS;
    if (!due) return;
    this.lastWrittenAt = now;
    // Written without reading back: nothing depends on a heartbeat's outcome but the next write.
    try {
      this.write(encodeSessionCookie(next), SESSION_COOKIE_MAX_AGE_SECONDS);
      this.local = undefined;
    } catch (error) {
      this.refuse(next, error);
    }
  }

  // Removes `session` from where it lives; the cookie only while it still holds that session.
  private forget(view: View, session: SessionState): void {
    if (this.local?.id === session.id) this.local = undefined;
    if (view.where === 'cookie' && view.text !== undefined) this.deleteCookie();
  }

  /**
   * Writes the new session and reads the cookie back (Web Session 2): `own` when the write holds,
   * `other` with another tab's session written meanwhile, `failed` when it did not stick (cookies
   * blocked, refused by the browser, or the access threw), logged once per page.
   */
  private writeCookie(state: SessionState): WriteOutcome {
    const text = encodeSessionCookie(state);
    let values: string[] = [];
    let error: unknown;
    try {
      this.write(text, SESSION_COOKIE_MAX_AGE_SECONDS);
      values = cookieValues(this.options.cookies.readAll(), this.cookieName);
    } catch (caught) {
      error = caught;
    }
    // Cookies of one name in two scopes are listed both; the write held if one of them is ours.
    if (values.indexOf(text) >= 0) return { kind: 'own' };
    const other = values.map(decodeSessionCookie).filter((read) => read !== undefined)[0];
    if (error === undefined && other !== undefined && other.id !== state.id) return { kind: 'other', state: other };
    this.refuse(state, error);
    return { kind: 'failed' };
  }

  // Deletes the session cookie and reads it back: what it holds afterwards, `undefined` when gone.
  private deleteCookie(): SessionState | undefined {
    try {
      this.write('', 0);
      const first = cookieValues(this.options.cookies.readAll(), this.cookieName)[0];
      return first === undefined ? undefined : decodeSessionCookie(first);
    } catch (error) {
      this.options.log.error('STORAGE_WRITE_FAILED', () => 'Could not delete the session cookie', {
        error,
        repeatKey: LABEL,
      });
      return undefined;
    }
  }

  // A write of this page did not stick: the session lives in this page's memory for the rest of
  // the page load, as the identity does after a refused write (Web Identity 1).
  private refuse(state: SessionState | undefined, error?: unknown): void {
    this.cookieRefused = true;
    this.local = state;
    this.options.log.error(
      'STORAGE_WRITE_FAILED',
      () => 'Could not write the session cookie; this page keeps the session in memory',
      { error, repeatKey: LABEL },
    );
  }

  private write(value: string, maxAgeSeconds: number): void {
    this.options.cookies.write({
      name: this.cookieName,
      value,
      domain: this.options.cookieDomain(),
      path: '/',
      maxAgeSeconds,
      sameSite: 'Lax',
      secure: this.options.secure,
    });
  }

  private reportUnreadable(what: string, error: unknown): void {
    this.options.log.warn(
      'STORE_UNREADABLE',
      () => `${what}; this page keeps the session in memory and leaves the stored value untouched`,
      { error, repeatKey: LABEL },
    );
  }
}

// The session when it belongs to the identity cookie's person (Web Session 5).
function belonging(state: SessionState | undefined, personEpoch: string): SessionState | undefined {
  return state !== undefined && state.personEpoch === personEpoch ? state : undefined;
}

function contextOf(session: SessionState): SessionContext {
  return { id: session.id, startedAt: session.startedAt };
}
