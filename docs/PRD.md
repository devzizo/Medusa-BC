# PRD: Medusa ↔ Business Central middleware

**Status:** draft for build · **Owner:** Hoven · **Date:** 2026-10-29
**Repo:** `devzizo/Medusa-BC` · **Runtime:** Cloudflare Workers

> **ملخص بالعربي:** خدمة وسيطة مستقلة خارج Medusa تربط متجر Medusa بـ Microsoft Dynamics 365
> Business Central. تقرأ الأصناف والأسعار والمخزون من BC وتكتبها في Medusa، وتربط المستودعات وطرق
> الدفع، ولاحقًا ترسل الطلبات من Medusa إلى BC. لا يُثبَّت شيء داخل Medusa: الوسيط يتكلم مع Medusa
> عبر Admin API بمفتاح سري (`sk_…`)، ومع BC عبر Entra ID (Client credentials). الإعدادات والتوكنات
> في متغيرات Cloudflare وأسرارها، ولا توكن في المستودع.

---

## 1. Why

The same integration exists today as a Medusa plugin (`@hoven/medusa-bc`, branch `alpha` of
`devzizo/essentials-starter`). It works, but living inside Medusa means:

- every change ships with a Medusa build and deploy (and its migrations);
- a long BC import runs inside the store's own server process;
- Medusa's database carries the integration's tables.

The middleware moves all of that out. Medusa stays a plain Medusa; the integration becomes a small
service that can be deployed, paused and rolled back on its own.

## 2. Goals and non-goals

**Goals**

1. Keep Medusa's catalog, prices and stock in step with Business Central, BC being the source of truth.
2. Map Medusa stock locations ↔ BC locations, and Medusa payment providers ↔ BC payment methods.
3. Later (phase 2): send Medusa orders to BC as sales documents.
4. All settings, including the Medusa token and the BC token, configurable without code changes.
5. Every run is observable: what it read, what it wrote, what it skipped and why.

**Non-goals**

- No code inside Medusa (no plugin, no module, no migration). Optional later: one tiny subscriber that
  pings the middleware on `order.placed`, only if polling proves too slow.
- No writes to BC in phase 1 (read only).
- No storefront changes.
- Not a general iPaaS: one Medusa store ↔ one BC company.

## 3. Users

| Who | Needs |
|---|---|
| Store owner / ops | Press "sync", see what changed, map locations and payment methods. |
| Developer | Configure tokens, deploy, read logs, re-run a failed run. |
| Scheduler (cron) | Run syncs on a schedule with no human. |

## 4. Architecture

```
            ┌──────────────────────── Cloudflare ────────────────────────┐
 Admin ───► │  Worker (HTTP: page + /api/middleware/*)                     │
 (browser)  │      │                                                       │
            │      ▼                                                       │
            │  Durable Object "MiddlewareStore" (SQLite + alarms)          │
            │   settings · mappings · runs · work queue                    │
            └──────────────┬───────────────────────────────────────────────┘
                           │
                     Medusa Admin API (sk_ secret key)
                     Business Central API v2.0 + OData (Entra ID token)
```

- **Worker (HTTP)**: the admin page (static assets in `public/`, one tab per feature: Settings,
  Locations, Payment methods, Item sync) and the API in `src/api.js`.
- **Durable Object `MiddlewareStore`** (`src/store.js`, SQLite storage): everything the page saves and
  every sync run. Built instead of D1 + Queues because it needs no resource created in advance (the
  deploy creates it), is strongly consistent, and its **alarms** drive a long run on the server.
- **Steps under a call budget**: one invocation may make 50 subrequests on the free plan. A sync is a
  chain of steps (`src/sync/items.js`); each makes at most `SYNC_STEP_BUDGET` calls (default 40),
  saves where it stopped, and sets an alarm for the next. Nothing depends on the page staying open.
- **Cron Triggers** (later): start scheduled runs through the same Durable Object.
- **Secrets** (Wrangler secrets, never in git): Medusa secret key, BC client secret, middleware admin token.

## 5. Settings (tokens and connection)

All settings come from the Worker environment, set in the Cloudflare dashboard (Variables and
Secrets); `wrangler.jsonc` keeps only `MEDUSA_BACKEND_URL` and sets `keep_vars` so deploys never
overwrite the dashboard. Secrets only as dashboard secrets / `wrangler secret put`, or `.dev.vars`
locally (git-ignored).
`.dev.vars.example` in the repo lists every name.

### 5.1 Medusa

