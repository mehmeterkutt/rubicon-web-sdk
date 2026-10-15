// The platform interfaces of the core (plan section 4): implemented in `web` for the browser and in
// `rubicon-analytics-testing` with fakes. Internal; none of them is re-exported by `web`.
export type { Clock } from './clock';
export type {
  CallTimeContextRequest,
  CallTimeContextValues,
  ContextProvider,
  DeviceType,
  DisabledContextFields,
  StaticContextValues,
} from './context-provider';
export type { CookieJar, CookieSameSite, CookieWrite } from './cookie-jar';
export type { HttpCall, HttpMethod, HttpOutcome, HttpRequest, HttpTransport } from './http-transport';
export type { KeyValueStorage } from './key-value-storage';
export type { LifecycleEvent, LifecycleSource, Unsubscribe } from './lifecycle-source';
export type { NetworkSignal } from './network-signal';
export type { PageScheme, ParsedUrl, UrlParser } from './page';
export type { Platform } from './platform';
export type { RandomSource } from './random';
export type { ScheduledTask, Scheduler } from './scheduler';
