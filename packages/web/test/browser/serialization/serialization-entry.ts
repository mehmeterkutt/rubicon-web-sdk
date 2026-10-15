// The entry of the test-only bundle that the serialization spec loads into each engine (step 8.1,
// Web Serialization 3): the core's normalizer, writer, size scan and ISO formatter, the same code the
// script build carries, installed as `window.__serialization`. Built by ../global-setup.ts into
// `temp/`, never shipped.
import {
  MAX_EVENT_BYTES,
  formatIsoDate,
  isOversizeLine,
  normalizeProperties,
  utf8ByteLength,
  writeJson,
} from 'rubicon-analytics-core';

/** What the bundle gives the page. */
export interface SerializationApi {
  readonly MAX_EVENT_BYTES: number;
  readonly formatIsoDate: typeof formatIsoDate;
  readonly isOversizeLine: typeof isOversizeLine;
  readonly normalizeProperties: typeof normalizeProperties;
  readonly utf8ByteLength: typeof utf8ByteLength;
  readonly writeJson: typeof writeJson;
}

const api: SerializationApi = {
  MAX_EVENT_BYTES,
  formatIsoDate,
  isOversizeLine,
  normalizeProperties,
  utf8ByteLength,
  writeJson,
};
Reflect.set(window, '__serialization', api);
