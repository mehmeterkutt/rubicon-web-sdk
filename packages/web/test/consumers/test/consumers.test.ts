// The consumers of the packed tarball (step 8.2, Web Public API 7): `build.mjs`, run by
// `pnpm -r build`, packs `rubicon-analytics`, installs the tarball with npm into a copy of every
// fixture under temp/ and builds the browser app with Vite and webpack into dist/. Here the Node
// fixtures run, the TypeScript fixture is compiled by TypeScript 5.0 (the consumer floor, plan
// section 15), the workspace's 6.0 and the newest TypeScript with `moduleResolution` `bundler` and
// `node16`, and the bundles are checked for tree shaking. Every check asserts that what it used came
// from the installed tarball, never from the workspace. The apps run in the browser test
// `test/browser/consumers.spec.ts`.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
    for (const fixture of ['app', 'no-op', 'node', 'typescript']) {
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
