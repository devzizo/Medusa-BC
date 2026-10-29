import { bcCredentials, listBcItemCategories, listBcItems, listBcItemVariants, listBcODataRows } from "../lib/bc.js";
import { makeBudget, medusaClient } from "../lib/medusa.js";
import { mapCategories, mapItems, mapPriceLists, productHandle } from "../lib/map.js";

// The item sync, BC → Medusa: categories, items that are not blocked (with
// their variants and unit price), and active sales price lists, the same
// rules as the in-Medusa plugin. A Worker invocation may only make so many
// subrequests (50 on the free plan), so the sync runs as a chain of steps:
// each step does what fits in BUDGET calls, saves where it stopped in the
// Durable Object, and the next alarm carries on.
//
// It owns only what it created: a product whose handle is the one it gives
// that item number. A SKU already used by another product skips the item.

const BUDGET = 40;
const PRODUCT_FIELDS =
  "id,handle,status,variants.id,variants.sku,options.id,options.title,options.values.id,options.values.value";

export const DEFAULT_PRICE_LIST_SERVICE = "SalesPriceLists";
export const DEFAULT_PRICE_LIST_LINE_SERVICE = "PriceListLines";

/** One step. Returns true when the run is finished. */
export async function runItemSyncStep(ctx, env) {
  // SYNC_STEP_BUDGET can raise it on a paid plan (1000 subrequests per invocation).
  const budget = makeBudget(Number(env.SYNC_STEP_BUDGET) || BUDGET);
  const medusa = medusaClient(env, budget);
  const bc = bcCredentials(env);
  const { state } = ctx;
  const stages = { read, categories, products, reject, priceListsRead, variantIds, priceLists };
  // Stages run back to back within one step while the budget lasts.
  while (state.stage !== "done" && budget.left() > 5) {
    const before = `${state.stage}:${state.cursor}`;
    await stages[state.stage]({ ctx, env, budget, medusa, bc });
    // A stage that stopped without moving is waiting for a fresh budget.
    if (`${state.stage}:${state.cursor}` === before) break;
  }
  return state.stage === "done";
}

const next = (state, stage) => {
  state.stage = stage;
  state.cursor = 0;
};

// ---- read: BC catalog and Medusa store context ----

async function read({ ctx, medusa, bc, budget }) {
  const { state, summary, settings } = ctx;
  if (!settings.company_id) throw new Error("Choose a Business Central company in Settings first.");
  const options = { budget };
  const [bcCategories, bcItems, bcVariants] = await Promise.all([
    listBcItemCategories(bc, settings.company_id, options),
    listBcItems(bc, settings.company_id, options),
    listBcItemVariants(bc, settings.company_id, options),
  ]);
  summary.bc_categories = bcCategories.length;
  summary.bc_items = bcItems.length;
  summary.bc_variants = bcVariants.length;

  const { stores } = await medusa.get("/admin/stores", { fields: "supported_currencies.currency_code,supported_currencies.is_default" });
  const currencies = stores?.[0]?.supported_currencies ?? [];
  const currency = (currencies.find((c) => c.is_default) ?? currencies[0])?.currency_code;
  if (!currency) throw new Error("The Medusa store has no currency.");
  const { sales_channels } = await medusa.get("/admin/sales-channels", { limit: 1, fields: "id" });
  const { shipping_profiles } = await medusa.get("/admin/shipping-profiles", { type: "default", limit: 1, fields: "id" });

  const mapped = mapItems(bcItems, bcVariants, currency.toLowerCase());
  mapped.issues.forEach(ctx.note);
  ctx.putWork("category", mapCategories(bcCategories).map((category) => ({ key: category.handle, payload: category })));
  ctx.putWork("product", mapped.products.map((product) => ({ key: product.handle, payload: product })));
  state.context = {
    currency: currency.toLowerCase(),
    sales_channel_id: sales_channels?.[0]?.id ?? null,
    shipping_profile_id: shipping_profiles?.[0]?.id ?? null,
  };
  Object.assign(summary, { categories_created: 0, categories_updated: 0, products_created: 0, products_updated: 0, products_skipped: 0 });
  next(state, "categories");
}

// ---- categories: upsert by handle ----

