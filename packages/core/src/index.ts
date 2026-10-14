// The surface of the core for the web and testing packages. Only what packages/web/src/index.ts
// re-exports is public (Web Public API 7); everything else exported here stays internal.

export * from './platform';
export { SDK_VERSION } from './version';
