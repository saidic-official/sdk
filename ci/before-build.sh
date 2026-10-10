#!/usr/bin/env bash
# The SDK repository's gate: everything a push must pass, run the same here and in the
# workflow. Stops at the first step that fails, and says which.
set -euo pipefail
cd "$(dirname "$0")/.."

step=""
trap 'echo "BEFORE-BUILD FAILED at: $step"' ERR
run() { step="$1"; shift; echo "== $step"; "$@"; }

run "install the dependencies exactly as locked" npm ci --no-audit --no-fund
run "type check" npm run type-check
run "lint" npm run lint
run "format" npm run format:check
run "build both packages" npm run build
run "unit tests against the protocol's fake" npm test
run "the conformance adapter against the protocol's fake" npm run conformance
run "the SDK's size (at most 15 KB minified and compressed)" npm run size
echo "BEFORE-BUILD PASSED"
