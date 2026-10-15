import { MemoryStorage, SeededRandom } from 'rubicon-analytics-testing';
import type { MemoryCookieJar, TestClock } from 'rubicon-analytics-testing';
import { decodeIdentityCookie, Identity, identityCookieName, UuidV7Generator } from '../../src';
import type { CookieJar, CookieWrite, IdentityCookieValue, IdentitySnapshot, LogLevel, StoreAccess } from '../../src';
import { KEY_HASH, openPage } from '../storage/store-test-support';
import type { TestPage } from '../storage/store-test-support';

export const COOKIE_NAME = identityCookieName(KEY_HASH);

/**
 * A cookie jar over a {@link MemoryCookieJar} that counts writes and runs a test's hook at a chosen
 * point once, to interleave another page's work with this page's (Web Identity 3).
 */
export class HookedCookieJar implements CookieJar {
  writes: CookieWrite[] = [];
  reads = 0;
  /** Runs once before the read with this number (from 1). */
  beforeRead: { readonly at: number; readonly run: () => void } | undefined;
  /** Runs once before the next write reaches the jar. */
  beforeWrite: (() => void) | undefined;
  /** Runs once after the next write reached the jar. */
  afterWrite: (() => void) | undefined;

  constructor(readonly jar: MemoryCookieJar) {}

  readAll(): string {
    this.reads += 1;
    const hook = this.beforeRead;
    if (hook !== undefined && hook.at === this.reads) {
      this.beforeRead = undefined;
      hook.run();
    }
    return this.jar.readAll();
  }

  write(cookie: CookieWrite): void {
    this.writes.push(cookie);
    const before = this.beforeWrite;
    this.beforeWrite = undefined;
    before?.();
    this.jar.write(cookie);
    const after = this.afterWrite;
    this.afterWrite = undefined;
    after?.();
  }

  /** The identity cookie's raw value as this page sees it; `undefined` when there is none. */
  raw(): string | undefined {
    const pair = this.jar
      .readAll()
      .split('; ')
      .find((text) => text.startsWith(`${COOKIE_NAME}=`));
    return pair?.slice(COOKIE_NAME.length + 1);
  }

  /** The identity cookie's contents; `undefined` when missing or invalid. */
  value(): IdentityCookieValue | undefined {
    const raw = this.raw();
    return raw === undefined ? undefined : decodeIdentityCookie(raw);
  }

  /** Writes the identity cookie's raw value as another script or SDK version would. */
  plant(value: string): void {
    this.jar.write({ name: COOKIE_NAME, value, path: '/', maxAgeSeconds: 3600, sameSite: 'Lax', secure: true });
  }
}

/** One simulated page with its identity, over a cookie store and a storage area shared with others. */
export interface IdentityPage extends TestPage {
  readonly identity: Identity;
  readonly cookies: HookedCookieJar;
  /** The identities `onPersonCleared` received, in order. */
  readonly cleared: IdentitySnapshot[];
  /** How often the identity asked the writer to persist. */
  readonly persistRequests: () => number;
  /** How many device ids this page's generator made. */
  readonly generated: () => number;
  readonly hooks: PageHooks;
}

/** What a test changes while a page runs. */
export interface PageHooks {
  /** Runs once when this page's generator makes its next id, before it returns. */
  onGenerate: (() => void) | undefined;
  /** Whether events are allowed (`false` while opted out). */
  eventsAllowed: boolean;
  /** Whether consent is refused, so the page reads the identity cookie without access (step 6.5). */
  refused: boolean;
}

/** Options of {@link openIdentityPage}. */
export interface IdentityPageOptions {
  readonly storage?: MemoryStorage;
  readonly clock?: TestClock;
  readonly seed?: number;
  readonly level?: LogLevel;
  readonly debug?: boolean;
  readonly access?: StoreAccess['level'];
  readonly domain?: string;
  /** Called after the identity is recorded in `cleared`, as the session does (step 6.2). */
  readonly onPersonCleared?: (previous: IdentitySnapshot) => void;
}

/**
 * Opens a page's identity as the core factory will (step 6.7): the stores of `openPage`, the cookie
 * jar of the page, a UUIDv7 generator on the shared clock and a seeded random source.
 */
export function openIdentityPage(jar: MemoryCookieJar, options: IdentityPageOptions = {}): IdentityPage {
  const clock = options.clock ?? (jar.store.clock as TestClock);
  const page = openPage(options.storage ?? new MemoryStorage(), clock, {
    level: options.level,
    access: options.access,
    debug: options.debug,
  });
  const random = new SeededRandom(options.seed ?? 1);
  const generator = new UuidV7Generator(clock, random);
  const cookies = new HookedCookieJar(jar);
  const cleared: IdentitySnapshot[] = [];
  let persistRequests = 0;
  let generated = 0;
  const hooks: PageHooks = { onGenerate: undefined, eventsAllowed: true, refused: false };
  const identity = new Identity({
    keyHash: KEY_HASH,
    cookies,
    stores: page.stores,
    log: page.log,
    ids: {
      next: () => {
        generated += 1;
        const hook = hooks.onGenerate;
        hooks.onGenerate = undefined;
        hook?.();
        return generator.next();
      },
    },
    random,
    secure: jar.secure,
    cookieDomain: () => options.domain,
    eventsAllowed: () => hooks.eventsAllowed,
    refused: () => hooks.refused,
    requestPersist: () => {
      persistRequests += 1;
    },
    onPersonCleared: (previous) => {
      cleared.push(previous);
      options.onPersonCleared?.(previous);
    },
  });
  return {
    ...page,
    identity,
    cookies,
    cleared,
    hooks,
    persistRequests: () => persistRequests,
    generated: () => generated,
  };
}