async function categories({ ctx, medusa, budget }) {
  const { state, summary } = ctx;
  const rows = ctx.work("category", state.cursor, 25);
  if (!rows.length) return next(state, "products");
  const { product_categories: existing } = await medusa.get("/admin/product-categories", {
    handle: rows.map((row) => row.key),
    fields: "id,handle,name",
    limit: rows.length,
  });
  const byHandle = new Map(existing.map((category) => [category.handle, category]));
  for (const row of rows) {
    if (budget.left() < 2) return;
    const current = byHandle.get(row.key);
    const category = row.payload;
    if (!current) {
      const { product_category } = await medusa.post("/admin/product-categories", { ...category, is_active: true, is_internal: false });
      ctx.setResult("category", row.seq, { id: product_category.id });
      summary.categories_created++;
    } else {
      if (current.name !== category.name) {
        await medusa.post(`/admin/product-categories/${current.id}`, { name: category.name, metadata: category.metadata });
        summary.categories_updated++;
      }
      ctx.setResult("category", row.seq, { id: current.id });
    }
    state.cursor = row.seq + 1;
  }
}

// ---- products: create new as draft, update ours piece by piece ----

// Calls a product costs, so a step never starts one it cannot finish.
const productCost = (product, current) => (current ? 3 + product.variants.length : 1);

async function products({ ctx, medusa, budget }) {
  const { state, summary } = ctx;
  const rows = ctx.work("product", state.cursor, 5);
  if (!rows.length) return next(state, "reject");
  if (budget.left() < 8) return;

  const categoryIds = new Map(ctx.work("category").filter((row) => row.result).map((row) => [row.key, row.result.id]));
  const { products: existing } = await medusa.get("/admin/products", { handle: rows.map((row) => row.key), fields: PRODUCT_FIELDS, limit: rows.length });
  const byHandle = new Map(existing.map((product) => [product.handle, product]));
  const skus = rows.flatMap((row) => row.payload.variants.map((variant) => variant.sku));
  const { variants: owners } = await medusa.get("/admin/product-variants", { sku: skus, fields: "sku,product.handle,product.title", limit: skus.length });
  const ownerOfSku = new Map(owners.map((variant) => [variant.sku, variant.product]));

  for (const row of rows) {
    const product = row.payload;
    const current = byHandle.get(product.handle);
    if (budget.left() < productCost(product, current) + 1) return;
    state.cursor = row.seq + 1;

    const clash = product.variants.map((v) => ({ sku: v.sku, owner: ownerOfSku.get(v.sku) })).find(({ owner }) => owner && owner.handle !== product.handle);
    if (clash) {
      ctx.note({ kind: "sku", ref: clash.sku, message: `SKU already used by "${clash.owner.title}" (${clash.owner.handle}); item skipped.` });
      ctx.setResult("product", row.seq, { status: "skipped" });
      summary.products_skipped++;
      continue;
    }
    const categoryId = product.category_handle ? categoryIds.get(product.category_handle) : undefined;
    try {
      if (!current) {
        const { category_handle, ...body } = product;
        await medusa.post("/admin/products", {
          ...body,
          status: "draft",
          ...(categoryId ? { categories: [{ id: categoryId }] } : {}),
          ...(ctx.state.context.sales_channel_id ? { sales_channels: [{ id: ctx.state.context.sales_channel_id }] } : {}),
          ...(ctx.state.context.shipping_profile_id ? { shipping_profile_id: ctx.state.context.shipping_profile_id } : {}),
        });
        ctx.setResult("product", row.seq, { status: "created" });
        summary.products_created++;
      } else {
        await updateProduct(ctx, medusa, product, current, categoryId);
        ctx.setResult("product", row.seq, { status: "updated" });
        summary.products_updated++;
      }
    } catch (error) {
      ctx.note({ kind: "product", ref: product.handle, message: `${current ? "Update" : "Create"} failed: ${error.message}` });
      // A failed update is still our product: its prices stay in the price lists.
      ctx.setResult("product", row.seq, { status: current ? "update_failed" : "create_failed" });
    }
  }
}

// When LS Central is switched on in Medusa, it owns prices and Medusa's
// admin API refuses any write that carries them (creating a product is the
// one exception). Then the sync writes everything else without prices,
// says so once, and leaves price lists alone for the rest of the run.
const PRICES_REFUSED = /prices are managed/i;

async function withPrices(ctx, write, body) {
  if (!ctx.state.pricesRefused && body.prices?.length) {
    try {
      return await write(body);
    } catch (error) {
      if (!PRICES_REFUSED.test(error.message)) throw error;
      ctx.state.pricesRefused = error.message.replace(/^Medusa \S+ \S+: /, "");
      ctx.note({ kind: "prices", ref: "Medusa", message: `Prices not written: ${ctx.state.pricesRefused}` });
    }
  }
  const { prices, ...rest } = body;
  return write(rest);
}

