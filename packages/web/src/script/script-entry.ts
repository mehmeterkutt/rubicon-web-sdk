import * as api from '../index';
import { installScriptBuild } from './script-build';

// The entry of the script build, `dist/rubicon.min.js` (rollup.config.mjs), and its only module with
// a top-level statement: running is what a script tag is for. The package's own entry,
// `src/index.ts`, stays free of side effects (Web Public API 7; source rule `side-effect`, which
// exempts this file by name).

installScriptBuild(api);
