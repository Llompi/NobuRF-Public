#!/usr/bin/env bash
# Builds the public site into dist-site/: the landing page from site/, the
# workbench at /app/, and the files an AI agent reads when someone pastes the
# setup prompt (agent-setup.md links to them under /agent/).
# Cloudflare Pages runs this as its build command (see docs/hosting.md).
# Everything it writes is static: the solver runs in the visitor's browser.
set -euo pipefail
cd "$(dirname "$0")/.."

OUT=dist-site
rm -rf "$OUT"
cp -R site "$OUT"
rm -rf "$OUT/figures" "$OUT/app" # figure sources are inlined into index.html; app/ is rebuilt below

# Relative base so the app also works from a preview address.
# Only the workbench is published: the main page and race view need the local bridge.
npx vite build --base ./ --outDir "$OUT/app" --emptyOutDir
rm "$OUT/app/index.html" "$OUT/app/race.html" "$OUT/app/selftest.html"
mv "$OUT/app/workbench.html" "$OUT/app/index.html"

mkdir -p "$OUT/agent/examples"
cp docs/project-file.md docs/workbench.md "$OUT/agent/"
cp examples/patch-5g8.json examples/patch-5g8-far-field.json "$OUT/agent/examples/"
