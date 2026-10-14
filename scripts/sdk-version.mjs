// The single source of the SDK version (D5): the version field of the published package.
import { readFileSync } from 'node:fs';

const webPackage = new URL('../packages/web/package.json', import.meta.url);

/** @returns {string} */
export function sdkVersion() {
  return JSON.parse(readFileSync(webPackage, 'utf8')).version;
}
