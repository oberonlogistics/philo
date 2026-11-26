#!/usr/bin/env bash
# Check that the current branch can be offered to philo-crm/philo.
#
# Usage: check-upstreamable.sh [base]     (base defaults to upstream/main)
#
# Fails when the branch:
#   - has merge commits since base (an Oberon merge leaked in, or an up/ branch was cut from origin/main),
#   - touches oberon/ or adds a line naming Oberon or an OL service,
#   - has a commit whose Signed-off-by does not match its author (upstream enforces DCO).
set -euo pipefail

base="${1:-upstream/main}"
git rev-parse --verify --quiet "$base" >/dev/null || { echo "FAIL unknown base $base (git fetch upstream?)"; exit 1; }

fail=0
range="$base..HEAD"
count=$(git rev-list --count "$range")
[[ "$count" -gt 0 ]] || { echo "FAIL no commits in $range"; exit 1; }

if [[ -n "$(git rev-list --merges "$range")" ]]; then
  echo "FAIL merge commits in $range: cut up/ branches from upstream/main and do not merge origin/main into them"
  fail=1
fi

if git diff --name-only "$base...HEAD" | grep -q '^oberon/'; then
  echo "FAIL touches oberon/ (fork-only files)"
  fail=1
fi

# Real-world names upstream forbids. Ollie is allowed: it is an open-source project upstream links to.
pattern='oberon|landstar|\bol[- _]?(auth|notify|chrome|common|dash|handbook)\b|olchrome|--ol-'
hits=$(git diff "$base...HEAD" -- . ':(exclude)oberon/' | grep -E '^\+' | grep -v '^+++' | grep -inE "$pattern" || true)
if [[ -n "$hits" ]]; then
  echo "FAIL added lines name Oberon or an OL service (upstream: no real-world names):"
  echo "$hits" | head -20
  fail=1
fi
msg_hits=$(git log --format='%h %B' "$range" | grep -iE "$pattern" || true)
if [[ -n "$msg_hits" ]]; then
  echo "FAIL commit messages name Oberon or an OL service:"
  echo "$msg_hits" | head -10
  fail=1
fi

while read -r sha; do
  author=$(git log -1 --format='%an <%ae>' "$sha")
  if ! git log -1 --format='%(trailers:key=Signed-off-by,valueonly)' "$sha" | grep -qxF "$author"; then
    echo "FAIL $(git log -1 --format='%h %s' "$sha"): no Signed-off-by: $author"
    fail=1
  fi
done < <(git rev-list --no-merges "$range")

if [[ "$fail" -eq 0 ]]; then
  echo "OK   $count commit(s) in $range can go upstream"
fi
exit "$fail"
