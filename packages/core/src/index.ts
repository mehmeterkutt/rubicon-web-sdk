// The surface of the core for the web and testing packages. Only what packages/web/src/index.ts
// re-exports is public (Web Public API 7); everything else exported here stays internal.

export * from './config';
export * from './context';
export type { BeforeSend } from './event/before-send';
export type { Event } from './event/event';
export * from './http';
export * from './json';
export * from './log';
export * from './platform';
export * from './util';
export * from './validation';
export { SDK_VERSION } from './version';
