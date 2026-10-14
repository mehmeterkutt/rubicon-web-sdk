import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SDK_VERSION } from '../src';

describe('SDK_VERSION', () => {
  it('is the version of the published package', () => {
    const web = JSON.parse(readFileSync(new URL('../../web/package.json', import.meta.url), 'utf8')) as {
      version: string;
    };
    expect(SDK_VERSION).toBe(web.version);
  });
});
