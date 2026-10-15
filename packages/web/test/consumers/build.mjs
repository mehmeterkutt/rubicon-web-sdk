// The consumer fixtures of step 8.2 (Web Public API 7): packs `rubicon-analytics` as it would be
// published, installs the tarball with npm into a copy of every fixture under temp/, and builds the
// browser apps with Vite and webpack into dist/, where the browser test serves them under
// /consumers/. The Node and TypeScript fixtures are run by test/consumers.test.ts from temp/.
//
// Runs in `pnpm -r build` after `rubicon-analytics` (this package's workspace dependency exists only
// for that order; every fixture resolves the installed tarball, which the test asserts).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build as viteBuild } from 'vite';
import webpack from 'webpack';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..', '..');
const temp = join(here, 'temp');
const dist = join(here, 'dist');

/** The fixtures copied and given the tarball; `app` and `no-op` are also built by both bundlers. */
const FIXTURES = ['app', 'no-op', 'node', 'typescript'];

/** Packs the package with pnpm, which writes `workspace:` ranges as versions (step 8.6 publishes so). */
function pack() {
  const destination = join(temp, 'pack');
  mkdirSync(destination, { recursive: true });
  execFileSync('pnpm', ['pack', '--pack-destination', destination], { cwd: web, stdio: 'ignore' });
  const [tarball] = readdirSync(destination).filter((name) => name.endsWith('.tgz'));
  if (tarball === undefined) throw new Error('consumers: pnpm pack wrote no tarball');
  return join(destination, tarball);
}

/** Copies a fixture and installs the tarball into it as an app would, offline, running no script. */
function install(name, tarball) {
  const dir = join(temp, name);
  cpSync(join(here, 'fixtures', name), dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: `consumer-${name}`, private: true, type: 'module' }));
  execFileSync(
    'npm',
    ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock', tarball],
    { cwd: dir, stdio: 'ignore' },
  );
  return dir;
}

function page(bundler, script) {
  return `<!doctype html>
<html lang="en" data-bundler="${bundler}">
  <head>
    <meta charset="utf-8" />
    <title>${bundler} consumer</title>
  </head>
  <body>
    ${script}
  </body>
</html>
`;
}

/** Vite (Rollup inside) with no configuration file, production mode, the app under its base. */
async function withVite(dir, name) {
  writeFileSync(join(dir, 'index.html'), page('vite', '<script type="module" src="/src/main.js"></script>'));
  await viteBuild({
    root: dir,
    base: `/consumers/${name}/`,
    configFile: false,
    logLevel: 'error',
    build: { outDir: join(dist, name), emptyOutDir: true },
  });
}

/** webpack in production mode, its defaults otherwise (tree shaking, `sideEffects`, minifying). */
async function withWebpack(dir, name) {
  const outDir = join(dist, name);
  const stats = await new Promise((resolve, reject) => {
    webpack(
      {
        mode: 'production',
        context: dir,
        entry: './src/main.js',
        devtool: false,
        output: { path: outDir, filename: 'main.js', clean: true },
        performance: { hints: false },
      },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });
  if (stats.hasErrors()) throw new Error(`consumers: webpack failed for ${name}\n${stats.toString('errors-only')}`);
  writeFileSync(join(outDir, 'index.html'), page('webpack', '<script src="main.js" defer></script>'));
}

rmSync(temp, { recursive: true, force: true });
rmSync(dist, { recursive: true, force: true });
const tarball = pack();
const dirs = Object.fromEntries(FIXTURES.map((name) => [name, install(name, tarball)]));
await withVite(dirs.app, 'vite');
await withWebpack(dirs.app, 'webpack');
await withVite(dirs['no-op'], 'vite-no-op');
await withWebpack(dirs['no-op'], 'webpack-no-op');
