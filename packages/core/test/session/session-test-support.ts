import {
  FakeLifecycleSource,
  MemoryCookieJar,
  MemoryCookieStore,
  MemoryStorage,
  SeededRandom,
  TestClock,
} from 'rubicon-analytics-testing';
import { decodeSessionCookie, SessionManager, sessionCookieName, UuidV7Generator } from '../../src';
import type { SessionEvent, SessionOutcome, SessionState, StoreAccess } from '../../src';
import { openIdentityPage } from '../identity/identity-test-support';
import type { IdentityPage } from '../identity/identity-test-support';
import { KEY_HASH } from '../storage/store-test-support';

export const SESSION_COOKIE = sessionCookieName(KEY_HASH);

/** 30 minutes, the default of `session.inactivityTimeoutMs` (Web Session 3). */
export const TIMEOUT = 30 * 60 * 1000;

/** One simulated page: its identity and sessions over a cookie store shared with other pages. */
export interface SessionPage extends IdentityPage {
  readonly sessions: SessionManager;
  readonly lifecycle: FakeLifecycleSource;
  readonly clock: TestClock;
  /** Every session event this page produced, in order: at events, lifecycle changes, person changes. */
  readonly events: SessionEvent[];
  /** An event from this page now (or at `time`, a call the snippet queued), visible as the page is. */
  event(time?: number, visible?: boolean): SessionOutcome;
  /** The page-load evaluation; its events join {@link events}. */
  load(): SessionEvent[];
  /** The identity cookie's current epoch, as every call reads it. */
  epoch(): string;
  /** How many session cookie writes (deletes included) this page made. */
  sessionWrites(): number;
}

/** Options of {@link openSessionPage}. */
export interface SessionPageOptions {
  readonly storage?: MemoryStorage;
  readonly seed?: number;
  readonly visible?: boolean;
  readonly emitEvents?: boolean;
  readonly timeout?: number;
  readonly access?: StoreAccess['level'];
  readonly domain?: string;
}

/** A browser profile: one cookie store on a clock, the page on `https://a.rubicon.test/`. */
export function browser(page: { readonly host?: string; readonly secure?: boolean } = {}): MemoryCookieJar {
  return new MemoryCookieJar(new MemoryCookieStore(new TestClock()), page);
}

/**
 * Opens a page as the core factory will (step 6.7): the identity of step 6.1 and the session
 * manager over the same cookie jar and clock, the identity's person change wired to the session, and
 * the lifecycle source wired to {@link SessionManager.onLifecycle}.
 */
export function openSessionPage(jar: MemoryCookieJar, options: SessionPageOptions = {}): SessionPage {
  const clock = jar.store.clock as TestClock;
  const lifecycle = new FakeLifecycleSource(options.visible ?? true);
  const events: SessionEvent[] = [];
  const holder: { sessions?: SessionManager } = {};
  const page = openIdentityPage(jar, {
    storage: options.storage,
    seed: options.seed,
    access: options.access,
    domain: options.domain,
    onPersonCleared: (previous) => {
      events.push(...(holder.sessions?.onPersonCleared(previous, lifecycle.isVisible()) ?? []));
    },
  });
  const sessions = new SessionManager({
    keyHash: KEY_HASH,
    cookies: page.cookies,
    clock,
    ids: new UuidV7Generator(clock, new SeededRandom((options.seed ?? 1) + 100)),
    log: page.log,
    inactivityTimeoutMs: options.timeout ?? TIMEOUT,
    emitEvents: () => options.emitEvents ?? true,
    secure: jar.secure,
    cookieDomain: () => options.domain,
    accessLevel: () => page.stores.accessLevel,
  });
  holder.sessions = sessions;
  const epoch = (): string => page.identity.snapshot().personEpoch;
  lifecycle.subscribe((event) => {
    events.push(...sessions.onLifecycle(event, epoch()));
  });
  const sessionWrites = (): number => page.cookies.writes.filter((write) => write.name === SESSION_COOKIE).length;
  return {
    ...page,
    sessions,
    lifecycle,
    clock,
    events,
    epoch,
    sessionWrites,
    event(time, visible) {
      const outcome = sessions.onEvent(
        { time: time ?? clock.now(), visible: visible ?? lifecycle.isVisible() },
        epoch(),
      );
      events.push(...outcome.before);
      return outcome;
    },
    load() {
      const found = sessions.start(epoch());
      events.push(...found);
      return found;
    },
  };
}

/** Another tab of `first`'s origin (or of another host): the same cookies and storage, its own memory. */
export function otherTab(
  first: SessionPage,
  options: SessionPageOptions & { readonly host?: string } = {},
): SessionPage {
  const jar = first.cookies.jar.otherPage(options.host === undefined ? {} : { host: options.host });
  const storage = options.host === undefined ? first.storage.otherPage() : new MemoryStorage();
  return openSessionPage(jar, { storage, seed: (options.seed ?? 1) + 1, ...options });
}

/** The session cookie as the page's jar holds it; `undefined` when missing or invalid. */
export function sessionCookie(page: SessionPage): SessionState | undefined {
  const raw = rawSessionCookie(page);
  return raw === undefined ? undefined : decodeSessionCookie(raw);
}

/** The session cookie's raw value; `undefined` when there is none. */
export function rawSessionCookie(page: SessionPage): string | undefined {
  const pair = page.cookies.jar
    .readAll()
    .split('; ')
    .find((text) => text.startsWith(`${SESSION_COOKIE}=`));
  return pair?.slice(SESSION_COOKIE.length + 1);
}

/** The kinds of `events`, `started` and `ended`, for short assertions. */
export function kinds(events: readonly SessionEvent[]): string[] {
  return events.map((event) => event.kind);
}

/** The single `Session Ended` of `events`. */
export function endedOf(events: readonly SessionEvent[]): Extract<SessionEvent, { kind: 'ended' }> {
  const ended = events.filter((event): event is Extract<SessionEvent, { kind: 'ended' }> => event.kind === 'ended');
  const only = ended[0];
  if (ended.length !== 1 || only === undefined) {
    throw new Error(`expected one Session Ended, got ${String(ended.length)}`);
  }
  return only;
}