| Name | Kind | Example | Notes |
|---|---|---|---|
| `MEDUSA_BACKEND_URL` | var | `https://hoven-sa.medusajs.app` | |
| `MEDUSA_ADMIN_API_KEY` | **secret** | `sk_…` | Medusa Admin → Settings → Secret API Keys. Sent as `Authorization: Basic <sk_…>` (Medusa docs: Basic, **not** Bearer; Bearer gives 401). Acts as the admin user who created it, so create a dedicated user for the integration. |
| `MEDUSA_SALES_CHANNEL_ID` | var | `sc_…` | Channel new products join. Empty = the store's default. |

### 5.2 Business Central

| Name | Kind | Example | Notes |
|---|---|---|---|
| `BC_ENVIRONMENT_URL` | var | `https://api.businesscentral.dynamics.com/v2.0/<tenant>/Production` | With or without `/api/v2.0`. |
| `BC_TENANT_ID` | var | GUID | Entra tenant. |
| `BC_CLIENT_ID` | var | GUID | Entra app registration (API permission `API.ReadWrite.All` / `Automation.ReadWrite.All`, app registered in BC "Microsoft Entra Applications"). |
| `BC_CLIENT_SECRET` | **secret** | | Client secret of that app. |
| `BC_COMPANY_ID` | var | GUID | Chosen from `/companies`; the company's **name** is read from BC at run time (OData needs the name, see §7.3). |
| `BC_AUTHORITY_URL` | var | `https://login.microsoftonline.com` | Override only for tests (a local fake Entra). |
| `BC_PRICE_LIST_SERVICE` | var | `SalesPriceLists` | Published page 7016. |
| `BC_PRICE_LIST_LINE_SERVICE` | var | `PriceListLines` | Published page 7001. |
| `BC_INVENTORY_SERVICE` | var | `ItemLedgerEntries` | Published page 38. |
| `BC_VAT_BUS_POSTING_GROUP` | var | `DOMESTIC` | Decides which VAT-inclusive price lists apply. |
| `BC_GEN_BUS_POSTING_GROUP` | var | `DOMESTIC` | Kept for documents sent to BC (phase 2). |

### 5.3 Middleware

| Name | Kind | Notes |
|---|---|---|
| `MIDDLEWARE_ADMIN_TOKEN` | **secret**, optional | Extra lock: when set, every `/api/middleware/*` call needs it as a Bearer token and the page asks for it. Unset (the owner's choice), the page relies on Cloudflare Access alone. |
| `SYNC_ITEMS_CRON`, `SYNC_INVENTORY_CRON` | wrangler `triggers.crons` | e.g. items nightly, inventory every 15 minutes. |

### 5.4 Settings endpoint

All behind the admin token, in `src/config.js`, and shown on the admin page's first tab, "Connection" (a Business Central
section and a Medusa section):

- `GET /api/middleware/status`: which settings are set or missing, **never a secret's value**.
- `POST /api/middleware/check/medusa`: `GET /admin/stores` with the secret key.
- `POST /api/middleware/check/bc`: fresh Entra token, `GET /companies`, and whether `BC_COMPANY_ID`
  is among them (the companies are listed so the right id can be copied).

## 6. Functional requirements

### 6.1 Item sync (BC → Medusa)

Reads, from the configured company:
`/itemCategories`, `/items?$filter=blocked eq false`, `/itemVariants` (API v2.0), and the two price
list pages over OData.

| Rule | Detail |
|---|---|
| Categories | One Medusa category per BC item category. Handle `bc-cat-<slug(code)>`. |
| Products | One per non-blocked item, created as **draft**. Handle `bc-<slug(number)>`. Title = Display Name, subtitle = Display Name 2. Category from Item Category Code. |
| Variants | One per non-blocked BC item variant; an item with none gets one default variant. SKU = `No.` or `No.-VariantCode`. Barcode = GTIN. Price = Unit Price (2 decimals). |
| Handles | `slug(code)` = lower-case, non `[a-z0-9]` → `-`. **When the slug changes the code (Arabic, spaces, symbols) append the first 8 hex of sha256(code)**, or Arabic codes all collapse to one handle (`bc-cat-x` "already exists" was a real failure). |
| Ownership | The middleware owns only products whose handle is `productHandle(metadata.bc_item_number)`. A SKU already used by another product → item skipped and reported, never overwritten. |
| Gone from BC | An owned product whose item BC no longer returns (deleted or blocked) → status **rejected**; back to **draft** if it returns. An empty item list from BC rejects nothing (treated as a fault). |
| Price lists | Only Status Active, Price Type Sale. Lists VAT-inclusive for another VAT Bus. Posting Group are skipped. Lines: skip Discount amount type, other units of measure, items/variants not imported. Blank variant code = all variants. Minimum Quantity > 1 → `min_quantity`. Date `0001-01-01` = none. Matched by `metadata.bc_price_list_code`; a list BC no longer offers → draft. |
| Idempotent | Re-running updates, never duplicates. Variant ids are kept (orders reference them). |
| Metadata | Product/variant: `bc_item_id`, `bc_item_number`, unit of measure, GTIN, posting groups, last modified. |

