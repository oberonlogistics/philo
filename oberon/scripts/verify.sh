#!/usr/bin/env bash
# Upstream's four checks, in CI's order, then the Oberon layer's own tests.
# Run from the worktree root after `npm ci`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
npm run typecheck
npm run lint
npm test
npm run build
echo "OK   typecheck, lint, test, build"
# oberon/web is not an npm workspace, so `npm test` does not reach it.
# .github/workflows/ol-ci.yml runs the same step in the fork's CI.
if [ -d oberon/web/test ]; then
  npx vitest run --root oberon/web
  echo "OK   oberon/web tests"
fi
