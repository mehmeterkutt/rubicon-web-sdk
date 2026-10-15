// The consumers of the packed tarball (step 8.2, Web Public API 7): `build.mjs`, run by
// `pnpm -r build`, packs `rubicon-analytics`, installs the tarball with npm into a copy of every
// fixture under temp/ and builds the browser app with Vite and webpack into dist/. Here the Node
// fixtures run, the TypeScript fixture is compiled by TypeScript 5.0 (the consumer floor, plan
// section 15), the workspace's 6.0 and the newest TypeScript with `moduleResolution` `bundler` and
// `node16`, and the bundles are checked for tree shaking. Every check asserts that what it used came
// from the installed tarball, never from the workspace. The apps run in the browser test
// `test/browser/consumers.spec.ts`. Step 8.5 adds the integration guide: every `ts` block of the root
// README.md, written into the `readme` fixture by `build.mjs`, compiles with the same compilers,
// and the snippet text the guide and `docs/csp.md` publish is the built stub with its hash.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const temp = join(root, 'temp');
const dist = join(root, 'dist');
if (!existsSync(temp)) throw new Error('consumers: run `pnpm -r build` first; it installs the tarball into temp/');
const version = (JSON.parse(readFileSync(join(root, '..', '..', 'package.json'), 'utf8')) as { version: string })
  .version;
const repository = join(root, '..', '..', '..', '..');

/** Where npm installed the tarball in a fixture's copy. */
const installed = (fixture: string, file: string) => join(temp, fixture, 'node_modules', 'rubicon-analytics', file);

const RUNTIME_EXPORTS = ['createAnalytics', 'createNoOpAnalytics', 'createTrackedFetch'];

/** Text that only the rest of the SDK holds: the page marker's key and the upload path. */
const SDK_MARKERS = ['rubicon.analytics', '/v1/batch'];

interface NodeReport {
  resolved: string;
  exports: string[];
  lines: [string, string][];
  isOptedOut: boolean;
  deviceId: string;
  internal: string;
}

function runNode(file: string): NodeReport {
  const out = execFileSync(process.execPath, [file], { cwd: join(temp, 'node'), encoding: 'utf8' });
  return JSON.parse(out) as NodeReport;
}

describe('the installed tarball', () => {
  it('is the version of the package, installed into every fixture', () => {
    for (const fixture of ['app', 'no-op', 'node', 'typescript', 'readme']) {
      const manifest = JSON.parse(readFileSync(installed(fixture, 'package.json'), 'utf8')) as {
        name: string;
        version: string;
        dependencies?: unknown;
      };
      expect(manifest.name).toBe('rubicon-analytics');
      expect(manifest.version).toBe(version);
      expect(manifest.dependencies).toBeUndefined();
    }
  });
});

describe('Node', () => {
  for (const [name, file, entry] of [
    ['ESM', 'esm.mjs', 'index.mjs'],
    ['CommonJS', 'cjs.cjs', 'index.cjs'],
  ] as const) {
    it(`${name}: resolves the tarball's ${entry}, and createAnalytics gives the no-op with one INFO line`, () => {
      const report = runNode(file);
      const expected = installed('node', `dist/${entry}`);
      expect(report.resolved).toBe(name === 'ESM' ? pathToFileURL(expected).href : expected);
      expect(report.exports).toEqual(RUNTIME_EXPORTS);
      expect(report.lines).toEqual([['info', 'Not running in a browser; analytics does nothing here']]);
      expect(report.isOptedOut).toBe(true);
      expect(report.deviceId).toBe('');
    });

    it(`${name}: an internal path is closed by the exports map`, () => {
      expect(runNode(file).internal).toBe('ERR_PACKAGE_PATH_NOT_EXPORTED');
    });
  }
});

/** A compiler's command line, from the `node_modules` directory that holds it. */
const tsc = (modules: string, name: string) => join(modules, name, 'bin', 'tsc');
const workspaceModules = join(root, '..', '..', '..', '..', 'node_modules');

/** The compilers: the floor, the workspace's, and the newest at least seven days old (D6b). */
const COMPILERS = [
  {
    name: 'TypeScript 5.0 (the consumer floor)',
    tsc: tsc(join(root, 'node_modules'), 'typescript-5.0'),
    version: '5.0.4',
  },
  { name: 'TypeScript 6.0 (the workspace compiler)', tsc: tsc(workspaceModules, 'typescript'), version: '6.0.3' },
  { name: 'TypeScript 7.0 (the newest)', tsc: tsc(join(root, 'node_modules'), 'typescript-7.0'), version: '7.0.2' },
] as const;

/** The declaration files each project must read from the installed tarball. */
const DECLARATIONS = {
  bundler: ['dist/index.d.mts'],
  node16: ['dist/index.d.mts', 'dist/index.d.cts'],
} as const;

describe('TypeScript', () => {
  for (const compiler of COMPILERS) {
    describe(compiler.name, () => {
      it('is the expected version', () => {
        expect(execFileSync(process.execPath, [compiler.tsc, '--version'], { encoding: 'utf8' }).trim()).toBe(
          `Version ${compiler.version}`,
        );
      });

      for (const resolution of ['bundler', 'node16'] as const) {
        it(`compiles the consumer with moduleResolution ${resolution}, strict, the declarations checked`, () => {
          const listed = execFileSync(
            process.execPath,
            [compiler.tsc, '-p', `tsconfig.${resolution}.json`, '--listFiles'],
            { cwd: join(temp, 'typescript'), encoding: 'utf8' },
          )
            .split('\n')
            .filter((line) => line.includes('rubicon-analytics'));
          const expected = DECLARATIONS[resolution].map((file) => installed('typescript', file));
          expect(listed.map((line) => line.trim())).toEqual(expected.map((path) => path.split('\\').join('/')));
        });
      }
    });
  }
});

