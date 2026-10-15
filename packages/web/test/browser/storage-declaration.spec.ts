import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { BrowserContext, Page } from '@playwright/test';
import { TEST_HOST_A, expect, test } from './fixtures';
import { appEvent, call, chunksReach, deviceIdOf, flushUntilSent, lineMatching, openTab, pagehide } from './multi/tabs';

// The storage declaration test of Web Privacy 5 (step 8.3): every flow runs in a real engine, every
// cookie and storage name the page writes or holds is listed, and any name that
// docs/storage-declaration.md does not list fails the test. The names come from the declaration's
// first table, read from the file, so the document is the one source; a placeholder the test does
// not know fails too, so the table stays checkable.
//
// What is listed: every name the page writes, recorded by an init script around
// `Storage.prototype.setItem` and the `document.cookie` setter (so the two probes, which live for an
// instant, are seen), and after each flow what the origin's `localStorage` and `sessionStorage`, the
// context's cookies and IndexedDB hold. The recorder is test code in the page; the SDK is the script
// build, as the several-tab specs load it (test/browser/multi/tabs.ts).

const declarationFile = fileURLToPath(new URL('../../../../docs/storage-declaration.md', import.meta.url));

/** Where a name lives; `other` is anything the declaration never allows (`sessionStorage`, IndexedDB). */
type Place = 'cookie' | 'localStorage' | 'sessionStorage' | 'indexedDB';

/** One name the page wrote or holds. */
interface Observed {
  readonly place: Place;
  readonly name: string;
}

/** One row of the declaration's first table. */
interface Declared {
  readonly name: string;
  readonly place: 'cookie' | 'localStorage';
}

/** The placeholders of the declaration's names, as patterns (Web Identity 4, Web Disk 2). */
const PLACEHOLDERS: Readonly<Record<string, string>> = {
  uuid: '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}',
  pageId: '[0-9a-f]{16}',
  writtenAt: '(?:0|[1-9][0-9]*)',
  newestEventAt: '(?:0|[1-9][0-9]*)',
  seq: '(?:0|[1-9][0-9]*)',
  count: '(?:0|[1-9][0-9]*)',
  chars: '(?:0|[1-9][0-9]*)',
};

