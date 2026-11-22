# Hosting the public site

The public site is static files on Cloudflare Pages: the landing page from `site/`, the workbench
at `/app/`, and `agent-setup.md` with the files it links under `/agent/`. The solver runs in each
visitor's browser, so the server only hands out files.

```bash
npm run build:site   # writes dist-site/
```

`scripts/build_site.sh` is the whole build. To preview it, serve `dist-site/` from `localhost`
(WebGPU and the clipboard need `localhost` or `https`), for example with
`python3 -m http.server -d dist-site 8765`.

## Cloudflare Pages settings

| Setting | Value |
| --- | --- |
| Framework preset | None |
| Build command | `npm run build:site` |
| Build output directory | `dist-site` |
| Node version | from `.node-version` (22) |
| Custom domains | `noburf.com` (primary), `www.noburf.com`, `noburf.llom.party` |

`site/_headers` sets security headers on every response (HSTS, no framing, a minimal CSP that blocks
`<object>`, foreign `<base>` and off-site form posts, and a Permissions-Policy that turns off the
camera, microphone, location, payment and USB APIs), the Markdown content type, and long caching
for the hashed app files. A full script CSP is left out on purpose: the landing page uses inline
scripts. Preview branch deployments are off in the Pages project, so only `main` is published.

## Domains

`https://noburf.com` is the site's address. Every link in the repo, the share tags and the agent setup prompt
use it. Two other names reach the same Pages project and answer with a permanent (301) redirect that keeps the
path and query string:

| Host | Where the redirect lives |
| --- | --- |
| `www.noburf.com` | Redirect Rule "www.noburf.com to noburf.com" in the `noburf.com` zone |
| `noburf.llom.party` | Redirect Rule "noburf.llom.party to noburf.com" in the `llom.party` zone |

Keep `noburf.llom.party` attached and redirecting: the launch posts on X, Reddit and Discord link to it.
Redirect Rules are free (10 per zone on the Free plan) and run before Pages, so they don't add a Function.

## Why traffic does not bill

Checked against Cloudflare's docs on 2026-11-21:

- Requests for static assets are free and unlimited on the Free plan, and Cloudflare does not
  charge for bandwidth. A request counts as static when it does not run a Pages Function
  ([Pages Functions pricing](https://developers.cloudflare.com/pages/functions/pricing/)).
- This site has no Pages Functions: no `functions/` directory, no `_worker.js`, no `_routes.json`.
  Adding any of those makes requests count against the Workers quota (100,000 a day on the Free
  plan; past it, those requests fail with error 1027 rather than being billed).
- The Free plan has no metered usage, so nothing bills automatically. Charges start only if the
  account owner subscribes to Workers Paid ($5 a month minimum) or another paid product. Do not
  enable Workers Paid, R2, Workers KV, D1 or Workers AI for this site.
- Free plan limits that still apply: 500 builds a month, one build at a time, 20,000 files per
  deployment, 25 MiB per file ([Pages limits](https://developers.cloudflare.com/pages/platform/limits/)).
  The current build is about 110 files and 3 MB.
