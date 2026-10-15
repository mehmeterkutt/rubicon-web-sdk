// ESLint for the TypeScript sources and tests (D10). The static rules of plan section 5 that ESLint
// cannot express are in scripts/check-source-rules.mjs.
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-types/**',
      '**/coverage/**',
      '**/temp/**',
      '**/test-results/**',
      '**/playwright-report/**',
      'packages/core/test/fixtures/**',
      // The framework fixtures' build outputs (step 8.1).
      '**/.next/**',
      'packages/web/test/frameworks/*/out/**',
      // The TypeScript consumer of step 8.2: compiled by TypeScript 5.0 to 7.0 in its own projects
      // (packages/web/test/consumers), with `@ts-expect-error` lines that misuse the API on purpose.
      'packages/web/test/consumers/fixtures/typescript/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSEnumDeclaration',
          message: 'No enum: use a string literal union with an as const array (Web Event Model 5).',
        },
      ],
    },
  },
  {
    // Node scripts and configuration in JavaScript: linted without type information.
    files: ['**/*.mjs', '**/*.js', '**/*.d.mts'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: { ...tseslint.configs.disableTypeChecked.languageOptions, globals: globals.node },
  },
  {
    // The snippet's stub, pasted into the host's HTML: ES5 in a browser (Web Public API 6, HTTP 6).
    files: ['packages/web/src/snippet/stub.js'],
    languageOptions: { ecmaVersion: 5, sourceType: 'script', globals: globals.browser },
    // ES5 has no optional catch binding; the stub swallows every failure so the page never sees one.
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },
  {
    // The framework fixtures' app sources (step 8.1): browser modules, linted without type information.
    files: ['packages/web/test/frameworks/*/src/**/*.js', 'packages/web/test/frameworks/*/app/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    // The consumer apps of step 8.2: browser modules, linted without type information.
    files: ['packages/web/test/consumers/fixtures/*/src/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    // The consumer fixture for Node's CommonJS (step 8.2).
    files: ['packages/web/test/consumers/fixtures/node/*.cjs'],
    ...tseslint.configs.disableTypeChecked,
    languageOptions: {
      ...tseslint.configs.disableTypeChecked.languageOptions,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: { ...tseslint.configs.disableTypeChecked.rules, '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    files: ['**/test/**/*.ts', '**/*.config.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
