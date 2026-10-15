import { readFileSync } from 'node:fs';
import { expect } from 'vitest';

// The structural comparison with the Android golden files (Web Event Model 4, Web Context 5), shared
// by the event model and the `SDK Diagnostics` tests; the golden loader of the testing package
// replaces it in step 8.4.

export type Json = Record<string, unknown>;

export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// The context fields the web never produces (Web Context 5): removed from the file before comparing.
const NEVER_ON_THE_WEB = [
  'app.build',
  'device.manufacturer',
  'device.model',
  'device.is_emulator',
  'os.version',
  'os.api_level',
  'network',
];

/** A golden file, parsed. */
export function golden(name: string): Json {
  return JSON.parse(readFileSync(new URL(`../fixtures/golden/${name}.json`, import.meta.url), 'utf8')) as Json;
}

/**
 * A web-only fixture (`test/fixtures/web/`): the wire shape of what the Android files cannot hold,
 * the `browser` and `page` groups of Web Context 5, pinned as a regression snapshot (Web Event Model
 * 4). Kept outside `golden/`, whose digest covers the Android copies only.
 */
export function webFixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`../fixtures/web/${name}.json`, import.meta.url), 'utf8')) as Json;
}

/**
 * The file as the web must produce it: the fields it never produces removed, and a group left empty
 * by that removed too.
 */
export function forTheWeb(file: Json): Json {
  const context: Json = {};
  for (const [group, value] of Object.entries(file.context as Json)) {
    if (NEVER_ON_THE_WEB.includes(group)) continue;
    if (typeof value !== 'object' || value === null) {
      context[group] = value;
      continue;
    }
    const kept = Object.entries(value).filter(([field]) => !NEVER_ON_THE_WEB.includes(`${group}.${field}`));
    if (kept.length > 0) context[group] = Object.fromEntries(kept);
  }
  return { ...file, context };
}

/**
 * The output made comparable, as the Android test does: the ids checked to be UUIDv7 and taken from
 * the file, the `library` group taken from the file, the web-only groups removed (pinned in the
 * event model test).
 */
export function comparable(text: string, file: Json): Json {
  const actual = JSON.parse(text) as Json;
  const context = actual.context as Json;
  const fileContext = file.context as Json;
  expect(actual.message_id).toMatch(UUID_V7);
  expect(actual.device_id).toMatch(UUID_V7);
  actual.message_id = file.message_id;
  actual.device_id = file.device_id;
  expect(context.library).toEqual({ name: 'rubicon-web', version: expect.any(String) as unknown });
  context.library = fileContext.library;
  delete context.browser;
  delete context.page;
  return actual;
}
