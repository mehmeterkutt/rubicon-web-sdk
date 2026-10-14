// The static rules of plan section 5 that ESLint does not express (D10). ESLint carries `any`
// (`@typescript-eslint/no-explicit-any`) and `enum` (`no-restricted-syntax`); the self-test plants a
// violation of those two as well, so every rule of the section is proven to fire.
//
//   node scripts/check-source-rules.mjs              scan packages/core/src and packages/web/src
//   node scripts/check-source-rules.mjs --self-test  plant one violation per rule and expect each
//
// Comments are removed before a rule looks at code; rules about code also blank string contents,
// rules about event names and element names look at the strings. The scanner is a light lexer, not
// a parser: it knows comments, quotes, template literals with their ${} expressions, and regular
// expression literals after the tokens that can precede them.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Files that later steps create and that a rule exempts by name. Each entry names its step; a rule
// keeps no exemption for a file that does not exist yet beyond these.
const CONSOLE_SINK = 'packages/web/src/platform/console-sink.ts'; // step 7.1
const CLOCK_IMPLEMENTATIONS = ['packages/web/src/platform/clock.ts']; // step 7.1 (the browser Clock; 2.1 made the interface)
const HISTORY_REGISTRY = 'packages/web/src/autocapture/history-registry.ts'; // step 7.6
const WEB_FACTORY = 'packages/web/src/create-analytics.ts'; // step 7.1
const WEB_BROWSER_AREAS = ['platform/', 'autocapture/', 'network/', 'script/'];