/** The rows of the declaration's first table (`| Name | Type | ...`): the name and where it lives. */
function readDeclaration(): Declared[] {
  const lines = readFileSync(declarationFile, 'utf8').split('\n');
  const header = lines.findIndex((line) => line.startsWith('| Name | Type |'));
  if (header < 0) throw new Error('The declaration has no table of names');
  const rows: Declared[] = [];
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('|')) break;
    const [nameCell, typeCell] = line
      .split('|')
      .slice(1, 3)
      .map((cell) => cell.trim());
    const name = /^`([^`]+)`$/.exec(nameCell ?? '')?.[1];
    if (name === undefined) throw new Error(`A declaration row without one name: ${line}`);
    if (typeCell === 'Cookie') rows.push({ name, place: 'cookie' });
    else if (typeCell === '`localStorage`') rows.push({ name, place: 'localStorage' });
    else throw new Error(`A declaration row of an unknown type: ${line}`);
  }
  return rows;
}

/** The declared name as an anchored pattern; `<keyHash>` is one of `keyHashes`. */
function patternOf(declared: Declared, keyHashes: readonly string[]): RegExp {
  const source = declared.name
    .split(/(<[A-Za-z]+>)/)
    .map((part) => {
      const placeholder = /^<([A-Za-z]+)>$/.exec(part)?.[1];
      if (placeholder === undefined) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (placeholder === 'keyHash') return `(?:${keyHashes.join('|')})`;
      const pattern = PLACEHOLDERS[placeholder];
      if (pattern === undefined) throw new Error(`An unknown placeholder in the declaration: ${part}`);
      return pattern;
    })
    .join('');
  return new RegExp(`^${source}$`);
}

/** The observed names no row of the declaration allows, as `place name`, sorted. */
function undeclared(observed: Iterable<Observed>, keyHashes: readonly string[]): string[] {
  const rows = readDeclaration().map((row) => ({ place: row.place, pattern: patternOf(row, keyHashes) }));
  const outside = new Set<string>();
  for (const { place, name } of observed) {
    if (!rows.some((row) => row.place === place && row.pattern.test(name))) outside.add(`${place} ${name}`);
  }
  return [...outside].sort();
}

/** The declared names no observed name matched: what the flows never exercised. */
function unobserved(observed: Iterable<Observed>, keyHashes: readonly string[]): string[] {
  const seen = [...observed];
  return readDeclaration()
    .filter((row) => {
      const pattern = patternOf(row, keyHashes);
      return !seen.some(({ place, name }) => place === row.place && pattern.test(name));
    })
    .map((row) => row.name);
}

/** The assertion of Web Privacy 5: every name the page wrote or holds is declared. */
function expectDeclared(observed: Iterable<Observed>, keyHashes: readonly string[]): void {
  expect(undeclared(observed, keyHashes), 'names docs/storage-declaration.md does not list').toEqual([]);
}

/** `keyHash` of Web Identity 4: the first 16 hex characters of the SHA-256 of the API key. */
function keyHashOf(apiKey: string): string {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Records every name the page writes, before any script of the page runs: `setItem` on either
 * storage area and every `document.cookie` assignment (a delete is an assignment of the name too).
 */
async function recordWrites(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const written: { place: string; name: string }[] = [];
    Reflect.set(window, '__storageWrites', written);
    // The originals are read through `Reflect.get` and called with the page's own `this`.
    const setItem = Reflect.get(Storage.prototype, 'setItem');
    Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
      written.push({ place: this === window.localStorage ? 'localStorage' : 'sessionStorage', name: key });
      setItem.call(this, key, value);
    };
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
    const get = cookie && (Reflect.get(cookie, 'get') as ((this: Document) => string) | undefined);
    const set = cookie && (Reflect.get(cookie, 'set') as ((this: Document, text: string) => void) | undefined);
    if (get === undefined || set === undefined) throw new Error('document.cookie is not an accessor here');
    Object.defineProperty(Document.prototype, 'cookie', {
      configurable: true,
      enumerable: cookie?.enumerable ?? true,
      get(this: Document): string {
        return get.call(this);
      },
      set(this: Document, text: string): void {
        written.push({ place: 'cookie', name: (text.split(';')[0] ?? '').split('=')[0]?.trim() ?? '' });
        set.call(this, text);
      },
    });
  });
}

/** What the page wrote since it loaded and what the origin and the context hold now. */
async function observe(page: Page): Promise<Observed[]> {
  const inPage = await page.evaluate(async () => {
    const written = (Reflect.get(window, '__storageWrites') as { place: string; name: string }[] | undefined) ?? [];
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    return [
      ...written,
      ...Object.keys(localStorage).map((name) => ({ place: 'localStorage', name })),
      ...Object.keys(sessionStorage).map((name) => ({ place: 'sessionStorage', name })),
      ...databases.map((database) => ({ place: 'indexedDB', name: database.name ?? '' })),
    ];
  });
  const cookies = await page.context().cookies();
  return [
    ...inPage.map(({ place, name }) => ({ place: place as Place, name })),
    ...cookies.map(({ name }) => ({ place: 'cookie' as const, name })),
  ];
}

/** What the page wrote since it loaded: the recorder alone, without what the origin holds. */
function writesOf(page: Page): Promise<Observed[]> {
  return page.evaluate(() => (Reflect.get(window, '__storageWrites') as Observed[]).slice());
}

test.describe('the storage declaration (Web Privacy 5)', () => {
  test('every flow of a granted page writes only names the declaration lists, and every listed name', async ({
    context,
    server,
  }) => {
    const apiKey = 'rk_declaration_granted';
    const keyHashes = [keyHashOf(apiKey)];
    const observed: Observed[] = [];
    await recordWrites(context);
    // A saved remote configuration (`.remote`, Web Configuration 5).
    server.respond('/v1/config', { status: 200, headers: { ETag: '"declaration"' }, body: '{}' });

    // The first visit: the start probe, the domain probe on a.rubicon.test (Web Identity 2), the
    // identity and session cookies, `.device`; then identify, register (`.person`), a page view of a
    // pushed path and a flush that is answered.
    const page = await openTab(context, server, { host: TEST_HOST_A, apiKey });
    await call(page, 'track', 'First Visit');
    await call(page, 'identify', 'user-declaration', { plan: 'pro' });
    await call(page, 'register', 'plan', 'pro');
    await page.evaluate(() => {
      history.pushState({}, '', '/pages/second');
    });
    await flushUntilSent(page, server, 'First Visit');
    await expect.poll(() => server.requests.some((request) => request.path === '/v1/config')).toBe(true);

    // A retry pause: a 429 with `Retry-After` writes `.pause` (Web Retry 1); the events then wait as
    // chunks, and `pagehide` writes the released marker (Web Disk 2).
    server.respond('/v1/batch', { status: 429, headers: { 'Retry-After': '120' } });
    await call(page, 'track', 'Throttled');
    await call(page, 'flush');
    await lineMatching(page, /^debug The server asked to slow down; uploads pause for \d+ ms$/);
    await call(page, 'track', 'Held');
    await call(page, 'flush');
    await chunksReach(page, 1);
    await pagehide(page);
    await expect.poll(async () => (await observe(page)).some(({ name }) => name.includes('.q1r.'))).toBe(true);

    // reset, the two decisions (the consent cookie and `.consent`, Web Privacy 2) and an erasure.
    await call(page, 'reset');
    await call(page, 'optOut');
    await call(page, 'optIn');
    await call(page, 'clearLocalData');
    await call(page, 'track', 'After Clear');
    await call(page, 'flush');
    observed.push(...(await observe(page)));

    // A reload: the same origin's next page load starts from what is stored.
    await openTab(context, server, { host: TEST_HOST_A, apiKey, page });
    await call(page, 'track', 'After Reload');
    await call(page, 'flush');
    await deviceIdOf(page);
    observed.push(...(await observe(page)));

    expectDeclared(observed, keyHashes);
    expect(unobserved(observed, keyHashes), 'declared names the flows never wrote').toEqual([]);
    expect(appEvent(server, 'First Visit')).toHaveLength(1);
  });

  test('a pending page writes nothing until the decision, and the decisions write only listed names', async ({
    context,
    server,
  }) => {
    const granting = 'rk_declaration_pending_in';
    const refusing = 'rk_declaration_pending_out';
    const keyHashes = [keyHashOf(granting), keyHashOf(refusing)];
    const pending = { privacy: { defaultConsent: 'pending' } };
    await recordWrites(context);
    server.respond('/v1/config', { status: 404 });

    // While pending nothing is written at all (Web Privacy 1): no cookie, no probe, no key.
    const page = await openTab(context, server, { host: TEST_HOST_A, apiKey: granting, config: pending });
    await call(page, 'track', 'While Pending');
    await call(page, 'identify', 'user-pending');
    await call(page, 'register', 'plan', 'free');
    await page.evaluate(() => {
      history.pushState({}, '', '/pages/pending');
    });
    await call(page, 'flush');
    await deviceIdOf(page);
    expect(await observe(page)).toEqual([]);

    // optIn writes the identity, the session, the stores and the waiting events, and sends them.
    await call(page, 'optIn');
    await flushUntilSent(page, server, 'While Pending');
    const observed = await observe(page);

    // Another key's pending page: optOut writes only the decision; clearLocalData while refused
    // deletes and writes nothing new (Web Privacy 3, Web Logging 4).
    const other = await openTab(context, server, { host: TEST_HOST_A, apiKey: refusing, config: pending });
    await call(other, 'track', 'Never Stored');
    await call(other, 'optOut');
    await call(other, 'clearLocalData');
    await deviceIdOf(other);
    const refused = await writesOf(other);
    observed.push(...(await observe(other)));

    expectDeclared(observed, keyHashes);
    // Of the refusing page's names only the decision is written; a cookie assignment may also be the
    // domain probe or a delete of the identity and session cookies (`Max-Age=0`) by the erasure.
    const refusingHash = keyHashOf(refusing);
    const refusedWrites = new Set(refused.map(({ place, name }) => `${place} ${name}`));
    expect(refusedWrites).toContain(`cookie rubicon_${refusingHash}_c`);
    expect(refusedWrites).toContain(`localStorage rubicon.${refusingHash}.consent`);
    const allowed = [
      new RegExp(`^cookie rubicon_${refusingHash}(?:_c|_s)?$`),
      new RegExp(`^localStorage rubicon\\.${refusingHash}\\.consent$`),
      new RegExp(`^cookie __rubicon_dmn_${PLACEHOLDERS['uuid'] ?? ''}$`),
    ];
    expect([...refusedWrites].filter((write) => !allowed.some((pattern) => pattern.test(write)))).toEqual([]);
    expect(appEvent(server, 'Never Stored')).toEqual([]);
  });

  test('a planted undeclared name makes the check fail', async ({ context, server }) => {
    const apiKey = 'rk_declaration_planted';
    const keyHash = keyHashOf(apiKey);
    await recordWrites(context);
    server.respond('/v1/config', { status: 404 });
    const page = await openTab(context, server, { host: TEST_HOST_A, apiKey });
    await call(page, 'track', 'Planted');
    await deviceIdOf(page);
    expectDeclared(await observe(page), [keyHash]);

    // A key, a cookie and a key that lives for an instant, as a later step might add them without
    // declaring them, and a name in `sessionStorage`, which the declaration never allows.
    await page.evaluate((hash) => {
      localStorage.setItem(`rubicon.${hash}.extra`, '');
      document.cookie = `rubicon_${hash}_x=1; Path=/; Max-Age=60`;
      localStorage.setItem(`rubicon.${hash}.instant`, '');
      localStorage.removeItem(`rubicon.${hash}.instant`);
      sessionStorage.setItem(`rubicon.${hash}.device`, '');
    }, keyHash);
    const observed = await observe(page);

    expect(undeclared(observed, [keyHash])).toEqual([
      `cookie rubicon_${keyHash}_x`,
      `localStorage rubicon.${keyHash}.extra`,
      `localStorage rubicon.${keyHash}.instant`,
      `sessionStorage rubicon.${keyHash}.device`,
    ]);
    expect(() => {
      expectDeclared(observed, [keyHash]);
    }).toThrow(/rubicon\.[0-9a-f]{16}\.extra/);
    // A declared name under another API key's hash is not this key's, and is undeclared for it.
    expect(undeclared([{ place: 'localStorage', name: 'rubicon.0123456789abcdef.device' }], [keyHash])).toEqual([
      'localStorage rubicon.0123456789abcdef.device',
    ]);
    // A declared cookie name in `localStorage` is not declared there.
    expect(undeclared([{ place: 'localStorage', name: `rubicon_${keyHash}` }], [keyHash])).toEqual([
      `localStorage rubicon_${keyHash}`,
    ]);
  });
});
