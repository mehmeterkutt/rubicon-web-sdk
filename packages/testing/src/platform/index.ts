// The fakes of the core's platform interfaces (step 2.1).
export { quotaExceededError, securityError } from './dom-exception';
export { FakeContextProvider } from './fake-context-provider';
export { FakeLifecycleSource, FakeNetworkSignal } from './fake-signals';
export { FakeTransport, SUCCESS } from './fake-transport';
export type { DelayedResult, SentRequest } from './fake-transport';
export { MemoryCookieJar, MemoryCookieStore } from './memory-cookie-jar';
export type { CookiePage, MemoryCookieStoreOptions, StoredCookie } from './memory-cookie-jar';
export { MemoryStorage, MemoryStorageArea } from './memory-storage';
export type { MemoryStorageAreaOptions } from './memory-storage';
export { SeededRandom } from './seeded-random';
export { TestClock } from './test-clock';
export { TestPlatform } from './test-platform';
export type { TestPlatformOptions } from './test-platform';
export { TestScheduler } from './test-scheduler';