// Never sends options or variants in the product update: Medusa 2.19
// rebuilds the options from them and orphans the variants' values. Variants
// matched by SKU keep their ids; new BC variants get their option value
// linked to the product first (options are shared), then are created.
async function updateProduct(ctx, medusa, product, current, categoryId) {
  await medusa.post(`/admin/products/${current.id}`, {
    title: product.title,
    subtitle: product.subtitle ?? null,
    metadata: product.metadata,
    ...(categoryId ? { categories: [{ id: categoryId }] } : {}),
    // Back in BC after being rejected: a draft again, for an admin to publish.
    ...(current.status === "rejected" ? { status: "draft" } : {}),
  });
  const idBySku = new Map(current.variants.map((variant) => [variant.sku, variant.id]));
  for (const variant of product.variants) {
    const id = idBySku.get(variant.sku);
    if (!id) continue;
    await withPrices(ctx, (body) => medusa.post(`/admin/products/${current.id}/variants/${id}`, body), {
      title: variant.title,
      ...(variant.barcode ? { barcode: variant.barcode } : {}),
      metadata: variant.metadata,
      prices: variant.prices,
    });
  }
  const added = product.variants.filter((variant) => !idBySku.has(variant.sku));
  if (!added.length) return;
  const update = [];
  for (const option of current.options) {
    const linked = new Set((option.values ?? []).map((v) => v.value));
    const wanted = [...new Set(added.map((variant) => variant.options[option.title]).filter((v) => v && !linked.has(v)))];
    if (!wanted.length) continue;
    const { product_option } = await medusa.get(`/admin/product-options/${option.id}`, { fields: "values.id,values.value" });
    const known = new Map((product_option.values ?? []).map((v) => [v.value, v.id]));
    update.push({ product_option_id: option.id, add: wanted.map((v) => known.get(v) ?? { value: v }) });
  }
  for (const variant of added) {
    for (const title of Object.keys(variant.options)) {
      if (!current.options.some((option) => option.title === title)) {
        throw new Error(`Option "${title}" is missing on ${product.handle}; delete the product and sync again.`);
      }
    }
  }
  if (update.length) await medusa.post(`/admin/products/${current.id}/options/batch`, { update });
  if (ctx.state.pricesRefused) {
    await medusa.post(`/admin/products/${current.id}/variants/batch`, { create: added.map(({ prices, ...variant }) => variant) });
    return;
  }
  try {
    await medusa.post(`/admin/products/${current.id}/variants/batch`, { create: added });
  } catch (error) {
    if (!PRICES_REFUSED.test(error.message)) throw error;
    ctx.state.pricesRefused = error.message.replace(/^Medusa \S+ \S+: /, "");
    ctx.note({ kind: "prices", ref: "Medusa", message: `Prices not written: ${ctx.state.pricesRefused}` });
    await medusa.post(`/admin/products/${current.id}/variants/batch`, { create: added.map(({ prices, ...variant }) => variant) });
  }
}

// ---- reject: ours, but BC no longer has the item ----

async function reject({ ctx, medusa, budget }) {
  const { state, summary } = ctx;
  const inBc = new Set(ctx.work("product").map((row) => row.key));
  if (!inBc.size) {
    ctx.note({ kind: "product", ref: "-", message: "Business Central returned no items; nothing was rejected." });
    return next(state, "priceListsRead");
  }
  summary.products_rejected ??= 0;
  while (budget.left() > 3) {
    const { products: page, count } = await medusa.get("/admin/products", { limit: 100, offset: state.cursor, fields: "id,handle,status,metadata" });
    const missing = page.filter((product) => {
      const itemNumber = product.metadata?.bc_item_number;
      const owned = typeof itemNumber === "string" && productHandle(itemNumber) === product.handle;
      return owned && !inBc.has(product.handle) && product.status !== "rejected";
    });
    if (missing.length) {
      await medusa.post("/admin/products/batch", { update: missing.map((product) => ({ id: product.id, status: "rejected" })) });
      missing.forEach((product) =>
        ctx.note({ kind: "rejected", ref: product.handle, message: "No longer in Business Central (deleted or blocked); set to rejected." }),
      );
      summary.products_rejected += missing.length;
    }
    // Rejecting does not remove a product from the list, so offsets hold.
    state.cursor += page.length;
    if (!page.length || state.cursor >= count) return next(state, "priceListsRead");
  }
}

// ---- price lists: read BC's, then upsert by code ----

const ownedProducts = (ctx) =>
  ctx.work("product").filter((row) => row.result && ["created", "updated", "update_failed"].includes(row.result.status));

