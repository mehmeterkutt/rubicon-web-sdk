#!/usr/bin/env bash
# Copies the Android golden wire files, the contract (Serialization 5, Web Event Model 4), into the
# core test fixtures and records their digest and the Android commit they came from. The files are
# read from the Android repository's develop branch as git has it, not from its working tree, which
# may be on another branch. The digest is what the check verifies: the copies must match it, and
# when the Android repository is present, its develop branch must still produce it (step 8.4).
#
#   scripts/refresh-golden.sh              copy and record
#   scripts/refresh-golden.sh --check      verify
#   scripts/refresh-golden.sh --self-test  prove that --check fails on an edited copy, a missing
#                                          digest and Android files changed without a refresh
#
# ANDROID_SDK_DIR overrides ~/Projects/rubicon/rubicon-android-sdk; ANDROID_REF overrides
# origin/develop; GOLDEN_DIR overrides the copies' directory (the self-test's scratch copies).
# CI has no Android checkout, so there --check verifies the copies against the digest only; the
# comparison with the Android files runs wherever the repository is present, before a release at the
# latest (plan section 15, step 8.4).
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
android="${ANDROID_SDK_DIR:-$HOME/Projects/rubicon/rubicon-android-sdk}"
ref="${ANDROID_REF:-origin/develop}"
path=sdk-core/src/test/resources/golden
dst="${GOLDEN_DIR:-$root/packages/core/test/fixtures/golden}"
digest_file="$dst/SOURCE.sha256"
commit_file="$dst/SOURCE.commit"

digest() { # <directory>: the digest of the sorted file names and contents
  (cd "$1" && for f in $(ls ./*.json | sort); do printf '%s\n' "${f#./}"; cat "$f"; done) | shasum -a 256 | cut -d' ' -f1
}

export_android() { # <directory>: the golden files of $ref
  git -C "$android" archive "$ref" "$path" | tar -x -C "$1" --strip-components 5
}

if [[ "${1:-}" == "--self-test" ]]; then
  scratch="$(mktemp -d)"
  trap 'rm -rf "$scratch"' EXIT
  fake="$scratch/android"
  copies="$scratch/copies"
  mkdir -p "$fake/$path"
  cp "$dst"/*.json "$fake/$path/"
  commit() { # <message>: commits the fake Android repository's golden files on develop
    git -C "$fake" add -A
    git -C "$fake" -c user.name=self-test -c user.email=self-test@example.invalid commit -q -m "$1"
  }
  git -C "$fake" init -q -b develop
  commit 'golden files'
  run() { ANDROID_SDK_DIR="$fake" ANDROID_REF=develop GOLDEN_DIR="$copies" "$0" "$@" >/dev/null 2>&1; }
  expect_pass() { run "$@" || { echo "golden self-test: '$*' failed: $case" >&2; exit 1; }; }
  expect_fail() { if run "$@"; then echo "golden self-test: '$*' passed: $case" >&2; exit 1; fi; }

  case='a fresh refresh'; expect_pass; expect_pass --check
  case='a copy edited by hand'
  printf ' ' >>"$copies/track.json"
  expect_fail --check
  expect_pass
  expect_pass --check
  case='the digest file missing'
  rm "$copies/SOURCE.sha256"
  expect_fail --check
  expect_pass
  case='the Android files changed and the copies did not'
  printf ' ' >>"$fake/$path/track.json"
  commit 'a changed golden file'
  expect_fail --check
  expect_pass
  expect_pass --check
  case='an Android file added and the copies not refreshed'
  printf '{}' >"$fake/$path/new-event.json"
  commit 'a new golden file'
  expect_fail --check
  case='the Android repository absent: the copies against the digest only'
  expect_pass
  ANDROID_SDK_DIR="$scratch/none" GOLDEN_DIR="$copies" "$0" --check >/dev/null 2>&1 || { echo "golden self-test: --check without Android failed" >&2; exit 1; }
  echo 'golden self-test: passed'
  exit 0
fi

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
