# Medusa BC

Product landing page for the Hoven Medusa store, deployed on Cloudflare Workers.

Live: https://medusa-bc.dev-zizo.workers.dev

- `public/index.html` — the page (Arabic, RTL). Loads products from `/api/products`.
- `src/index.js` — Worker that proxies `/api/products` to the Medusa Store API
  (`/store/products`) using the store's publishable key, and serves `public/` for everything else.
- `wrangler.jsonc` — backend URL, publishable key and region (SAR) live in `vars`.

The landing page only uses the publishable key (Store API). Never put the secret `sk_` admin key in this repo.

## Middleware (Medusa ↔ Business Central)

This Worker is becoming the middleware that syncs Business Central into Medusa from outside Medusa.

- `docs/PRD.md` — the full spec: architecture, settings, sync rules, acceptance criteria.
- `.claude/skills/medusa-bc-middleware/SKILL.md` — how to build and verify it (for Claude Code).
- `src/config.js` — the Medusa and BC token settings and the middleware API (below).
- `public/index.html` — the landing page: enter the middleware token, then a **Business Central** tab
  and a **Medusa** tab, each listing its settings (set / missing) with a "check connection" button.
  The old products page moved to `/products`.

### Settings

Non-secret values are `vars` in `wrangler.jsonc` (`BC_ENVIRONMENT_URL`, `BC_TENANT_ID`, `BC_CLIENT_ID`,
`BC_COMPANY_ID`, ...). Secrets are set once per environment, never committed:

```bash
npx wrangler secret put MEDUSA_ADMIN_API_KEY   # Medusa Admin > Settings > Secret API Keys (sk_...)
npx wrangler secret put BC_CLIENT_SECRET       # Entra ID app client secret
npx wrangler secret put MIDDLEWARE_ADMIN_TOKEN # any long random string
```

Locally, copy `.dev.vars.example` to `.dev.vars` (git-ignored).

### Check the connection

Open the landing page, or call the API (all need `Authorization: Bearer $MIDDLEWARE_ADMIN_TOKEN`):

| Route | Does |
|---|---|
| `GET /api/middleware/status` | Which settings are set or missing (never a secret's value). |
| `POST /api/middleware/check/medusa` | Calls `GET /admin/stores` with the Medusa secret key. |
| `POST /api/middleware/check/bc` | Gets a fresh Entra token, lists BC companies, confirms `BC_COMPANY_ID`. |

## Deploy

**From the Cloudflare dashboard (recommended):** Workers & Pages → Create → Import a repository → pick `devzizo/Medusa-BC`. Leave the build command empty; the deploy command is `npx wrangler deploy`.

**From the command line:**

```bash
npx wrangler deploy
```

## Local preview

```bash
npx wrangler dev
```
