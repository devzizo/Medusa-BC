---
name: medusa-bc-middleware
description: Build, extend or debug the Medusa ↔ Business Central middleware in this repo (a Cloudflare Worker that syncs BC items, prices, stock, locations and payment methods into Medusa over its Admin API). Use for any work on item sync, inventory sync, mappings, the token settings, or the BC/Medusa clients.
---

# Medusa ↔ Business Central middleware

The full product spec is `docs/PRD.md`. Read it first; this file is how to work on it.

## What it is

A Cloudflare Worker, outside Medusa, that:

- reads Business Central (API v2.0 + published OData pages) with an Entra ID client-credentials token;
- writes Medusa through its Admin API with a secret key (`sk_…`);
- keeps its own state (settings, mappings, runs) in one Durable Object with SQLite (`src/store.js`),
  and runs a long sync as alarm-driven steps under a call budget (`src/sync/items.js`).

It replaces the in-Medusa plugin `@hoven/medusa-bc` (repo `devzizo/essentials-starter`, branch `alpha`,
`packages/medusa-bc`). That plugin's `src/lib/import/map.ts`, `src/lib/inventory/map.ts` and
`src/lib/bc-client.ts` are tested, pure and portable: port them rather than rewrite them.

## Settings and tokens

- Every setting is in the Worker env. Names and meaning: PRD §5, and `.dev.vars.example`.
- `MIDDLEWARE_ADMIN_TOKEN` is optional (owner's choice: the page has no token field unless it is set);
  the page is meant to sit behind Cloudflare Access. Do not add write endpoints without one of the two.
- Secrets (`MEDUSA_ADMIN_API_KEY`, `BC_CLIENT_SECRET`, optional `MIDDLEWARE_ADMIN_TOKEN`) only via
  `npx wrangler secret put <NAME>` or a local `.dev.vars` (git-ignored). Never in `wrangler.jsonc`,
  never echoed, logged, returned by an endpoint, or pasted into chat. Ask the owner to set them;
  do not ask for their values.
- `src/config.js` reads and validates settings: `GET /api/middleware/status` reports set/missing,
  `POST /api/middleware/check/medusa` and `/check/bc` test each side live. The landing page
  (`public/index.html`) shows both as tabs.
- Medusa secret key header: `Authorization: Basic <sk_…>`. Bearer returns 401.

## Rules that are not visible in the code

1. **BC is the source of truth; the middleware updates only what it created.** Owned product = handle
   `productHandle(metadata.bc_item_number)`. Never modify a product whose SKU clashes: skip and report.
   (Exceptions by design: the draft rule (7) and stock (by SKU) reach every Medusa product.)
2. **Complete or fail.** Follow `@odata.nextLink` to the end; past the page cap throw. A short list
   reads as "not in BC" (→ draft) or "zero stock".
3. **Handles are stable and unique.** Slug the code; if the slug changed it (Arabic, spaces, symbols),
   append 8 hex of sha256(code). Changing the slug function orphans what earlier runs created.
4. **Detect OData columns, never assume them.** Read `$top=1`, then select only what exists. Hoven's
   Item Ledger Entries page has no `Variant_Code`; naming it gets HTTP 400.
5. **OData is addressed by company NAME** (from `/companies`), not id, not display name.
6. **Medusa 2.19:** options are shared; never pass `options`/`variants` in a product update. Prices in
   the major unit (SAR), never ×100. `manage_inventory: true` set later creates no inventory item:
   create it, link it, then switch it on.
7. **Not in BC → draft, for every Medusa product** (owner's decision): in BC = made by the sync for an item
   BC returns, or any variant SKU BC has. An empty BC item list changes nothing. Page Medusa lists by
   `id`, never `created_at` (ties reorder between pages and products get skipped).
8. **One run at a time** across item and inventory syncs; a run older than 2 h is dead, mark it failed.
9. Mappings name one BC company's codes: a company change clears them.
10. **Every step stays under the subrequest budget** (`SYNC_STEP_BUDGET`, default 40; the free plan
    allows 50 per invocation). A stage must save its cursor before it returns, and never start a
    product it cannot finish within what is left.
11. **LS Central may own prices.** If Medusa answers "Prices are managed in LS Central", write the rest
    without prices and skip price lists; do not treat it as a failure.

## How to verify (before any deploy)

- Unit tests for every pure mapping.
- A local `http.createServer` standing in for Entra + BC (API v2.0 and OData, including a page
  without `Variant_Code` and a two-page `@odata.nextLink`). Do not stub `fetch`.
- A real local Medusa 2.19 + Postgres reached over its Admin API with a real secret key.
- `npx wrangler dev`, then run each sync twice: the second run must change nothing.
- Report what was not verified, plainly.

## Deploy

`npx wrangler deploy` (or the Cloudflare dashboard's Git integration on this repo). The Worker serves
only the middleware: the admin page in `public/` (one tab per feature, "Connection" first) and
`/api/middleware/*`. The old products landing page was removed on purpose.
