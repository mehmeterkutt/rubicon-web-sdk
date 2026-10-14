import type { Clock } from './clock';
import type { ContextProvider } from './context-provider';
import type { CookieJar } from './cookie-jar';
import type { HttpTransport } from './http-transport';
import type { KeyValueStorage } from './key-value-storage';
import type { LifecycleSource } from './lifecycle-source';
import type { NetworkSignal } from './network-signal';
import type { PageScheme, UrlParser } from './page';
import type { RandomSource } from './random';
import type { Scheduler } from './scheduler';

/**
 * Everything the core takes from its environment, in one place (Configuration 5). `web` builds the
 * browser instance in `createAnalytics`; tests build one from `TestPlatform` and pass it to the core
 * factory. Nothing here is replaceable by developers, and nothing in the core reaches a browser
 * global except through it (rule `browser-global`).
 */
export interface Platform {
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly storage: KeyValueStorage;
  readonly cookies: CookieJar;
  readonly transport: HttpTransport;
  readonly lifecycle: LifecycleSource;
  readonly network: NetworkSignal;
  readonly context: ContextProvider;
  readonly scheduler: Scheduler;
  /** The page's scheme, read once when the platform is made (Web Configuration 4). */
  readonly pageScheme: PageScheme;
  readonly urls: UrlParser;
}
