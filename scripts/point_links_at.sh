#!/usr/bin/env bash
# Point the site's and the docs' GitHub links at another repository, e.g. the public one:
#   scripts/point_links_at.sh someone/NobuRF
set -euo pipefail
target=${1:?usage: scripts/point_links_at.sh <owner>/<repo>}
[[ $target =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || { echo "not an owner/repo name: $target" >&2; exit 1; }
cd "$(dirname "$0")/.."
files=$(git grep -l 'github\.com/Llompi/NobuRF' -- site README.md CONTRIBUTING.md docs/README.md docs/hosting.md || true)
[[ -n $files ]] || { echo "no links to change"; exit 0; }
sed -i "s#github\.com/Llompi/NobuRF#github.com/$target#g" $files
echo "updated: $files"
