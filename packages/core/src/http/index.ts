// HTTP (step 5.1): the requests of Web HTTP 1, the result model and the classification table of
// Web HTTP 3, `Retry-After`, the 45-second deadline and the DEBUG line; the reserved header names the
// configuration checks (step 3.1). The `fetch` transport under it is `web`'s (step 7.3).
export { classifyOutcome, MAX_CONFIG_BODY_BYTES, MAX_ERROR_BODY_BYTES } from './classify';
export type { ClassifyContext } from './classify';
export { headerValue, isReservedHeader, REQUEST_ID } from './headers';
export { HttpClient, REQUEST_TIMEOUT_MS } from './http-client';
export type { HttpClientOptions } from './http-client';
export type { FailureKind, HttpResult } from './http-result';
export { batchRequest, configRequest } from './requests';
export type { BatchRequestOptions, RequestConfig } from './requests';
export { parseRetryAfter } from './retry-after';
