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

All settings live in the Cloudflare dashboard: **Workers & Pages → medusa-bc → Settings → Variables
and Secrets**. `wrangler.jsonc` sets `keep_vars`, so deploys never overwrite them.

| Name | Type | Value |
|---|---|---|
| `BC_ENVIRONMENT_URL` | Text | `https://api.businesscentral.dynamics.com/v2.0/<tenant>/Production` |
| `BC_TENANT_ID` | Text | Entra tenant id |
| `BC_CLIENT_ID` | Text | Entra app (client) id |
| `BC_CLIENT_SECRET` | Secret | Entra app client secret |
| `BC_COMPANY_ID` | Text | Company id (the BC check lists them) |
| `MEDUSA_BACKEND_URL` | Text | Set in `wrangler.jsonc`: `https://hoven-sa.medusajs.app` |
| `MEDUSA_ADMIN_API_KEY` | Secret | Medusa Admin → Settings → Secret API Keys (`sk_...`) |
| `MIDDLEWARE_ADMIN_TOKEN` | Secret, optional | Only if the page should ask for a token |

Secrets can also be set with `npx wrangler secret put <NAME>`. Never commit any of them.

Locally, copy `.dev.vars.example` to `.dev.vars` (git-ignored).

### Check the connection

Open the admin page, or call the API. **Protect the page with Cloudflare Access** (Worker → Settings →
Domains & Routes): the API has no login of its own unless the optional `MIDDLEWARE_ADMIN_TOKEN`
secret is set, in which case every call needs `Authorization: Bearer <token>` and the page asks for it.

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
