// Runs once before the Playwright suite: builds the test-only serialization bundle (step 8.1,
// serialization/serialization-entry.ts) from the core's sources into `temp/`, an IIFE the
// serialization spec adds to each engine's page. Rollup with the workspace's own TypeScript, which
// only strips types here; the type check is `pnpm typecheck`'s.
import { fileURLToPath } from 'node:url';
import nodeResolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import { rollup } from 'rollup';
import type { Plugin } from 'rollup';
import ts from 'typescript';

/** Where the spec finds the bundle. */
export const SERIALIZATION_BUNDLE = fileURLToPath(new URL('../../temp/browser/serialization.js', import.meta.url));

const entry = fileURLToPath(new URL('serialization/serialization-entry.ts', import.meta.url));

/** Strips the types of every `.ts` module; ES2017 output, as the script build's (Web Public API 6). */
function stripTypes(): Plugin {
  return {
    name: 'strip-types',
    transform(code, id) {
      if (!id.endsWith('.ts')) return null;
      const output = ts.transpileModule(code, {
        fileName: id,
        compilerOptions: { target: ts.ScriptTarget.ES2017, module: ts.ModuleKind.ESNext, sourceMap: false },
      });
      return { code: output.outputText, map: null };
    },
  };
}

export default async function globalSetup(): Promise<void> {
  const bundle = await rollup({
    input: entry,
    plugins: [
      replace({ preventAssignment: true, values: { __VERSION__: JSON.stringify('0.0.0-test') } }),
      nodeResolve({ extensions: ['.ts', '.mjs', '.js'], exportConditions: ['source'] }),
      stripTypes(),
    ],
  });
  try {
    await bundle.write({ file: SERIALIZATION_BUNDLE, format: 'iife' });
  } finally {
    await bundle.close();
  }
}
