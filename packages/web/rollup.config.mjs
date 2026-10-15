// The three builds of Web Public API 7: ESM and CommonJS for bundlers and Node, and the IIFE script
// build that installs window.Rubicon and takes over the snippet's stub (src/script/script-entry.ts,
// step 7.8). The core package is bundled in; nothing is external. scripts/snippet.mjs then writes the
// published hashes of the stub and the script build.
import nodeResolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import { sdkVersion } from '../../scripts/sdk-version.mjs';

const version = sdkVersion();
const banner = `/*! rubicon-analytics ${version} | Apache-2.0 */`;

const plugins = () => [
  replace({ preventAssignment: true, values: { __VERSION__: JSON.stringify(version) } }),
  nodeResolve({ extensions: ['.ts', '.mjs', '.js'] }),
  typescript({
    tsconfig: './tsconfig.src.json',
    include: ['src/**/*.ts', '../core/src/**/*.ts'],
    compilerOptions: { declaration: false, sourceMap: true, noEmit: false },
    noEmitOnError: true,
  }),
];

/** @type {import('rollup').RollupOptions[]} */
export default [
  {
    input: 'src/index.ts',
    plugins: plugins(),
    output: [
      { file: 'dist/index.mjs', format: 'es', sourcemap: true, banner },
      { file: 'dist/index.cjs', format: 'cjs', sourcemap: true, banner, exports: 'named' },
    ],
  },
  {
    // No `name`: the entry exports nothing and installs window.Rubicon itself, so a second load can be
    // refused instead of overwriting it (Web Public API 2).
    input: 'src/script/script-entry.ts',
    plugins: [...plugins(), terser({ ecma: 2017, format: { comments: /^!/ } })],
    output: { file: 'dist/rubicon.min.js', format: 'iife', sourcemap: true, banner },
  },
];
