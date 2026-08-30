#!/usr/bin/env bash
# Wire the native GitHub issue dependencies for the #76 refactor epic.
#
# Why this script exists: the orchestrator gates dispatch on GitHub's native issue
# dependency API (see fetchBlockedBy in the GitHub tracker adapter, which reads
# /issues/{n}/dependencies/blocked_by). Prose in an issue body saying "blocked by #84"
# is invisible to it. These edges must exist as real dependencies or the scheduler
# will treat every issue below as immediately dispatchable.
#
# Every edge points from a higher issue number to a lower one, which makes the graph
# acyclic by construction. That matters: cyclicIssueIdentifiers skips every member of
# a cycle silently, with no error anywhere.
#
# Usage:
#   GITHUB_TOKEN=ghp_... ./scripts/wire-issue-dependencies.sh --dry-run
#   GITHUB_TOKEN=ghp_... ./scripts/wire-issue-dependencies.sh
#
# The token needs write access to issues on this repository.

set -euo pipefail

OWNER="Underzenith85"
REPO="symphony-ts"
API="${GITHUB_API_URL:-https://api.github.com}"
DRY_RUN=0

if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

if [[ -z "${GITHUB_TOKEN:-}" ]]; then
  echo "GITHUB_TOKEN is not set" >&2
  exit 1
fi

# "<blocked> <blocker> [blocker...]" — the blocked issue is listed first.
EDGES=(
  "84 69 77 78 79"
  "85 84"
  "86 84 85"
  "87 84"
  "88 81 84"
  "89 88"
  "90 81 88"
  "91 69 88"
  "92 85 89 90 91"
  "93 90 92"
  "94 90"
  "96 90"
  "97 92 94"
  "98 85 87"
  "99 92 98"
  "100 99"
  "101 92"
  "102 89"
  "103 102"
  "104 103"
  "105 94"
  "106 90 96"
  "107 77 84"
  "108 98 104"
  "109 82 86"
  "110 80 86 92 99"
)

api() {
  curl --fail-with-body --silent --show-error \
    -H "Accept: application/vnd.github+json" \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "$@"
}

declare -A ISSUE_ID

issue_id() {
  local number="$1"
  if [[ -z "${ISSUE_ID[$number]:-}" ]]; then
    ISSUE_ID[$number]="$(api "${API}/repos/${OWNER}/${REPO}/issues/${number}" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')"
  fi
  printf '%s' "${ISSUE_ID[$number]}"
}

total=0
for edge in "${EDGES[@]}"; do
  read -r -a parts <<< "${edge}"
  blocked="${parts[0]}"
  for blocker in "${parts[@]:1}"; do
    total=$((total + 1))
    if [[ "${blocker}" -ge "${blocked}" ]]; then
      echo "refusing #${blocked} <- #${blocker}: blocker must be lower-numbered (cycle guard)" >&2
      exit 1
    fi
    if [[ "${DRY_RUN}" == "1" ]]; then
      echo "would block #${blocked} on #${blocker}"
      continue
    fi
    blocker_id="$(issue_id "${blocker}")"
    echo "blocking #${blocked} on #${blocker} (id ${blocker_id})"
    api -X POST \
      "${API}/repos/${OWNER}/${REPO}/issues/${blocked}/dependencies/blocked_by" \
      -d "{\"issue_id\": ${blocker_id}}" > /dev/null
  done
done

echo "${total} edges processed"
