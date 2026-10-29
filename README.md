# Medusa BC

The middleware between the Hoven Medusa store and Microsoft Dynamics 365 Business Central, on
Cloudflare Workers. It syncs Business Central into Medusa from outside Medusa.

Live: https://medusa-bc.dev-zizo.workers.dev

- `public/index.html` — the admin page (Arabic, RTL), one tab per feature. The first tab,
  **فحص الاتصال (Connection)**, takes the middleware token and shows a Business Central section and a
  Medusa section, each listing its settings (set / missing) with a "check connection" button.
- `src/index.js` — serves the page and routes `/api/middleware/*`.
- `src/config.js` — the Medusa and BC token settings and the middleware API (below).
- `docs/PRD.md` — the full spec: architecture, settings, sync rules, acceptance criteria.
- `.claude/skills/medusa-bc-middleware/SKILL.md` — how to build and verify it (for Claude Code).

Never put the Medusa secret `sk_` key, the BC client secret or the middleware token in this repo.

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

Open the admin page, or call the API (all need `Authorization: Bearer $MIDDLEWARE_ADMIN_TOKEN`):

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
