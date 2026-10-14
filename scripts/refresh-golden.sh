#!/usr/bin/env bash
# Copies the Android golden wire files, the contract (Serialization 5, Web Event Model 4), into the
# core test fixtures and records their digest and the Android commit they came from. The files are
# read from the Android repository's develop branch as git has it, not from its working tree, which
# may be on another branch. The digest is what the check verifies: the copies must match it, and
# when the Android repository is present, its develop branch must still produce it (step 8.4).
#
#   scripts/refresh-golden.sh          copy and record
#   scripts/refresh-golden.sh --check  verify
#
# ANDROID_SDK_DIR overrides ~/Projects/rubicon/rubicon-android-sdk; ANDROID_REF overrides
# origin/develop.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
android="${ANDROID_SDK_DIR:-$HOME/Projects/rubicon/rubicon-android-sdk}"
ref="${ANDROID_REF:-origin/develop}"
path=sdk-core/src/test/resources/golden
dst="$root/packages/core/test/fixtures/golden"
digest_file="$dst/SOURCE.sha256"
commit_file="$dst/SOURCE.commit"

digest() { # <directory>: the digest of the sorted file names and contents
  (cd "$1" && for f in $(ls ./*.json | sort); do printf '%s\n' "${f#./}"; cat "$f"; done) | shasum -a 256 | cut -d' ' -f1
}

export_android() { # <directory>: the golden files of $ref
  git -C "$android" archive "$ref" "$path" | tar -x -C "$1" --strip-components 5
}

if [[ "${1:-}" == "--check" ]]; then
  [[ -f "$digest_file" ]] || { echo "golden: $digest_file is missing; run scripts/refresh-golden.sh" >&2; exit 1; }
  recorded="$(cat "$digest_file")"
  if [[ "$(digest "$dst")" != "$recorded" ]]; then
    echo "golden: the copies do not match SOURCE.sha256; run scripts/refresh-golden.sh, never edit a copy" >&2
    exit 1
  fi
  if git -C "$android" rev-parse --verify --quiet "$ref" >/dev/null 2>&1; then
    scratch="$(mktemp -d)"
    trap 'rm -rf "$scratch"' EXIT
    export_android "$scratch"
    if [[ "$(digest "$scratch")" != "$recorded" ]]; then
      echo "golden: the Android files on $ref changed; run scripts/refresh-golden.sh and fix what the tests say" >&2
      exit 1
    fi
    echo "golden: the copies match SOURCE.sha256 and the Android files on $ref"
  else
    echo "golden: the copies match SOURCE.sha256 (Android repository not present, not compared)"
  fi
  exit 0
fi

git -C "$android" rev-parse --verify --quiet "$ref" >/dev/null || { echo "golden: $ref not found in $android" >&2; exit 1; }
mkdir -p "$dst"
rm -f "$dst"/*.json
export_android "$dst"
digest "$dst" >"$digest_file"
git -C "$android" rev-parse "$ref" >"$commit_file"
echo "golden: $(ls "$dst"/*.json | wc -l | tr -d ' ') files copied from $android $ref ($(cut -c1-7 "$commit_file")); digest $(cut -c1-12 "$digest_file")"