/** The JavaScript a bundler wrote for an app. */
function bundle(app: string): string {
  const dir = join(dist, app);
  const assets = existsSync(join(dir, 'assets')) ? join(dir, 'assets') : dir;
  return readdirSync(assets)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readFileSync(join(assets, name), 'utf8'))
    .join('\n');
}

describe('bundlers', () => {
  for (const bundler of ['vite', 'webpack']) {
    it(`${bundler}: the app holds the SDK`, () => {
      const code = bundle(bundler);
      for (const marker of SDK_MARKERS) expect(code).toContain(marker);
    });

    it(`${bundler}: an app importing only createNoOpAnalytics leaves the rest of the SDK out`, () => {
      const code = bundle(`${bundler}-no-op`);
      expect(code).toContain('isOptedOut');
      for (const marker of SDK_MARKERS) expect(code).not.toContain(marker);
      // The no-op and the bundler's own few hundred bytes; the whole SDK is over 150 000.
      expect(code.length).toBeLessThan(2_000);
    });
  }
});

/** Runs a compiler on a project; the output, errors included, when it fails. */
function compile(compiler: string, cwd: string, ...args: string[]): { ok: boolean; output: string } {
  try {
    return { ok: true, output: execFileSync(process.execPath, [compiler, ...args], { cwd, encoding: 'utf8' }) };
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

describe('the README (step 8.5)', () => {
  const readme = readFileSync(join(repository, 'README.md'), 'utf8');
  const blocks = join(temp, 'readme', 'src');

  it('has every TypeScript block written as a module of the readme fixture', () => {
    const fences = readme.split('\n').filter((line) => /^```ts\s*$/.test(line)).length;
    const files = readdirSync(blocks).filter((name) => /^readme-\d+\.ts$/.test(name));
    expect(fences).toBeGreaterThan(10);
    expect(files).toHaveLength(fences);
  });

  for (const compiler of COMPILERS) {
    it(`compiles every TypeScript block with ${compiler.name}, strict, against the installed tarball`, () => {
      const result = compile(compiler.tsc, join(temp, 'readme'), '-p', 'tsconfig.json', '--listFiles');
      expect(result.output.split('\n').filter((line) => line.includes('error TS'))).toEqual([]);
      expect(result.ok).toBe(true);
      const listed = result.output
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.includes('rubicon-analytics'));
      expect(listed).toEqual([installed('readme', 'dist/index.d.mts').split('\\').join('/')]);
    });
  }

  it('fails the compile when a block misuses the API (the check is real)', () => {
    const planted = join(temp, 'readme-planted');
    rmSync(planted, { recursive: true, force: true });
    cpSync(join(temp, 'readme'), planted, { recursive: true });
    writeFileSync(
      join(planted, 'src', 'readme-planted.ts'),
      "import { createAnalytics } from 'rubicon-analytics';\ncreateAnalytics({ apiKey: 'k' }).track('x').track('y');\nexport {};\n",
    );
    const result = compile(COMPILERS[0].tsc, planted, '-p', 'tsconfig.json');
    rmSync(planted, { recursive: true, force: true });
    expect(result.ok).toBe(false);
    expect(result.output).toContain('readme-planted.ts');
  });

  // What the decision pages ask the guide to say, by a phrase each (plan step 8.5; the sections are
  // read by people, this only catches a section lost in an edit).
  const GUIDE_ITEMS: readonly (readonly [string, string])[] = [
    ['the TypeScript `dom` lib or `@types/node` (section 15, step 8.2)', '`@types/node`'],
    ['arguments held by reference until the library loads (Web Public API 4)', 'Do not change an object'],
    ['the Vite, webpack and snippet `debug` wiring (Web Configuration 2)', 'process.env.NODE_ENV'],
    ['spread fakes over `implements` (Web Public API 3)', '...createNoOpAnalytics()'],
    ['`flush()` gives no delivery guarantee (Web Queue 1)', 'no delivery guarantee'],
    [
      'the Global Privacy Control line (Web Privacy 4)',
      'if (navigator.globalPrivacyControl === true) analytics.optOut();',
    ],
    ['Do Not Track for Mixpanel users (Web Privacy 4)', 'Mixpanel'],
    ['the privacy checklist (Web Privacy 5)', '## Privacy checklist'],
    ['the error-tracker section (Web Logging 2)', 'beforeBreadcrumb'],
    ['the first-party proxy (Web HTTP 5)', 'X-Forwarded-For'],
    ['`persist()` left to the host (Web Disk 7)', 'navigator.storage.persist()'],
    ['axios with the fetch adapter (Web Lifecycle 6)', "adapter: 'fetch'"],
    ['the WebKit cookie lag (section 15, step 8.1)', 'a few milliseconds later'],
    ["the second copy's createTrackedFetch (section 15, step 8.1)", 'of the copy that created the'],
  ];

  for (const [item, phrase] of GUIDE_ITEMS) {
    it(`says ${item}`, () => {
      expect(readme).toContain(phrase);
    });
  }

  it('publishes the built stub verbatim, and the stub hash in the README and docs/csp.md is the built one', () => {
    const snippet = JSON.parse(readFileSync(join(root, '..', '..', 'dist', 'snippet.json'), 'utf8')) as {
      stub: string;
      stubHash: string;
    };
    expect(readme).toContain(`<script>${snippet.stub}</script>`);
    expect(readme).toContain(snippet.stubHash);
    expect(readFileSync(join(repository, 'docs', 'csp.md'), 'utf8')).toContain(snippet.stubHash);
  });
});
