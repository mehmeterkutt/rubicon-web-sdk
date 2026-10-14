#!/usr/bin/env bash
# Everything CI runs, in order (plan section 6). Stops at the first failure.
#
#   scripts/check.sh                  the whole check, the three browser engines included
#   scripts/check.sh --skip-browser   without the Playwright suite (for a quick local loop only;
#                                     a step that touches packages/web is done only with it)
set -euo pipefail

cd "$(dirname "$0")/.."
browser=1
for arg in "$@"; do
  case "$arg" in
    --skip-browser) browser=0 ;;
    *) echo "check: unknown option $arg" >&2; exit 2 ;;
  esac
done

step() { printf '\n== %s\n' "$1"; }

step 'format';               pnpm -s format:check
step 'lint';                 pnpm -s lint
step 'source rules';         node scripts/check-source-rules.mjs --self-test
                             node scripts/check-source-rules.mjs
step 'golden files';         scripts/refresh-golden.sh --check
step 'type check';           pnpm -s -r typecheck
step 'build';                pnpm -s -r build
step 'ES2017';               scripts/check-es2017.sh --self-test
                             scripts/check-es2017.sh
step 'tests with coverage';  pnpm -s -r coverage
step 'API report';           pnpm -s api
step 'size';                 pnpm -s size
step 'SSR import';           pnpm -s ssr
if [[ "$browser" == 1 ]]; then
  step 'browsers';           pnpm -s browser
else
  step 'browsers: skipped (--skip-browser)'
fi
printf '\ncheck: passed\n'
