// Test support of the web package, outside the `exports` map and never bundled (Web Configuration 3,
// Web Public API 7): unit tests import it by path. Nothing here is public API.

export { resetForTests } from './create-analytics';
