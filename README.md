# Portfolio — Suryansh Kumar

Personal portfolio site. Static frontend on GitHub Pages, LeetCode statistics served by a
Cloudflare Worker at the edge.

**Live:** https://suryansh4053.github.io/Portfolio-/

## Layout

```
index.html                       the whole frontend — no build step, no dependencies
data/leetcode.json               cached stats, refreshed by the sync workflow
worker/                          Cloudflare Worker serving the LeetCode API
  src/index.js                   request handling, caching, CORS
  wrangler.toml                  Worker config and environment variables
.github/workflows/
  sync-leetcode.yml              refreshes data/leetcode.json every 6 hours
  deploy-worker.yml              deploys the Worker on push to worker/
```

## How the LeetCode card gets its numbers

The frontend tries four sources in order and renders the first that answers:

1. **Own Worker API** — live, edge-cached, the only source whose uptime is ours to fix.
2. **`data/leetcode.json`** — committed by the sync workflow every 6 hours. Renders
   immediately while the network sources are still in flight, and labels itself *cached*.
3. **Third-party LeetCode APIs** — two public mirrors, kept only as a last resort.

That ordering exists because the public mirrors are not dependable: as of July 2026 two of
the three return HTTP 429, and the Heroku-hosted one is gone entirely. The repo feed means
the card is never empty even when every network source fails.

## API

Base URL: the deployed Worker (`https://leetcode-api.<subdomain>.workers.dev`).

| Route | Purpose |
| --- | --- |
| `GET /leetcode` | Stats for the user in `LC_USER` |
| `GET /leetcode/:username` | Stats for any public LeetCode user |
| `GET /health` | Liveness probe |

```json
{
  "total": 19, "easy": 15, "medium": 4, "hard": 0,
  "streak": 9, "activeDays": 17,
  "calendar": { "1785024000": 2 },
  "syncedAt": "2026-07-28T00:00:00.000Z"
}
```

Responses carry `X-Cache: HIT | MISS | STALE`. Caching is two-layered: a 60-second
isolate-local memo that works everywhere, and the Cloudflare Cache API (15 min fresh,
24 h stale) which only takes effect on a custom domain — cache operations are deliberate
no-ops on `*.workers.dev`. If LeetCode is unreachable the last good response is served as
`STALE` rather than failing, so the card never renders empty.

## Deploying

The Worker deploys from CI, not from a laptop — push anything under `worker/` and
`deploy-worker.yml` ships it. It needs one repository secret, `CLOUDFLARE_API_TOKEN`
(Cloudflare dashboard → My Profile → API Tokens → *Edit Cloudflare Workers* template).

The frontend deploys itself: GitHub Pages serves `main` at the repository root.

## Configuration

Everything personal lives in the `CONFIG` object at the top of the `<script>` in
`index.html` — username, email, links, résumé filename, and the Worker URL. The Worker's
own settings (`LC_USER`, `ALLOWED_ORIGINS`) live in `worker/wrangler.toml`.
