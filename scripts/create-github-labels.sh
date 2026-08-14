#!/usr/bin/env bash
# One-off: create (or update) the Memolo issue labels.
# Needed after creating a fresh repo or after a transfer.
#
# Usage (maintainer with admin access):
#   bash scripts/create-github-labels.sh [owner/repo]
#
# Uses gh if available, otherwise GITHUB_TOKEN + curl.

set -euo pipefail
REPO="${1:-tysonnbt/memolo}"

create_label() {
  local name="$1" color="$2" desc="$3"
  if command -v gh >/dev/null 2>&1; then
    gh api --method PUT "repos/$REPO/labels/$name" \
      -f name="$name" -f color="$color" -f description="$desc" >/dev/null
  else
    curl -fsS -X PUT "https://api.github.com/repos/$REPO/labels/$name" \
      -H "Authorization: Bearer ${GITHUB_TOKEN:?set GITHUB_TOKEN}" \
      -H "Accept: application/vnd.github+json" \
      -d "{\"name\":\"$name\",\"color\":\"$color\",\"description\":\"$desc\"}" >/dev/null
  fi
  echo "label: $name"
}

create_label server     5319e7 "Server / API (code in server/)"
create_label dashboard  1d76db "Web dashboard (code in dashboard/)"
create_label sdk        0e8a16 "Node.js SDK (code in sdk/)"
create_label plugin     fbca04 "OpenClaw plugin (code in plugin/)"
create_label docker     84b6eb "Docker, docker-compose, deployment"
create_label setup      d4c5f9 "Installation and setup problems"

echo "done. Labels: https://github.com/$REPO/labels"
