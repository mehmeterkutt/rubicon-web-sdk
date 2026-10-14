#!/usr/bin/env bash
# Checks that every built JavaScript file is ES2017, syntax and features (Web Public API 6, D13).
# The floor browsers cannot run in CI; this check and the source rule against ES2019 and newer
# library calls stand in for them (the Changed on note of 2026-10-14 on Web Public API 6).
#
#   scripts/check-es2017.sh              check packages/web/dist
#   scripts/check-es2017.sh --self-test  prove that the check fails on ES2018 and passes on ES2017
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
es_check="$root/node_modules/.bin/es-check"
dist="$root/packages/web/dist"

# Two passes: es-check 9.8.1 with --checkFeatures accepts ES2018 syntax such as object rest and
# regular expression lookbehind (seen on 2026-10-14), so syntax and features are checked apart.
check() { # <directory>
# The commands are chained because `set -e` does not apply inside a function called as a condition.
  "$es_check" es2017 "$1/index.cjs" "$1/rubicon.min.js" --quiet &&
    "$es_check" es2017 "$1/index.mjs" --module --quiet &&
    "$es_check" es2017 "$1/index.cjs" "$1/rubicon.min.js" --checkFeatures --quiet &&
    "$es_check" es2017 "$1/index.mjs" --module --checkFeatures --quiet
}

if [[ "${1:-}" == "--self-test" ]]; then
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  fails() { # <name> <script file content>
    rm -f "$scratch"/*
    printf '%s\n' "$2" >"$scratch/index.cjs"
    printf 'var ok = 1;\n' >"$scratch/rubicon.min.js"
    printf 'export {};\n' >"$scratch/index.mjs"
    if check "$scratch" >/dev/null 2>&1; then
      echo "check-es2017 self-test: not detected: $1" >&2
      exit 1
    fi
  }
  fails 'object rest (ES2018)' 'var o = {}; var { a, ...rest } = o;'
  fails 'async iteration (ES2018)' 'async function f(xs) { for await (const x of xs) {} }'
  fails 'regular expression lookbehind (ES2018)' 'var r = /(?<=a)b/;'
  fails 'optional catch binding (ES2019)' 'try {} catch {}'
  fails 'Object.fromEntries (ES2019)' 'var e = Object.fromEntries([]);'
  fails 'Array.prototype.flat (ES2019)' 'var e = [[1]].flat();'
  fails 'Promise.allSettled (ES2020)' 'Promise.allSettled([]);'
  printf 'async function f() { await 1; }\nvar e = Object.entries({});\n' >"$scratch/index.cjs"
  if ! check "$scratch"; then
    echo "check-es2017 self-test: an ES2017 file was rejected" >&2
    exit 1
  fi
  echo "check-es2017 self-test: passed"
  exit 0
fi

check "$dist"
echo "check-es2017: passed"
