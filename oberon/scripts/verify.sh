#!/usr/bin/env bash
# Upstream's four checks, in CI's order. Run from the worktree root after `npm ci`.
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
npm run typecheck
npm run lint
npm test
npm run build
echo "OK   typecheck, lint, test, build"
