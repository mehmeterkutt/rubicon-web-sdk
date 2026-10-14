import type { HttpResult, Platform } from 'rubicon-analytics-core';
import { FakeContextProvider } from './fake-context-provider';
import { FakeLifecycleSource, FakeNetworkSignal } from './fake-signals';
import { FakeTransport } from './fake-transport';
import type { CookiePage, MemoryCookieStoreOptions } from './memory-cookie-jar';
import { MemoryCookieJar, MemoryCookieStore } from './memory-cookie-jar';
import type { MemoryStorageAreaOptions } from './memory-storage';
import { MemoryStorage, MemoryStorageArea } from './memory-storage';
import { SeededRandom } from './seeded-random';
import { TestClock } from './test-clock';
import { TestScheduler } from './test-scheduler';

/** Options of a {@link TestPlatform}; every part has a default. */
export interface TestPlatformOptions {
  /** The clock's start, `TestClock.DEFAULT_START` when absent. */
  readonly now?: number;
  /** The random seed of this page. */
  readonly seed?: number;
  readonly storage?: MemoryStorageAreaOptions;
  readonly cookieStore?: MemoryCookieStoreOptions;
  /** The page's host, scheme and path for the cookies; `https://a.rubicon.test/` by default. */
  readonly page?: CookiePage;
  /** Whether the page starts visible; `true` by default. */
  readonly visible?: boolean;
  /** Whether the browser starts online; `true` by default. */
  readonly online?: boolean;
  /** The transport's answer once its script is used up. */
  readonly whenEmpty?: HttpResult;
}

/** What a second page shares with the first: the browser, so everything but the page itself. */
interface SharedBrowser {
  readonly clock: TestClock;
  readonly scheduler: TestScheduler;
  readonly storageArea: MemoryStorageArea;
  readonly cookieStore: MemoryCookieStore;
  readonly network: FakeNetworkSignal;
}

/**
 * A `Platform` made of fakes, each kept as a field so the test can drive it, the counterpart of the
 * Android and iOS `TestPlatform`:
 *
 * ```ts
 * const test = new TestPlatform();
 * test.transport.enqueue({ kind: 'http-error', status: 503 });
 * // test.platform goes to the component under test, or to the core factory (step 6.7)
 * test.scheduler.advanceBy(5_000);
 * ```
 *
 * {@link otherPage} opens a second page of the same browser: it shares the clock, the scheduler's
 * virtual time, the origin's storage, the cookie store and the network state, and has its own
 * visibility, random sequence, transport and context, as two tabs do (plan section 5).
 */
export class TestPlatform {
  readonly clock: TestClock;
  readonly scheduler: TestScheduler;
  readonly random: SeededRandom;
  readonly storage: MemoryStorage;
  readonly cookies: MemoryCookieJar;
  readonly transport: FakeTransport;
  readonly lifecycle: FakeLifecycleSource;
  readonly network: FakeNetworkSignal;
  readonly context: FakeContextProvider;
  readonly platform: Platform;

  constructor(options: TestPlatformOptions = {}, shared?: SharedBrowser) {
    this.clock = shared?.clock ?? new TestClock(options.now);
    this.scheduler = shared?.scheduler ?? new TestScheduler(this.clock);
    this.random = new SeededRandom(options.seed);
    this.storage = new MemoryStorage(shared?.storageArea ?? new MemoryStorageArea(options.storage));
    this.cookies = new MemoryCookieJar(shared?.cookieStore ?? new MemoryCookieStore(this.clock, options.cookieStore), {
      ...options.page,
    });
    this.transport = new FakeTransport(this.scheduler, options.whenEmpty);
    this.lifecycle = new FakeLifecycleSource(options.visible);
    this.network = shared?.network ?? new FakeNetworkSignal(options.online);
    this.context = new FakeContextProvider();
    this.platform = {
      clock: this.clock,
      random: this.random,
      storage: this.storage,
      cookies: this.cookies,
      transport: this.transport,
      lifecycle: this.lifecycle,
      network: this.network,
      context: this.context,
      scheduler: this.scheduler,
    };
  }

  /**
   * A second page of the same browser. Its cookies default to this page's host, scheme and path; its
   * random seed defaults to this page's plus one, so the two pages draw different page ids.
   */
  otherPage(options: Pick<TestPlatformOptions, 'seed' | 'page' | 'visible' | 'whenEmpty'> = {}): TestPlatform {
    return new TestPlatform(
      {
        seed: options.seed ?? this.random.seed + 1,
        page: { host: this.cookies.host, secure: this.cookies.secure, path: this.cookies.path, ...options.page },
        visible: options.visible,
        whenEmpty: options.whenEmpty,
      },
      {
        clock: this.clock,
        scheduler: this.scheduler,
        storageArea: this.storage.area,
        cookieStore: this.cookies.store,
        network: this.network,
      },
    );
  }
}