### 6.2 Inventory sync (BC → Medusa)

- Source: published **Item Ledger Entries** (page 38). Stock per location = sum of `Remaining_Quantity`
  of open entries (or `Quantity` over all entries if the page lacks Remaining Quantity).
- **Read the page's columns first** (`$top=1`), then `$select`/`$filter` only those. Hoven's page has
  **no `Variant_Code`** and BC answers 400 to a query naming it. Without it, stock goes to the item's
  own SKU and the run reports that variants get 0.
- For each owned variant and each mapped location: set the Medusa inventory level's
  `stocked_quantity` to BC's number; none in BC → 0; negative → 0 and reported.
- A variant without an inventory item gets one (same SKU), linked, and `manage_inventory` on.
  Medusa does not create it when `manage_inventory` is switched on later.
- Locations not mapped and products not owned are never touched. A mapped Medusa location with no
  sales channel is reported (its stock cannot be sold).
- **Complete or fail:** every BC list is read to the end of `@odata.nextLink`. Past the page cap
  (1000) the run fails; a short list would read as "zero stock".

### 6.3 Mappings

| Mapping | Medusa side | BC side | Stored |
|---|---|---|---|
| Locations | `GET /admin/stock-locations` | `/companies({id})/locations` | `location_map` |
| Payment methods | `GET /admin/payments/payment-providers` | `/companies({id})/paymentMethods` (page 427) | `payment_map` |

Saving checks both sides against the live lists. Changing `BC_COMPANY_ID` or the BC environment
clears both mappings (they name another company's codes).

### 6.4 Order export (phase 2, Medusa → BC)

- Trigger: cron polls `GET /admin/orders?updated_at[$gt]=<cursor>`; cursor in the Durable Object.
- Creates a BC `salesOrders` (or `salesInvoices`) with customer, lines by SKU → item/variant,
  location from the fulfillment's stock location map, payment method from the payment map, posting
  groups from settings. Idempotent by `externalDocumentNumber = medusa order display id`.
- Out of scope until phase 1 is in production.

### 6.5 Runs and the admin page

- Tabs: **Settings** (read-only status of §5, with "Check connection"), **Locations**,
  **Payment methods**, **Item sync**, **Inventory sync**.
- Each sync: "Preview" (counts + 2 raw rows per source, nothing written), "Run", and the last 10 runs
  with summary counts and issues (capped at 500 per run).
- One run at a time across both kinds. A run older than 2 h is treated as dead.

## 7. Integration details

### 7.1 Medusa Admin API

Auth header: `Authorization: Basic <MEDUSA_ADMIN_API_KEY>`. Endpoints used:
`/admin/product-categories`, `/admin/products` (+ `/variants`, `/options`), `/admin/price-lists`
(+ `/prices/batch`), `/admin/inventory-items` (+ `/location-levels/batch`), `/admin/stock-locations`,
`/admin/payments/payment-providers`, `/admin/stores`, `/admin/sales-channels`,
`/admin/shipping-profiles`, phase 2 `/admin/orders`.

Medusa 2.19 facts that cost time:

- Product options are shared between products. To add a value to an existing product, link it via the
  product's options; never send `options`/`variants` in a product update (it rebuilds options and
  orphans variant values).
