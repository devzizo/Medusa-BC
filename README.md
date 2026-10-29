# Medusa BC

Product landing page for the Hoven Medusa store, deployed on Cloudflare Workers.

- `public/index.html` — the page (Arabic, RTL). Loads products from `/api/products`.
- `src/index.js` — Worker that proxies `/api/products` to the Medusa Store API
  (`/store/products`) using the store's publishable key, and serves `public/` for everything else.
- `wrangler.jsonc` — backend URL, publishable key and region (SAR) live in `vars`.

The Worker only uses the publishable key (Store API). Never put the secret `sk_` admin key in this repo.

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
