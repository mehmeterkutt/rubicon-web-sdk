// The surface of the core for the web and testing packages. Only what packages/web/src/index.ts
// re-exports is public (Web Public API 7); everything else exported here stays internal.

export type { Event } from './event/event';
export * from './json';
export * from './log';
export * from './platform';
export * from './util';
export * from './validation';
export { SDK_VERSION } from './version';
