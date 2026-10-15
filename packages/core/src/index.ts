// The surface of the core for the web and testing packages. Only what packages/web/src/index.ts
// re-exports is public (Web Public API 7); everything else exported here stays internal.

export type { Analytics } from './analytics';
export type { AutomaticCapture, CaptureMoment } from './automatic-capture';
export * from './config';
export * from './context';
export { DefaultAnalytics } from './default-analytics';
export type { CoreOptions, DefaultAnalyticsParts } from './default-analytics';
export * from './diagnostics';
export * from './event';
export * from './http';
export * from './identity';
export * from './json';
export * from './log';
export { createNoOpAnalytics } from './no-op-analytics';
export * from './pipeline';
export * from './platform';
export * from './privacy';
export * from './queue';
export * from './remote';
export * from './retry';
export { captureOf, coreOf, createCore, flushAndWait, shutdown } from './rubicon-core';
export type { CreateCoreOptions } from './rubicon-core';
export * from './session';
export * from './storage';
export * from './util';
export * from './validation';
export { SDK_VERSION } from './version';
