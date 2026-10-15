import type { ConfigSnapshot } from '../config/config-snapshot';
import type { HttpRequest } from '../platform/http-transport';
import { batchBody } from '../storage/chunk-store';
import { AUTHORIZATION, CONTENT_TYPE, IF_NONE_MATCH, isReservedHeader, JSON_CONTENT_TYPE } from './headers';

/** What the requests take from the validated configuration. */
export type RequestConfig = Pick<ConfigSnapshot, 'apiKey' | 'batchUrl' | 'configUrl' | 'headers'>;

/** One upload attempt, as the uploader decides it (step 6.4). */
export interface BatchRequestOptions {
  /** `sent_at`, epoch ms, rewritten on every attempt (Event Model 5). */
  readonly sentAt: number;
  /** The stored event lines, joined as they are, never serialized again (Web Disk 2). */
  readonly lines: readonly string[];
  /** The body fits the keepalive budget (Web Queue 5). */
  readonly keepalive: boolean;
  /**
   * Started from the hiding or `pagehide` handler: the body is never compressed, so the request
   * starts synchronously inside the handler (Web HTTP 2).
   */
  readonly closing: boolean;
}

/**
 * `POST {host}/v1/batch` (Web HTTP 1): `Authorization: Bearer {apiKey}`, the JSON content type, then
 * `network.headers`; `Content-Encoding` is the transport's, set only when it compressed. The key is
 * never in the body, and there is no SDK User-Agent or version header.
 */
export function batchRequest(config: RequestConfig, options: BatchRequestOptions): HttpRequest {
  const headers = sdkHeaders(config.apiKey);
  headers[CONTENT_TYPE] = JSON_CONTENT_TYPE;
  return {
    method: 'POST',
    url: config.batchUrl,
    headers: withCustomHeaders(headers, config.headers),
    body: batchBody(options.sentAt, options.lines),
    keepalive: options.keepalive,
    compress: !options.closing,
  };
}

/**
 * `GET {host}/v1/config` (Web HTTP 1, Configuration 1): `Authorization`, `If-None-Match` with the
 * saved `ETag` when there is one, then `network.headers`; no body, so nothing to compress, and no
 * `keepalive`. The SDK keeps the `ETag` itself, so the transport sends it with `cache: "no-store"`.
 */
export function configRequest(config: RequestConfig, etag: string | undefined): HttpRequest {
  const headers = sdkHeaders(config.apiKey);
  if (etag !== undefined) headers[IF_NONE_MATCH] = etag;
  return {
    method: 'GET',
    url: config.configUrl,
    headers: withCustomHeaders(headers, config.headers),
    keepalive: false,
    compress: false,
  };
}

// Null-prototype objects, so a header named `__proto__` is a header and never the prototype.
function sdkHeaders(apiKey: string): Record<string, string> {
  const headers = Object.create(null) as Record<string, string>;
  headers[AUTHORIZATION] = `Bearer ${apiKey}`;
  return headers;
}

// Validation already removed reserved names (Configuration 5); dropping them again keeps the SDK's
// own headers authoritative here too, as the Android transport does.
function withCustomHeaders(
  headers: Record<string, string>,
  custom: Readonly<Record<string, string>>,
): Readonly<Record<string, string>> {
  for (const name of Object.keys(custom)) {
    const value = custom[name];
    if (value !== undefined && !isReservedHeader(name)) headers[name] = value;
  }
  return headers;
}
