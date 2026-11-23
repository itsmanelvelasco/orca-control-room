#!/usr/bin/env bash
# The gate. One command decides if a branch can become a PR.
#   bash scripts/ci-local.sh            full gate, run once before the PR
#   bash scripts/ci-local.sh --changed  fast gate: manifest + tests only
# GitHub Actions is manual-only, so this script is the gate. Needs the `orca` CLI on PATH.
set -uo pipefail
cd "$(dirname "$0")/.."

changed_only=0
[ "${1:-}" = "--changed" ] && changed_only=1
fail=0
step() { # step "name" command...
  local name="$1"; shift
  printf '== %s\n' "$name"
  if "$@"; then printf 'ok   %s\n' "$name"; else printf 'FAIL %s\n' "$name"; fail=1; fi
}

# A branch must not edit the folded changelog.
no_changelog_edit() { ! git diff --name-only origin/main...HEAD 2>/dev/null | grep -qx CHANGELOG.md; }

# Fixtures are public: no e-mail addresses, no real home folders, no repos outside example-org.
fixtures_clean() {
  ! grep -rEn '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}|[A-Za-z]:[\\/]+Users[\\/]+(\\)?[A-Za-z0-9._-]+|/Users/[A-Za-z0-9._-]+|/home/[A-Za-z0-9._-]+|github\.com/[A-Za-z0-9-]+' test/fixtures \
    | grep -vE 'Users[\\/]+(\\)?alex\b|/Users/alex\b|/home/alex\b|github\.com/example-org\b'
}

step "manifest"            orca plugin validate .
step "tests"               orca plugin test .
if [ $changed_only = 0 ]; then
  step "panels"            orca plugin check .
  step "fixtures clean"    fixtures_clean
  step "changelog untouched" no_changelog_edit
fi

if [ $fail = 0 ]; then echo "GATE PASSED"; else echo "GATE FAILED"; fi
exit $fail
