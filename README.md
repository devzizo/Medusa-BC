# Medusa BC

The middleware between the Hoven Medusa store and Microsoft Dynamics 365 Business Central, on
Cloudflare Workers. It syncs Business Central into Medusa from outside Medusa.

Live: https://medusa-bc.dev-zizo.workers.dev

The admin page (`public/index.html`, Arabic, RTL) has five tabs, the same tools the in-Medusa plugin had:

1. **الإعدادات (Settings)** — connection checks for Business Central and Medusa, the BC company
   (chosen from BC's own list; changing it clears both mappings), the posting groups (Store VAT Bus.
   Post. Gr., Gen. Business Posting Group) and the price list web service names.
2. **ربط المستودعات (Locations)** — each Medusa stock location → one BC location.
3. **طرق الدفع (Payment methods)** — each Medusa payment provider → one BC payment method.
4. **مزامنة الأصناف (Item sync)**, with two sub-tabs. **الفئات (Categories)** pulls BC's item categories
   into Medusa alone (create, rename, never duplicate). **المنتجات (Products)** is the full sync: categories, non-blocked items with variants and unit price, and
   active sales price lists, BC → Medusa. New products are drafts; a clashing SKU is skipped. **Every
   Medusa product whose handle matches no BC item becomes a draft**, whoever created it (BC is the
   origin). Options in Settings: blocked items not imported; zero stock in BC → draft. A third
   sub-tab, **الصور (Images)**, moves each BC item's picture to the product the sync created, through
   Medusa's file storage (S3/R2 on Medusa Cloud): first image, and thumbnail unless the admin chose
   another; images added in Medusa stay; an unchanged picture is not uploaded again; one removed in
   BC is removed from the product.
5. **مزامنة المخزون (Inventory sync)** — for every Medusa variant whose SKU BC has, and every
   **mapped** stock location, the stocked quantity becomes the BC location's stock (Item Ledger
   Entries, page 38). None in BC → 0. Unmapped locations and products not in BC are not touched.
6. **نقل العملاء (Customers)** — every BC customer (blocked ones too) → a Medusa customer with one
   address named "Business Central", owned by `metadata.bc_customer_number` (a second run updates,
   never duplicates; customers not from BC are never touched). An email another customer already
   holds, or an invalid one, is left out and listed in the notes.

Duplicate barcodes found by the item sync are listed apart ("باركود مكرر") with the Medusa product
that holds the barcode, and every note downloads as CSV, for fixing by hand.

Code:

- `src/index.js` — serves the page, routes `/api/middleware/*`, exports the Durable Object.
- `src/api.js` — the API behind the page.
- `src/store.js` — Durable Object `MiddlewareStore` (SQLite): settings, mappings, sync runs.
- `src/sync/items.js`, `src/sync/inventory.js`, `src/sync/customers.js`, `src/sync/images.js` — the syncs, as steps under a subrequest budget
  driven by alarms.
- `src/lib/bc.js`, `src/lib/medusa.js`, `src/lib/map.js` — BC client, Medusa Admin client, the pure
  mapping rules; `src/lib/inventory.js` the stock arithmetic, `src/lib/customers.js` the customer mapping (both ported from the plugin, tested
  in `test/`: `npm test`).
- `docs/PRD.md` — the full spec. `.claude/skills/medusa-bc-middleware/SKILL.md` — how to work on it.

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
| `MEDUSA_BACKEND_URL` | Text | Set in `wrangler.jsonc`: `https://hoven-sa.medusajs.app` |
| `MEDUSA_ADMIN_API_KEY` | Secret | Medusa Admin → Settings → Secret API Keys (`sk_...`) |
| `MIDDLEWARE_ADMIN_TOKEN` | Secret, optional | Only if the page should ask for a token |
| `SYNC_STEP_BUDGET` | Text, optional | Calls per sync step (default 40; up to ~900 on a paid plan) |

The company is chosen in the Settings tab, not here.

Secrets can also be set with `npx wrangler secret put <NAME>`. Never commit any of them.

Locally, copy `.dev.vars.example` to `.dev.vars` (git-ignored).

### Deploy

```bash
npx wrangler deploy
```

The Durable Object is created by its first `wrangler deploy` (a migration); `wrangler versions upload`
cannot create it, so a preview version alone is not enough the first time.

### API

Open the admin page, or call the API. **Protect the page with Cloudflare Access** (Worker → Settings →
Domains & Routes): the API has no login of its own unless the optional `MIDDLEWARE_ADMIN_TOKEN`
secret is set, in which case every call needs `Authorization: Bearer <token>` and the page asks for it.

| Route | Does |
|---|---|
| `GET /api/middleware/status` | Env settings (set / missing, never a secret's value) and the saved settings. |
| `POST /api/middleware/check/medusa` | Calls `GET /admin/stores` with the Medusa secret key. |
| `POST /api/middleware/check/bc` | Fresh Entra token, BC companies, whether the chosen one is there. |
| `POST /api/middleware/company` | `{ company_id }` from BC's list; clears both mappings when it changes. |
| `POST /api/middleware/settings` | Posting groups and price list service names. |
| `GET/POST /api/middleware/mappings/{locations,payments}` | Both lists live, and the saved mapping; POST `{ mappings: [{ id, code }] }`. |
| `GET /api/middleware/{items,categories,images,inventory,customers}/runs`, `POST …/run` | Sync history; start a run (one at a time). |

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
