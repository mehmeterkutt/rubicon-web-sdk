// The JSON layer and the size scan (step 2.4): the port of the Android `internal/json` package, the
// only code that calls `JSON.stringify` and `JSON.parse` (Web Serialization 1, source rule `json`).
export { checkLine, JsonFields, mergeJsonObject, readJsonObject, writeJson } from './json';
export type { JsonObject, JsonValue, StoredLine } from './json';
export { utf8ByteLength } from './utf8-byte-length';
