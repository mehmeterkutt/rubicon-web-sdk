// The test server of D14, its own entry point (`rubicon-analytics-testing/server`) so that the
// Playwright configuration and fixtures load it without the core fakes.
export {
  CORS_ALLOW_HEADERS,
  CORS_ALLOW_METHODS,
  CORS_EXPOSE_HEADERS,
  CORS_MAX_AGE_SECONDS,
  preflightHeaders,
  responseCorsHeaders,
} from './cors';
export {
  API_PATH_PREFIX,
  DROPPED,
  LOOPBACK_HOST,
  TEST_HOST_A,
  TEST_HOST_B,
  TEST_SITE,
  TestServer,
  redirectTo,
} from './test-server';
export type { RecordedRequest, ScriptedResponse, TestServerOptions } from './test-server';
