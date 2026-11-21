#!/usr/bin/env bash
# Local stand-in for .github/workflows/test.yml, for when GitHub Actions can't run.
# Tests what a merge would produce: the head ref merged into the base ref, in a
# throwaway worktree, so the checkout you are working in is never touched.
#
#   scripts/ci_local.sh <head-ref> [base-ref]     base-ref defaults to origin/main
#
# Without a GPU, set VK_ICD_FILENAMES to a software Vulkan driver (lavapipe), as CI does.
# Writes a Markdown summary to ci-local-<head-sha>.md in the current directory.
#
# CI_SELFVERIFY=1 also runs the self-verification suite (docs/self-verify.md) as a
# last, report-only step: it takes minutes of CPU solves and fails on main until
# the open solver findings are fixed, so it never blocks the other steps.
set -euo pipefail

head_ref=${1:?usage: scripts/ci_local.sh <head-ref> [base-ref]}
base_ref=${2:-origin/main}

repo_root=$(git rev-parse --show-toplevel)
git -C "$repo_root" fetch --quiet origin
head_sha=$(git -C "$repo_root" rev-parse "$head_ref")
base_sha=$(git -C "$repo_root" rev-parse "$base_ref")
summary_path="$PWD/ci-local-${head_sha:0:7}.md"

worktree_dir=$(mktemp -d)
cleanup() { git -C "$repo_root" worktree remove --force "$worktree_dir" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$repo_root" worktree add --quiet --detach "$worktree_dir" "$base_sha"
cd "$worktree_dir"
if ! git -c user.name=ci-local -c user.email=ci-local@localhost merge --quiet --no-edit "$head_sha"; then
  echo "Merge conflict: $head_ref does not merge cleanly into $base_ref" >&2
  git diff --name-only --diff-filter=U >&2
  exit 1
fi

steps=("npm ci --no-audit --no-fund" "npm run typecheck" "npx vitest run" "npm run test:gpu:node" "npm run build:site")
{
  echo "### Local CI: ${head_sha:0:7} merged into ${base_sha:0:7}"
  echo
  echo "Ran on $(uname -sm), Node $(node --version), $(date -u '+%Y-%m-%d %H:%M UTC')."
  echo
} > "$summary_path"

failed=0
for step in "${steps[@]}"; do
  # Older branches predate some scripts (e.g. test:gpu:node); say so instead of failing.
  if [[ $step == "npm run "* ]] && ! node -e "process.exit(require('./package.json').scripts['${step#npm run }'] ? 0 : 1)"; then
    echo "- \`$step\`: skipped, not defined on this branch" | tee -a "$summary_path"
    continue
  fi
  log_path=$(mktemp)
  started=$(date +%s)
  if bash -c "$step" >"$log_path" 2>&1; then outcome=pass; else outcome=FAIL; failed=1; fi
  seconds=$(( $(date +%s) - started ))
  echo "- \`$step\`: $outcome (${seconds} s)" | tee -a "$summary_path"
  if [ "$outcome" = FAIL ]; then
    { echo; echo '```'; tail -n 40 "$log_path"; echo '```'; } >> "$summary_path"
    break
  fi
  # Keep the vitest totals line; it is the number reviewers look for.
  if [ "$step" = "npx vitest run" ]; then
    grep -E '^ +Tests ' "$log_path" | sed 's/^ */  /' >> "$summary_path" || true
  fi
done

# Report-only: its outcome is written to the summary but does not set the exit code.
if [ "${CI_SELFVERIFY:-0}" = 1 ] && [ "$failed" = 0 ]; then
  log_path=$(mktemp)
  started=$(date +%s)
  if npm run selfverify >"$log_path" 2>&1; then outcome=pass; else outcome="FAIL (report only)"; fi
  echo "- \`npm run selfverify\`: $outcome ($(( $(date +%s) - started )) s)" | tee -a "$summary_path"
  grep -E '^Seed ' "$log_path" | sed 's/^/  /' >> "$summary_path" || true
fi

echo "Summary: $summary_path"
exit $failed