const BROWSER_GLOBALS = [
  'window',
  'document',
  'navigator',
  'localStorage',
  'globalThis',
  'self',
  'location',
  'history',
];
const NEWER_LIBRARY = [
  // ES2019 and newer library calls (Web Public API 6); `lib: ["es2017"]` rejects them too, this rule
  // also catches them on values typed loosely.
  ['Object.fromEntries', /\bObject\s*\.\s*fromEntries\b/],
  ['flat()', /\.\s*flat\s*\(/],
  ['flatMap()', /\.\s*flatMap\s*\(/],
  ['Promise.allSettled', /\.\s*allSettled\b/],
  ['Promise.any', /\bPromise\s*\.\s*any\b/],
  ['replaceAll()', /\.\s*replaceAll\s*\(/],
  ['matchAll()', /\.\s*matchAll\s*\(/],
  ['trimStart() or trimEnd()', /\.\s*trim(Start|End)\s*\(/],
  ['at()', /\.\s*at\s*\(/],
  ['findLast()', /\.\s*findLast(Index)?\s*\(/],
  ['Object.hasOwn', /\bObject\s*\.\s*hasOwn\b/],
  ['structuredClone', /\bstructuredClone\b/],
];
const LOG_FORBIDDEN = [
  // Logging 4a, Web Logging 1: no value, id, key, header, body or caught error's text in a log line.
  'properties',
  'traits',
  'userId',
  'deviceId',
  'apiKey',
  'headers',
  'body',
  '.message',
  '.stack',
  '.name',
];

/** @typedef {{ file: string, line: number, rule: string, detail: string }} Violation */

/**
 * Splits a TypeScript source into views: `code` without comments and with string, template and
 * regular expression contents blanked; `strings` without comments and with strings kept. Both keep
 * every newline, so line numbers stay true.
 * @param {string} text
 */
export function lex(text) {
  let code = '';
  let strings = '';
  let i = 0;
  /** @type {number[]} brace depth at each open template ${, to know when it closes */
  const templateStack = [];
  let braceDepth = 0;
  let lastSignificant = '';
  const regexMayStart = () =>
    lastSignificant === '' ||
    /[(,=:[!&|?{};+\-*%<>~^]$/.test(lastSignificant) ||
    /\b(return|typeof|case|do|else|in|of|void|yield|await)$/.test(lastSignificant);
  const emit = (/** @type {string} */ c, /** @type {string} */ s = c) => {
    code += c;
    strings += s;
  };
  const blank = (/** @type {string} */ ch) => (ch === '\n' ? '\n' : ' ');
  const readTemplate = () => {
    // at a backtick or just after a closing } of an expression; reads up to ` or ${
    while (i < text.length) {
      const ch = text[i];
      if (ch === '\\') {
        emit('  ', text.slice(i, i + 2));
        i += 2;
      } else if (ch === '`') {
        emit('`');
        i += 1;
        lastSignificant = '`';
        return;
      } else if (ch === '$' && text[i + 1] === '{') {
        emit('${');
        i += 2;
        templateStack.push(braceDepth);
        braceDepth += 1;
        lastSignificant = '{';
        return;
      } else {
        emit(blank(ch), ch);
        i += 1;
      }
    }
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        emit(' ');
        i += 1;
      }
    } else if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (; i < stop; i += 1) emit(blank(text[i]));
    } else if (ch === "'" || ch === '"') {
      emit(ch);
      i += 1;
      while (i < text.length && text[i] !== ch && text[i] !== '\n') {
        if (text[i] === '\\') {
          emit('  ', text.slice(i, i + 2));
          i += 2;
        } else {
          emit(' ', text[i]);
          i += 1;
        }
      }
      if (i < text.length) {
        emit(text[i]);
        i += 1;
      }
      lastSignificant = ch;
    } else if (ch === '`') {
      emit('`');
      i += 1;
      readTemplate();
    } else if (ch === '}' && templateStack.length > 0 && templateStack[templateStack.length - 1] === braceDepth - 1) {
      templateStack.pop();
      braceDepth -= 1;
      emit('}');
      i += 1;
      readTemplate();
    } else if (ch === '/' && regexMayStart()) {
      emit('/');
      i += 1;
      let inClass = false;
      while (i < text.length && text[i] !== '\n') {
        const c = text[i];
        if (c === '\\') {
          emit('  ', text.slice(i, i + 2));
          i += 2;
          continue;
        }
        if (c === '[') inClass = true;
        else if (c === ']') inClass = false;
        else if (c === '/' && !inClass) break;
        emit(' ', c);
        i += 1;
      }
      if (i < text.length && text[i] === '/') {
        emit('/');
        i += 1;
      }
      lastSignificant = '/';
    } else {
      if (ch === '{') braceDepth += 1;
      if (ch === '}') braceDepth -= 1;
      emit(ch);
      i += 1;
      if (!/\s/.test(ch)) lastSignificant = /[\w$]/.test(ch) ? (lastSignificant + ch).slice(-10) : ch;
    }
  }
  return { code, strings };
}

/** @param {string} text @param {number} index */
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

/**
 * The text of the call whose opening parenthesis is at `open`, up to the matching one.
 * @param {string} code @param {number} open
 */
function callArguments(code, open) {
  let depth = 0;
  for (let j = open; j < code.length; j += 1) {
    if (code[j] === '(') depth += 1;
    if (code[j] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(open + 1, j);
    }
  }
  return code.slice(open + 1);
}

/**
 * Where a caught error is in scope: the block of each `catch (name)` and the handler of each
 * `.catch((name) => ...)`. A log call inside one may pass `name` only as the `error` option.
 * @param {string} code
 * @returns {{ name: string, start: number, end: number }[]}
 */
function caughtErrorScopes(code) {
  const scopes = [];
  const clause = /\bcatch\s*\(\s*([\w$]+)\s*(?::[^)]*)?\)\s*\{/g;
  for (let m = clause.exec(code); m !== null; m = clause.exec(code)) {
    const open = m.index + m[0].length - 1;
    let depth = 0;
    let end = code.length;
    for (let j = open; j < code.length; j += 1) {
      if (code[j] === '{') depth += 1;
      if (code[j] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = j;
          break;
        }
      }
    }
    scopes.push({ name: m[1], start: open, end });
  }
  const handler = /\.\s*catch\s*\(\s*(?:\(\s*([\w$]+)[^)]*\)|([\w$]+))\s*=>/g;
  for (let m = handler.exec(code); m !== null; m = handler.exec(code)) {
    const open = code.indexOf('(', m.index);
    scopes.push({ name: m[1] ?? m[2], start: open, end: open + callArguments(code, open).length + 1 });
  }
  return scopes;
}

/**
 * Top-level statements that run code when the module is imported. Prettier starts every top-level
 * statement at column 0, so a line at column 0 with nothing open before it starts a statement.
 * Declarations are allowed; a call or `new` in a top-level initializer is allowed only with a
 * `/*#__PURE__*\/` annotation, which also tells the bundler it may drop it (`sideEffects: false`).
 * @param {string} code @param {string} raw
 * @returns {{ index: number, detail: string }[]}
 */
function topLevelSideEffects(code, raw) {
  const found = [];
  const lines = code.split('\n');
  const rawLines = raw.split('\n');
  let depth = 0;
  let offset = 0;
  for (let n = 0; n < lines.length; n += 1) {
    const line = lines[n];
    if (depth === 0 && /^\S/.test(line)) {
      const declaration =
        /^(import\b|export\s*[*{]|export\s+(type|interface|declare|default\s+(async\s+)?(function|class|abstract))\b|export\s+(async\s+)?function\b|export\s+(abstract\s+)?class\b|(async\s+)?function\b|(abstract\s+)?class\b|type\b|interface\b|declare\b)/;
      const binding = /^(export\s+)?(const|let)\b/;
      if (binding.test(line)) {
        // the statement's text up to the semicolon at depth 0
        let end = offset;
        let d = 0;
        for (; end < code.length; end += 1) {
          const c = code[end];
          if (c === '(' || c === '[' || c === '{') d += 1;
          if (c === ')' || c === ']' || c === '}') d -= 1;
          if (c === ';' && d === 0) break;
        }
        const statement = code.slice(offset, end);
        const rawStatement = raw.slice(offset, end);
        const initializer = statement.indexOf('=');
        if (initializer !== -1) {
          const value = statement.slice(initializer + 1);
          const rawValue = rawStatement.slice(initializer + 1);
          // `new X(...)` is one call: the alternation consumes `new X(` so `X(` is not counted again.
          const calls = (value.match(/\bnew\s+[\w$.]+\s*\(?|[\w$)\]]\s*\(/g) || []).length;
          const arrow = /^\s*(async\s*)?(\([^)]*\)|[\w$]+)\s*(:\s*[^=]+)?=>/.test(value);
          const functionExpression = /^\s*(async\s+)?function\b/.test(value);
          const pure = (rawValue.match(/\/\*\s*[#@]__PURE__\s*\*\//g) || []).length;
          if (!arrow && !functionExpression && calls > pure) {
            found.push({ index: offset, detail: 'a call or `new` in a top-level initializer without /*#__PURE__*/' });
          }
        }
      } else if (!declaration.test(line)) {
        found.push({ index: offset, detail: `top-level statement \`${rawLines[n].trim().slice(0, 40)}\`` });
      }
    }
    for (const c of line) {
      if (c === '(' || c === '[' || c === '{') depth += 1;
      if (c === ')' || c === ']' || c === '}') depth -= 1;
    }
    offset += line.length + 1;
  }
  return found;
}

/**
 * Every rule over one file. `file` is the path relative to the repository root with `/`.
 * @param {string} file @param {string} raw
 * @returns {Violation[]}
 */
export function checkFile(file, raw) {
  /** @type {Violation[]} */
  const out = [];
  const { code, strings } = lex(raw);
  const add = (/** @type {number} */ index, /** @type {string} */ rule, /** @type {string} */ detail) =>
    out.push({ file, line: lineOf(raw, index), rule, detail });
  /** @param {string} view @param {RegExp} re @param {string} rule @param {(m: RegExpExecArray) => string} detail */
  const each = (view, re, rule, detail) => {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (let m = g.exec(view); m !== null; m = g.exec(view)) add(m.index, rule, detail(m));
  };
  const inCore = file.startsWith('packages/core/src/');
  const inWeb = file.startsWith('packages/web/src/');

  if (file !== CONSOLE_SINK)
    each(code, /\bconsole\s*[.[]/, 'console', () => '`console` outside the default sink (Web Logging 1)');
  if (!CLOCK_IMPLEMENTATIONS.includes(file)) {
    each(code, /\bDate\s*\.\s*now\s*\(/, 'clock', () => '`Date.now()` outside `Clock` (Web Session 4, Web Retry 3)');
    each(code, /\bnew\s+Date\s*\(/, 'clock', () => '`new Date()` outside `Clock` (Web Session 4, Web Retry 3)');
  }
  each(code, /\bMath\s*\.\s*random\b/, 'random', () => '`Math.random` instead of `RandomSource` (Web Event Model 3)');

  const webBrowserFile =
    inWeb && (file === WEB_FACTORY || WEB_BROWSER_AREAS.some((a) => file.startsWith(`packages/web/src/${a}`)));
  if (inCore || (inWeb && !webBrowserFile)) {
    const where = inCore ? 'in core' : 'outside platform/, autocapture/, network/, script/ and the factory';
    each(
      code,
      new RegExp(`(?<![\\w$.])(${BROWSER_GLOBALS.join('|')})\\b(?!\\s*:)`),
      'browser-global',
      (m) => `\`${m[1]}\` ${where} (Web Public API 7)`,
    );
  }

  for (const [name, re] of NEWER_LIBRARY)
    each(code, re, 'newer-library', () => `${name} is newer than ES2017 (Web Public API 6)`);

  // The logger's call shape (step 2.2): `log.debug(() => message)`, `log.info(() => message)`,
  // `log.warn(code, () => message, { error, repeatKey, developerError })` and `log.error(...)`. The
  // caught error may travel only as the `error` option, which reaches the developer's logger alone.
  const caught = caughtErrorScopes(code);
  each(code, /\b(log|logger)\s*\.\s*(error|warn|info|debug)\s*\(/, 'log-content', (m) => {
    const args = callArguments(code, m.index + m[0].length - 1);
    const bad = LOG_FORBIDDEN.filter((w) =>
      w.startsWith('.') ? args.includes(w) : new RegExp(`\\b${w}\\b`).test(args),
    );
    const message = args.replace(/\berror\s*:\s*[\w$]+/g, '').replace(/([{,]\s*)error(?=\s*[,}])/g, '$1');
    for (const { name, start, end } of caught) {
      if (m.index > start && m.index < end && new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}\\b`).test(message))
        bad.push(`the caught error \`${name}\` outside the \`error\` option`);
    }
    return bad.length > 0 ? `log call passes ${bad.join(', ')} (Logging 4a, Web Logging 1)` : '';
  });

  each(
    code,
    /(?<![\w$])(fetch|XMLHttpRequest)\s*=(?![=>])/,
    'replace-transport',
    (m) => `\`${m[1]}\` assigned (Web Lifecycle 6)`,
  );
  each(
    strings,
    /defineProperty\s*\(\s*[\w$.]+\s*,\s*['"](fetch|XMLHttpRequest)['"]/,
    'replace-transport',
    (m) => `\`${m[1]}\` redefined (Web Lifecycle 6)`,
  );
  if (file !== HISTORY_REGISTRY) {
    each(
      code,
      /\.\s*(pushState|replaceState)\s*=(?![=>])/,
      'history-wrap',
      (m) => `\`history.${m[1]}\` wrapped outside the history registry (Web Lifecycle 2)`,
    );
  }
  each(code, /\bsendBeacon\b/, 'close-time', () => '`sendBeacon` (Web Queue 3)');
  each(
    strings,
    /addEventListener\s*\(\s*['"](unload|beforeunload)['"]/,
    'close-time',
    (m) => `\`${m[1]}\` listener (Web Queue 3)`,
  );
  each(code, /\bon(unload|beforeunload)\s*=(?!=)/, 'close-time', (m) => `\`on${m[1]}\` handler (Web Queue 3)`);
  each(code, /(?<![\w$.])(sessionStorage|indexedDB)\b/, 'storage', (m) => `\`${m[1]}\` (Web Disk 1, Web Privacy 5)`);
  each(code, /\bnavigator\s*\.\s*storage\b/, 'storage', () => '`navigator.storage` (Web Disk 7)');
  each(code, /\b(globalPrivacyControl|doNotTrack)\b/, 'privacy-signal', (m) => `\`${m[1]}\` read (Web Privacy 4)`);
  each(
    strings,
    /addEventListener\s*\(\s*['"](click|submit|input)['"]/,
    'element-interaction',
    (m) => `\`${m[1]}\` listener (Web Lifecycle 7)`,
  );
  each(
    code,
    /\bon(click|submit|input)\s*=(?!=)/,
    'element-interaction',
    (m) => `\`on${m[1]}\` handler (Web Lifecycle 7)`,
  );
  each(code, /(?<![\w$.])eval\s*\(/, 'code-loading', () => '`eval` (Web HTTP 6)');
  each(code, /\bnew\s+Function\s*\(/, 'code-loading', () => '`new Function` (Web HTTP 6)');
  each(code, /(?<![\w$.])import\s*\(/, 'code-loading', () => 'dynamic `import()` (Web HTTP 6)');
  each(code, /\bimportScripts\s*\(/, 'code-loading', () => '`importScripts` (Web HTTP 6)');
  each(
    strings,
    /createElement\s*\(\s*['"]script['"]/,
    'code-loading',
    () => 'a script element created at run time (Web HTTP 6)',
  );

  for (const { index, detail } of topLevelSideEffects(code, raw))
    add(index, 'side-effect', `${detail} (Web Public API 7)`);

  return out.filter((v) => v.detail !== '');
}

/**
 * The public API carries no Promise (Web Public API 3): read from the api-extractor report.
 * @param {string} file @param {string} report
 * @returns {Violation[]}
 */
export function checkApiReport(file, report) {
  /** @type {Violation[]} */
  const out = [];
  const re = /\b(Promise|PromiseLike|async)\b/g;
  for (let m = re.exec(report); m !== null; m = re.exec(report)) {
    out.push({
      file,
      line: lineOf(report, m.index),
      rule: 'public-promise',
      detail: `\`${m[1]}\` in the public API (Web Public API 3)`,
    });
  }
  return out;
}

/**
 * A TODO names the step that resolves it (plan section 6), as `TODO(step 2.1)`.
 * @param {string} file @param {string} raw
 * @returns {Violation[]}
 */
export function checkTodos(file, raw) {
  /** @type {Violation[]} */
  const out = [];
  const re = /\bTODO\b(?!\(step \d+\.\d+[ab]?\))/g;
  for (let m = re.exec(raw); m !== null; m = re.exec(raw)) {
    out.push({ file, line: lineOf(raw, m.index), rule: 'todo', detail: 'TODO without `(step N.N)` (plan section 6)' });
  }
  return out;
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  /** @type {string[]} */
  const files = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'dist-types' || name === 'coverage' || name === 'temp')
      continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

const rel = (/** @type {string} */ path) => relative(root, path).split(sep).join('/');

function scan() {
  /** @type {Violation[]} */
  const violations = [];
  for (const pkg of ['core', 'web']) {
    for (const path of walk(join(root, 'packages', pkg, 'src'))) {
      if (path.endsWith('.ts')) violations.push(...checkFile(rel(path), readFileSync(path, 'utf8')));
    }
  }
  const report = join(root, 'packages/web/etc/rubicon-analytics.api.md');
  violations.push(...checkApiReport(rel(report), readFileSync(report, 'utf8')));
  for (const top of ['packages', 'scripts', '.github']) {
    for (const path of walk(join(root, top))) {
      if (
        /\.(ts|mjs|js|sh|ya?ml)$/.test(path) &&
        !path.includes(`${sep}fixtures${sep}`) &&
        path !== fileURLToPath(import.meta.url)
      ) {
        violations.push(...checkTodos(rel(path), readFileSync(path, 'utf8')));
      }
    }
  }
  return violations;
}

async function selfTest() {
  const core = 'packages/core/src/planted.ts';
  const web = 'packages/web/src/planted.ts';
  /** @type {[string, string, string, string][]} rule, file, planted source, what it shows */
  const plants = [
    ['console', core, 'export function f(): void {\n  console.log(1);\n}\n', 'console call'],
    ['clock', core, 'export function f(): number {\n  return Date.now();\n}\n', 'Date.now()'],
    ['clock', core, 'export function f(): Date {\n  return new Date();\n}\n', 'new Date()'],
    ['random', core, 'export function f(): number {\n  return Math.random();\n}\n', 'Math.random'],
    ['browser-global', core, 'export function f(): unknown {\n  return window;\n}\n', 'window in core'],
    ['browser-global', core, 'export function f(): unknown {\n  return globalThis;\n}\n', 'globalThis in core'],
    [
      'browser-global',
      web,
      'export function f(): unknown {\n  return document.title;\n}\n',
      'document outside the browser areas',
    ],
    ['newer-library', core, 'export function f(x: unknown[][]): unknown {\n  return x.flat();\n}\n', 'flat()'],
    [
      'newer-library',
      core,
      'export function f(): unknown {\n  return Object.fromEntries([]);\n}\n',
      'Object.fromEntries',
    ],
    ['newer-library', core, 'export function f(x: string[]): unknown {\n  return x.at(-1);\n}\n', 'at()'],
    [
      'log-content',
      core,
      "export function f(log: L, e: Error): void {\n  log.warn('STORAGE_WRITE_FAILED', () => `failed: ${e.message}`);\n}\n",
      'caught error message',
    ],
    [
      'log-content',
      core,
      'export function f(log: L, p: P): void {\n  log.debug(() => String(p.properties));\n}\n',
      'properties',
    ],
    [
      'log-content',
      core,
      "export function f(log: L): void {\n  try {\n    g();\n  } catch (e) {\n    log.error('STORAGE_WRITE_FAILED', () => `failed: ${String(e)}`, { error: e });\n  }\n}\n",
      'a caught error stringified in the message',
    ],
    [
      'log-content',
      core,
      "export function f(log: L, p: Promise<void>): void {\n  p.catch((reason) => {\n    log.warn('REMOTE_CONFIG_FAILED', () => `${reason}`);\n  });\n}\n",
      'a rejection reason in the message',
    ],
    [
      'log-content',
      core,
      "export function f(log: L, c: C): void {\n  log.warn('RESERVED_HEADER', () => 'reserved', { error: c.apiKey });\n}\n",
      'apiKey in the options',
    ],
    ['replace-transport', web, 'export function f(w: W): void {\n  w.fetch = g;\n}\n', 'fetch assigned'],
    [
      'history-wrap',
      'packages/web/src/autocapture/page-views.ts',
      'export function f(h: H): void {\n  h.pushState = g;\n}\n',
      'pushState wrapped outside the registry',
    ],
    ['close-time', web, 'export function f(n: N): void {\n  n.sendBeacon(u);\n}\n', 'sendBeacon'],
    [
      'close-time',
      'packages/web/src/platform/lifecycle.ts',
      "export function f(w: W): void {\n  w.addEventListener('beforeunload', g);\n}\n",
      'beforeunload listener',
    ],
    [
      'storage',
      'packages/web/src/platform/storage.ts',
      'export function f(): unknown {\n  return sessionStorage;\n}\n',
      'sessionStorage',
    ],
    [
      'privacy-signal',
      'packages/web/src/platform/context.ts',
      'export function f(n: N): unknown {\n  return n.globalPrivacyControl;\n}\n',
      'globalPrivacyControl',
    ],
    [
      'element-interaction',
      'packages/web/src/autocapture/page-views.ts',
      "export function f(d: D): void {\n  d.addEventListener('click', g);\n}\n",
      'click listener',
    ],
    ['code-loading', core, "export function f(): unknown {\n  return eval('1');\n}\n", 'eval'],
    [
      'code-loading',
      core,
      "export async function f(): Promise<unknown> {\n  return import('./x');\n}\n",
      'dynamic import',
    ],
    [
      'code-loading',
      'packages/web/src/script/loader.ts',
      "export function f(d: D): unknown {\n  return d.createElement('script');\n}\n",
      'script element',
    ],
    ['side-effect', core, 'register();\n', 'top-level call statement'],
    ['side-effect', core, 'export const registry = createRegistry();\n', 'top-level call in an initializer'],
    ['side-effect', core, 'export const table = new Map();\n', 'top-level `new` without /*#__PURE__*/'],
  ];
  /** @type {string[]} */
  const failures = [];
  for (const [rule, file, source, what] of plants) {
    if (!checkFile(file, source).some((v) => v.rule === rule)) failures.push(`${rule}: not detected: ${what}`);
  }
  // Clean code must pass, including the shapes the rules must not confuse.
  const clean = [
    "import { a } from './a';",
    "export { b } from './b';",
    'export type T = { window: string };',
    'export interface I {\n  document: string;\n}',
    '/** `console.log(window)` in a comment */',
    "const words = 'console Date.now() Math.random window eval(';",
    'const pattern = /window|console/g;',
    'export const pure = /*#__PURE__*/ makeTable();',
    'export const pureMap = /*#__PURE__*/ new Map<string, number>();',
    'export const handler = (x: number): number => x + 1;',
    'export const limits = { maxKeys: 255 } as const;',
    "export function f(log: L, eventName: string): void {\n  log.warn('INVALID_EVENT_NAME', () => `dropped ${eventName.length}`);\n}",
    "export function g(log: L): void {\n  try {\n    h();\n  } catch (e) {\n    log.error('STORAGE_WRITE_FAILED', () => 'write failed', { error: e });\n  }\n}",
    "export function k(log: L): void {\n  try {\n    h();\n  } catch (error) {\n    log.warn('STORE_UNREADABLE', () => 'unreadable', { error, repeatKey: 'device' });\n  }\n}",
    'export const template = `a ${1 + 1} b`;',
    'let inCallback = false;',
  ].join('\n');
  const noise = checkFile(core, clean);
  for (const v of noise) failures.push(`false positive: ${v.rule} at line ${v.line}: ${v.detail}`);

  if (checkApiReport('report.md', 'export function flush(): Promise<void>;').length === 0)
    failures.push('public-promise: not detected');
  if (checkTodos('x.ts', '// TODO tidy up').length === 0) failures.push('todo: not detected');
  if (checkTodos('x.ts', '// TODO(step 2.1) the real clock').length !== 0)
    failures.push('todo: a TODO with its step was rejected');

  // The two rules ESLint carries, through the repository's own configuration.
  const { ESLint } = await import('eslint');
  const tseslint = (await import('typescript-eslint')).default;
  const eslint = new ESLint({
    cwd: root,
    overrideConfig: [{ files: ['**/*.ts'], ...tseslint.configs.disableTypeChecked }],
  });
  for (const [rule, source] of [
    ['@typescript-eslint/no-explicit-any', 'export const x: any = 1;\n'],
    ['no-restricted-syntax', 'export enum E {\n  A,\n}\n'],
  ]) {
    const [result] = await eslint.lintText(source, { filePath: join(root, 'packages/core/src/planted.ts') });
    if (!result || !result.messages.some((m) => m.ruleId === rule)) failures.push(`eslint ${rule}: not detected`);
  }

  if (failures.length > 0) {
    for (const f of failures) console.error(`check-source-rules self-test: ${f}`);
    process.exit(1);
  }
  console.log(
    `check-source-rules self-test: passed (${plants.length + 5} planted violations detected, clean code accepted)`,
  );
}

if (process.argv[2] === '--self-test') {
  await selfTest();
} else {
  const violations = scan();
  for (const v of violations) console.error(`${v.file}:${v.line}: [${v.rule}] ${v.detail}`);
  if (violations.length > 0) process.exit(1);
  console.log('check-source-rules: passed');
}