- Prices are stored in the major unit (`98` = 98 SAR). Never ×/÷ 100. The store sells in SAR only.
- Workflow errors come back as JSON `{ type, message }`; show `message`.
- **With LS Central switched on, Medusa refuses price writes over the admin API** ("Prices are managed in
  LS Central…", the `@hoven/ls-central` guard on product, variant and price-list routes). Only creating a
  product may carry prices. The item sync then writes everything else without prices, notes it once,
  and skips price lists for that run. Measured on a local Medusa with the plugin, both switched on and off.

### 7.2 Business Central API v2.0

- Token: `POST {authority}/{tenant}/oauth2/v2.0/token`, client credentials, scope
  `https://api.businesscentral.dynamics.com/.default`. Cache per (tenant, client, hash(secret)) until
  60 s before expiry; the "check connection" always asks for a fresh one.
- `GET {env}/api/v2.0/companies`, `/companies({id})/locations | itemCategories | items | itemVariants |
  paymentMethods`. Paging via `@odata.nextLink` (absolute URL).
- 30 s timeout per call; errors classified: `auth_failed`, `timeout`, `network`, `http_error` with BC's
  own message.

### 7.3 Business Central OData (published pages)

`{env}/ODataV4/Company('{company NAME}')/{ServiceName}` — by **name**, not id or display name
(`Hoven Ltd` vs `HOVEN LTD` was a real 404). Escape `'` as `''`. Field names are the page's control
captions with `_` (`Item_No`, `Location_Code`, `Remaining_Quantity`); price list lines use
`Asset_*` on older and `Product_*` on newer versions, so read both. Pages differ per tenant: detect
columns, never assume them.

## 8. Data (Durable Object SQLite, `src/store.js`)

```sql
CREATE TABLE setting      (key TEXT PRIMARY KEY, value TEXT);   -- company, posting groups, page names
CREATE TABLE location_map (stock_location_id TEXT PRIMARY KEY, bc_company_id TEXT NOT NULL,
                           bc_location_code TEXT NOT NULL, bc_location_name TEXT);
CREATE TABLE payment_map  (payment_provider_id TEXT PRIMARY KEY, bc_company_id TEXT NOT NULL,
                           bc_payment_method_code TEXT NOT NULL, bc_payment_method_name TEXT);
CREATE TABLE run          (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
                           started_at TEXT NOT NULL, finished_at TEXT, state TEXT NOT NULL,
                           summary TEXT NOT NULL, issues TEXT NOT NULL, error TEXT);
CREATE TABLE work         (run_id TEXT, kind TEXT, seq INTEGER, key TEXT, payload TEXT, result TEXT,
                           PRIMARY KEY (run_id, kind, seq));  -- one row per category/product/price list
```

No id map table is needed in phase 1: BC identity is carried in Medusa handles, SKUs and metadata.

## 9. Security

- Secrets only in Wrangler secrets / `.dev.vars`; never in `wrangler.jsonc`, logs, run summaries or
  API responses (status says *set* / *missing*).
- Medusa secret key belongs to a dedicated admin user; revoke = cut the integration off.
- BC app gets read permissions in phase 1; write only when phase 2 starts.
- The admin page and `/api/middleware/*` behind Cloudflare Access; `MIDDLEWARE_ADMIN_TOKEN` as an optional
  second lock. Before any write endpoint (syncs) ships, one of the two must be in place.

## 10. Acceptance criteria

1. `GET /api/middleware/status?check=1` reports both sides connected with real tokens, and never
   prints a token.
2. Item sync on a fake BC with Arabic and symbol codes creates distinct handles; a second run creates
   nothing new; a blocked item's product becomes rejected and returns to draft.
3. Inventory sync against a page without `Variant_Code`, split over two pages, sets the right
   quantities in every mapped location; a third run changes nothing.
4. A product with a clashing SKU is never modified.
5. Mappings survive a reload and are cleared by a company change.
6. Killing the Worker mid-run leaves a run that the next start marks failed, not a stuck lock.

## 11. Test plan

- Unit: pure mapping (handles, prices, price lists, ledger sums, column detection).
- A local `http.createServer` fake for Entra + BC (API v2.0 and OData), as the plugin's tests do.
  Do not stub `fetch`.
- A local Medusa 2.19 with Postgres, reached over its real Admin API with a real secret key.
- `wrangler dev` for the Worker; one run of each sync end to end before any deploy.

## 12. Rollout

1. Deploy the Worker with settings and status only (this PR).
2. Item sync against a non-production Medusa environment.
3. Inventory sync; then switch off the plugin's syncs on that environment.
4. Production; remove the plugin from Medusa once the middleware has run clean for a week
   (use the plugin's off switch first, never drop it from `medusa-config.ts` blindly: its link
   tables would be offered for deletion).
5. Phase 2 (orders).

## 13. Open questions

- Sync cadence for inventory (15 min?) and items (nightly?).
- Sales order vs. sales invoice in BC for web orders; customer per order or one web customer?
- Which Medusa environment is the first target (Medusa Cloud `alpha` or a new one)?
- Variants: will BC's page 38 get a Variant Code column, or are Hoven items variant-free?
