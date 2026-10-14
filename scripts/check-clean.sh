#!/usr/bin/env bash
# Runs scripts/check.sh on a fresh clone of the committed HEAD, with dependencies installed from the
# lockfile only. It stands in for CI while GitHub Actions minutes are exhausted (plan section 15,
# 2026-10-14): what passes here does not depend on uncommitted files, ignored files or the local
# node_modules. Options are passed on to check.sh.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
if [[ -n "$(git -C "$root" status --porcelain)" ]]; then
  echo "check-clean: the working tree has uncommitted changes; this check runs on HEAD ($(git -C "$root" rev-parse --short HEAD)) only" >&2
fi
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
git clone --quiet --no-hardlinks "$root" "$scratch/repo"
cd "$scratch/repo"
echo "check-clean: $(git rev-parse --short HEAD) in $scratch/repo"
pnpm install --frozen-lockfile --silent
scripts/check.sh "$@"
