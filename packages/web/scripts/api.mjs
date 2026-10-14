// api-extractor in three modes (Web Public API 7, D17):
//   build   writes the .d.ts rollup; a changed report does not fail the build, the check does
//   check   fails when the public API differs from etc/rubicon-analytics.api.md or a public symbol
//           has no TSDoc comment (ae-undocumented)
//   update  rewrites etc/rubicon-analytics.api.md after an intended public API change
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Extractor, ExtractorConfig } from '@microsoft/api-extractor';

const mode = process.argv[2];
if (mode !== 'build' && mode !== 'check' && mode !== 'update') {
  console.error('usage: node scripts/api.mjs build|check|update');
  process.exit(2);
}

const configPath = fileURLToPath(new URL('../api-extractor.json', import.meta.url));
const config = ExtractorConfig.loadFileAndPrepare(configPath);
let reportWarnings = 0;
const result = Extractor.invoke(config, {
  localBuild: mode === 'update',
  showVerboseMessages: false,
  messageCallback: (message) => {
    // The build only needs the .d.ts rollup; whether the report matches is the check's question.
    if (mode === 'build' && message.messageId.startsWith('console-api-report')) {
      message.handled = true;
      if (message.logLevel === 'warning') reportWarnings += 1;
    }
  },
});

// Every mode writes the rollup as dist/index.d.ts; the package ships it under the two names the
// exports map gives it, one per module format.
const dist = new URL('../dist/', import.meta.url);
if (existsSync(new URL('index.d.ts', dist))) {
  copyFileSync(new URL('index.d.ts', dist), new URL('index.d.mts', dist));
  copyFileSync(new URL('index.d.ts', dist), new URL('index.d.cts', dist));
  rmSync(new URL('index.d.ts', dist));
}

const warnings = result.warningCount - reportWarnings;
if (result.errorCount > 0 || warnings > 0) {
  console.error(`api-extractor: ${result.errorCount} errors, ${warnings} warnings`);
  process.exit(1);
}
if (mode === 'check' && result.apiReportChanged) {
  console.error('The public API differs from etc/rubicon-analytics.api.md. If the change is intended, run');
  console.error(
    '`pnpm --filter rubicon-analytics api:update`, commit the report and name the change in the pull request.',
  );
  process.exit(1);
}
