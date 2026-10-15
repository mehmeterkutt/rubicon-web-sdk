import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The golden loader (Web Event Model 4, Web Context 5; step 8.4): the Android golden wire files,
// copied verbatim into `packages/core/test/fixtures/golden` by `scripts/refresh-golden.sh`, the web
// fixtures beside them in `fixtures/web`, and the structural comparison the Android
// `GoldenFilesTest` makes. Paths are built from this file's location with Node's own path functions,
// never the global `URL`, which is jsdom's in the web unit tests.

/** A parsed JSON object. */
export type JsonObject = Record<string, unknown>;

/** A lowercase UUIDv7, as `message_id`, `device_id` and `session.id` are (Event Model 4). */
export const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The thirteen files of the Android set (`GoldenFilesTest.EXPECTED_FILES`), in its order. */
export const GOLDEN_FILES = [
  'track',
  'screen',
  'identify',
  'sdk-diagnostics',
  'envelope',
  'application-installed',
  'application-updated',
  'application-opened',
  'application-backgrounded',
  'session-started',
  'session-ended',
  'deep-link-opened',
  'network-request',
] as const;

/** The name of an Android golden file, without `.json`. */
export type GoldenName = (typeof GOLDEN_FILES)[number];

/**
 * The context fields the web never produces (Web Context 5): removed from an Android file before it
 * is compared, a group left empty by that removed too. `network` is the whole group.
 */
export const NEVER_ON_THE_WEB: readonly string[] = [
  'app.build',
  'device.manufacturer',
  'device.model',
  'device.is_emulator',
  'os.version',
  'os.api_level',
  'network',
];

/** The groups only the web writes (Web Context 1, 2), absent from the Android files. */
export const WEB_ONLY_GROUPS: readonly string[] = ['browser', 'page'];

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'core', 'test', 'fixtures');

/** The directory of the Android copies. */
export const GOLDEN_DIRECTORY = join(FIXTURES, 'golden');

/** The directory of the web fixtures, outside `golden/`, whose digest covers the Android copies only. */
export const WEB_FIXTURE_DIRECTORY = join(FIXTURES, 'web');

/** The names of the `.json` files the golden directory holds now, sorted. */
export function goldenFileNames(): string[] {
  return readdirSync(GOLDEN_DIRECTORY)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

/** The names of the web fixtures, sorted. */
export function webFixtureNames(): string[] {
  return readdirSync(WEB_FIXTURE_DIRECTORY)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.slice(0, -'.json'.length))
    .sort();
}

/** A golden file's text as copied. */
export function goldenText(name: GoldenName): string {
  return readFileSync(join(GOLDEN_DIRECTORY, `${name}.json`), 'utf8');
}

/** A golden file, parsed. */
export function golden(name: GoldenName): JsonObject {
  return asObject(JSON.parse(goldenText(name)), name);
}

/** A web fixture's text. */
export function webFixtureText(name: string): string {
  return readFileSync(join(WEB_FIXTURE_DIRECTORY, `${name}.json`), 'utf8');
}

/**
 * A web fixture (`fixtures/web/`), parsed: the wire shape of what the Android files cannot hold, the
 * `Page Viewed` event and the `browser` and `page` groups, pinned as a regression snapshot (Web Event
 * Model 4).
 */
export function webFixture(name: string): JsonObject {
  return asObject(JSON.parse(webFixtureText(name)), name);
}

/**
 * An Android file as the web must produce it: the fields of {@link NEVER_ON_THE_WEB} removed, and a
 * group left empty by that removed too.
 */
export function forTheWeb(file: JsonObject): JsonObject {
  const context: JsonObject = {};
  for (const [group, value] of Object.entries(asObject(file.context, 'context'))) {
    if (NEVER_ON_THE_WEB.includes(group)) continue;
    if (typeof value !== 'object' || value === null) {
      context[group] = value;
      continue;
    }
    const kept: JsonObject = {};
    for (const [field, fieldValue] of Object.entries(value)) {
      if (!NEVER_ON_THE_WEB.includes(`${group}.${field}`)) kept[field] = fieldValue;
    }
    if (Object.keys(kept).length > 0) context[group] = kept;
  }
  return { ...file, context };
}

/** What {@link withStableValuesOf} does besides taking the values of the file. */
export interface StableValuesOptions {
  /**
   * Keep `browser` and `page` in the output: for a web fixture, which holds them. An Android file
   * does not, so they are removed by default and pinned by the web fixtures instead.
   */
  readonly keepWebGroups?: boolean;
}

/**
 * The SDK's output made comparable with `file`, as the Android test does: `message_id`, `device_id`
 * and `context.session.id` must be UUIDv7 and are taken from the file, `context.library` must be
 * `rubicon-web` with a version and is taken from the file; the web-only groups are removed unless
 * asked otherwise. Throws when an id or the library is wrong, so the test fails there.
 */
export function withStableValuesOf(
  file: JsonObject,
  actual: JsonObject,
  options: StableValuesOptions = {},
): JsonObject {
  requireUuid(actual.message_id, 'message_id');
  requireUuid(actual.device_id, 'device_id');
  const context: JsonObject = { ...asObject(actual.context, 'context') };
  const fileContext = asObject(file.context, 'the file context');
  const session = context.session;
  if (session !== undefined) {
    const own = asObject(session, 'context.session');
    requireUuid(own.id, 'context.session.id');
    context.session = { ...own, id: asObject(fileContext.session, 'the file session').id };
  }
  const library = asObject(context.library, 'context.library');
  if (library.name !== 'rubicon-web' || typeof library.version !== 'string' || library.version === '') {
    throw new Error(`context.library is not rubicon-web with a version: ${JSON.stringify(library)}`);
  }
  context.library = fileContext.library;
  const kept: JsonObject = {};
  for (const [group, value] of Object.entries(context)) {
    if (options.keepWebGroups === true || !WEB_ONLY_GROUPS.includes(group)) kept[group] = value;
  }
  return { ...actual, message_id: file.message_id, device_id: file.device_id, context: kept };
}

function requireUuid(value: unknown, name: string): void {
  if (typeof value !== 'string' || !UUID_V7.test(value)) throw new Error(`${name} is not a UUIDv7: ${String(value)}`);
}

function asObject(value: unknown, name: string): JsonObject {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${name} is not an object`);
  return value as JsonObject;
}
