// The snippet's published values (Web HTTP 6, D16; plan step 7.8), written to dist/snippet.json after
// the script build:
//   stub       the stub's text (src/snippet/stub.js without its final line break), pasted as the
//              content of the snippet's first tag, frozen like any public API
//   stubHash   its CSP hash, `sha256-<base64>`, for `script-src`; it changes only when the stub does
//   integrity  the SRI hash of dist/rubicon.min.js, `sha384-<base64>`, for the second tag
//   version    the SDK version of that file
// The release (step 8.6) publishes them with the version-pinned URL; nothing is published here.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { sdkVersion } from '../../../scripts/sdk-version.mjs';

/** The stub's text as it is pasted: the file without its final line break. */
export function stubText() {
  return readFileSync(new URL('../src/snippet/stub.js', import.meta.url), 'utf8').replace(/\r?\n$/, '');
}

/** `sha256-<base64>` of `text` in UTF-8, the form CSP takes. */
export function cspHash(text) {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/** `sha384-<base64>` of `bytes`, the form the `integrity` attribute takes. */
export function sriHash(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const stub = stubText();
  const script = readFileSync(new URL('../dist/rubicon.min.js', import.meta.url));
  const values = { version: sdkVersion(), stub, stubHash: cspHash(stub), integrity: sriHash(script) };
  writeFileSync(new URL('../dist/snippet.json', import.meta.url), `${JSON.stringify(values, null, 2)}\n`);
}