async function priceListsRead({ ctx, bc, budget }) {
  const { state, summary, settings } = ctx;
  if (state.pricesRefused) {
    ctx.note({ kind: "price_list", ref: "-", message: "Price lists skipped: Medusa refuses price writes (prices are managed in LS Central)." });
    return next(state, "done");
  }
  let headers;
  let lines;
  try {
    [headers, lines] = await Promise.all([
      listBcODataRows(bc, settings.company_name, settings.price_list_service || DEFAULT_PRICE_LIST_SERVICE, undefined, { budget }),
      listBcODataRows(bc, settings.company_name, settings.price_list_line_service || DEFAULT_PRICE_LIST_LINE_SERVICE, undefined, { budget }),
    ]);
  } catch (error) {
    ctx.note({
      kind: "price_list",
      ref: "-",
      message: `Price lists not read: ${error.message}. Publish pages 7016 and 7001 as web services (Settings shows the names).`,
    });
    return next(state, "done");
  }
  const owned = ownedProducts(ctx);
  const skusByItem = new Map(owned.map((row) => [row.payload.metadata.bc_item_number, row.payload.variants.map((v) => v.sku)]));
  const baseUnitByItem = new Map(owned.map((row) => [row.payload.metadata.bc_item_number, row.payload.metadata.bc_base_unit_of_measure ?? ""]));
  const mapped = mapPriceLists(headers, lines, {
    currencyCode: state.context.currency,
    storeVatBusPostingGroup: settings.vat_bus_posting_group,
    skusByItem,
    baseUnitByItem,
  });
  mapped.issues.forEach(ctx.note);
  ctx.putWork("pricelist", mapped.priceLists.map((list) => ({ key: list.code, payload: list })));
  Object.assign(summary, { bc_price_lists: headers.length, price_lists_created: 0, price_lists_updated: 0, price_lists_deactivated: 0, price_list_prices: 0 });
  state.variantIds = {};
  next(state, "variantIds");
}

// Variant ids of our products, by SKU, for the price list prices.
async function variantIds({ ctx, medusa, budget }) {
  const { state } = ctx;
  const owned = ownedProducts(ctx);
  const handles = new Set(owned.map((row) => row.key));
  const skus = owned.flatMap((row) => row.payload.variants.map((v) => v.sku));
  while (budget.left() > 3) {
    const chunk = skus.slice(state.cursor, state.cursor + 100);
    if (!chunk.length) return next(state, "priceLists");
    const { variants } = await medusa.get("/admin/product-variants", { sku: chunk, fields: "id,sku,product.handle", limit: chunk.length });
    for (const variant of variants) if (handles.has(variant.product?.handle)) state.variantIds[variant.sku] = variant.id;
    state.cursor += chunk.length;
  }
}

async function priceLists({ ctx, medusa, budget }) {
  const { state, summary } = ctx;
  if (!state.existingLists) {
    const lists = await medusa.listAll("/admin/price-lists", "price_lists", { fields: "id,status,metadata" });
    state.existingLists = Object.fromEntries(
      lists.filter((list) => list.metadata?.bc_price_list_code).map((list) => [list.metadata.bc_price_list_code, { id: list.id, status: list.status }]),
    );
  }
  const rows = ctx.work("pricelist", state.cursor, 10);
  for (const row of rows) {
    if (budget.left() < 4) return;
    const list = row.payload;
    const prices = list.prices
      .filter((price) => state.variantIds[price.sku])
      .map(({ sku, ...price }) => ({ ...price, variant_id: state.variantIds[sku] }));
    const fields = { title: list.title, description: list.description, starts_at: list.starts_at, ends_at: list.ends_at, status: "active", metadata: list.metadata };
    const current = state.existingLists[list.code];
    if (!current) {
      await medusa.post("/admin/price-lists", { ...fields, type: "sale", prices });
      summary.price_lists_created++;
    } else {
      await medusa.post(`/admin/price-lists/${current.id}`, fields);
      const { price_list } = await medusa.get(`/admin/price-lists/${current.id}`, { fields: "prices.id" });
      await medusa.post(`/admin/price-lists/${current.id}/prices/batch`, { create: prices, delete: (price_list.prices ?? []).map((p) => p.id) });
      summary.price_lists_updated++;
    }
    summary.price_list_prices += prices.length;
    state.cursor = row.seq + 1;
  }
  if (rows.length) return;
  // Every BC list done: ours that BC no longer offers become drafts.
  const inBc = new Set(ctx.work("pricelist").map((row) => row.key));
  for (const [code, list] of Object.entries(state.existingLists)) {
    if (inBc.has(code) || list.status === "draft") continue;
    if (budget.left() < 2) return;
    await medusa.post(`/admin/price-lists/${list.id}`, { status: "draft" });
    list.status = "draft";
    summary.price_lists_deactivated++;
  }
  next(state, "done");
}
