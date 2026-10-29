import { bcCredentials, listBcItems, listBcItemVariants, listBcODataRows } from "../lib/bc.js";
import { makeBudget, medusaClient } from "../lib/medusa.js";
import { bcSkus, detectLedgerFields, ledgerQuery, roundQuantity, sumInventory } from "../lib/inventory.js";

// The stock sync, BC → Medusa. For every Medusa variant whose SKU BC has,
// and every Medusa stock location mapped to a BC location, the stocked
// quantity becomes what that BC location holds: the sum of its item ledger
// entries (page 38, read over OData because API v2.0 has no stock per
// location). A SKU BC holds none of at a location is set to 0 there. Stock
// locations that are not mapped, and variants BC does not have, are never
// touched. Like the item sync, it runs in steps under a call budget.

const BUDGET = 40;
export const DEFAULT_INVENTORY_SERVICE = "ItemLedgerEntries";

export async function runInventorySyncStep(ctx, env) {
  const budget = makeBudget(Number(env.SYNC_STEP_BUDGET) || BUDGET);
  const medusa = medusaClient(env, budget);
  const bc = bcCredentials(env);
  const { state } = ctx;
  const stages = { read, variants, track, levels };
  while (state.stage !== "done" && budget.left() > 5) {
    const before = `${state.stage}:${state.cursor}`;
    await stages[state.stage]({ ctx, budget, medusa, bc });
    // A stage that stopped without moving is waiting for a fresh budget.
    if (`${state.stage}:${state.cursor}` === before) break;
  }
  return state.stage === "done";
}

const next = (state, stage) => {
  state.stage = stage;
  state.cursor = 0;
};

// ---- read: mapped locations, BC's SKUs and stock ----

async function read({ ctx, medusa, bc, budget }) {
  const { state, summary, settings } = ctx;
  if (!settings.company_id) throw new Error("Choose a Business Central company in Settings first.");
  const mappings = ctx.mappings("locations");
  if (!mappings.length) throw new Error("Map at least one stock location to a BC location first (Locations tab).");

  const { stock_locations: stockLocations } = await medusa.get("/admin/stock-locations", {
    id: mappings.map((m) => m.id),
    fields: "id,name,sales_channels.id",
    limit: mappings.length,
  });
  const live = new Map(stockLocations.map((location) => [location.id, location]));
  const locations = mappings.filter((m) => live.has(m.id)).map((m) => ({ id: m.id, code: m.code, name: live.get(m.id).name }));
  if (!locations.length) throw new Error("None of the mapped stock locations exists in Medusa any more; map them again.");
  for (const location of stockLocations) {
    if (!location.sales_channels?.length) {
      ctx.note({ kind: "location", ref: location.name, message: "Not linked to a sales channel: its stock is synced but cannot be sold until it is." });
    }
  }

  const options = { budget };
  const [items, variants] = await Promise.all([listBcItems(bc, settings.company_id, options), listBcItemVariants(bc, settings.company_id, options)]);
  const skus = [...bcSkus(items, variants)];
  if (!skus.length) throw new Error("Business Central returned no items; nothing was changed.");

  const service = settings.inventory_service || DEFAULT_INVENTORY_SERVICE;
  const codes = [...new Set(locations.map((l) => l.code))];
  // One row first, to see which columns this tenant's page carries.
  const [sample] = await listBcODataRows(bc, settings.company_name, service, "$top=1", options);
  let stock = {};
  summary.bc_entries = 0;
  if (sample) {
    const fields = detectLedgerFields(sample);
    if (typeof fields === "string") throw new Error(fields);
    if (!fields.variant) {
      ctx.note({
        kind: "page",
        ref: service,
        message: "The published page has no Variant Code: stock is counted per item, so variants of items that have variants get 0.",
      });
    }
    const entries = await listBcODataRows(bc, settings.company_name, service, ledgerQuery(codes, fields), options);
    summary.bc_entries = entries.length;
    stock = sumInventory(entries, codes, fields);
  }

  ctx.putWork("sku", skus.map((sku) => ({ key: sku, payload: stock[sku] ?? {} })));
  state.locations = locations;
  Object.assign(summary, {
    locations: locations.length,
    bc_skus: skus.length,
    variants: 0,
    bc_skus_not_in_medusa: 0,
    inventory_items_created: 0,
    levels_created: 0,
    levels_updated: 0,
    levels_unchanged: 0,
  });
  next(state, "variants");
}

// ---- variants: find each BC SKU's variant in Medusa ----

async function variants({ ctx, medusa, budget }) {
  const { state, summary } = ctx;
  while (budget.left() > 3) {
    const rows = ctx.work("sku", state.cursor, 100);
    if (!rows.length) return next(state, "track");
    const { variants: found } = await medusa.get("/admin/product-variants", {
      sku: rows.map((row) => row.key),
      fields: "id,sku,title,product_id,inventory_items.inventory_item_id",
      limit: rows.length,
    });
    const bySku = new Map(found.map((variant) => [variant.sku, variant]));
    for (const row of rows) {
      const variant = bySku.get(row.key);
      if (!variant) {
        summary.bc_skus_not_in_medusa++;
        ctx.setResult("sku", row.seq, { missing: true });
        continue;
      }
      const items = variant.inventory_items ?? [];
      if (items.length > 1) {
        ctx.note({ kind: "variant", ref: row.key, message: "Has more than one inventory item (a kit); stock not synced." });
        ctx.setResult("sku", row.seq, { missing: true });
        continue;
      }
      summary.variants++;
      ctx.setResult("sku", row.seq, {
        variant_id: variant.id,
        product_id: variant.product_id,
        title: variant.title,
        inventory_item_id: items[0]?.inventory_item_id ?? null,
      });
    }
    state.cursor = rows[rows.length - 1].seq + 1;
  }
}

// ---- track: give untracked variants an inventory item ----

// Medusa creates an inventory item only when a variant is created with
// manage_inventory on, never when it is switched on later. So: reuse an
// unlinked item with the same SKU or create one, link it, switch it on.
async function track({ ctx, medusa, budget }) {
  const { state, summary } = ctx;
  while (budget.left() > 6) {
    const rows = ctx.work("sku", state.cursor, 10);
    if (!rows.length) return next(state, "levels");
    const untracked = rows.filter((row) => row.result?.variant_id && !row.result.inventory_item_id);
    const { inventory_items: existing } = untracked.length
      ? await medusa.get("/admin/inventory-items", { sku: untracked.map((row) => row.key), fields: "id,sku,variants.id", limit: untracked.length })
      : { inventory_items: [] };
    const free = new Map(existing.filter((item) => !(item.variants ?? []).length).map((item) => [item.sku, item.id]));
    for (const row of rows) {
      if (!untracked.includes(row)) {
        state.cursor = row.seq + 1;
        continue;
      }
      if (budget.left() < 4) return;
      const { variant_id, product_id, title } = row.result;
      try {
        let itemId = free.get(row.key);
        if (!itemId) {
          if (existing.some((item) => item.sku === row.key)) {
            throw new Error("An inventory item with this SKU already belongs to another variant.");
          }
          const { inventory_item } = await medusa.post("/admin/inventory-items", { sku: row.key, title });
          itemId = inventory_item.id;
          summary.inventory_items_created++;
        }
        await medusa.post(`/admin/products/${product_id}/variants/inventory-items/batch`, {
          create: [{ variant_id, inventory_item_id: itemId, required_quantity: 1 }],
        });
        await medusa.post(`/admin/products/${product_id}/variants/${variant_id}`, { manage_inventory: true });
        ctx.setResult("sku", row.seq, { ...row.result, inventory_item_id: itemId });
      } catch (error) {
        ctx.note({ kind: "inventory", ref: row.key, message: `No inventory item: ${error.message}` });
      }
      state.cursor = row.seq + 1;
    }
  }
}

// ---- levels: set each mapped location's stocked quantity ----

async function levels({ ctx, medusa, budget }) {
  const { state, summary } = ctx;
  while (budget.left() > 3) {
    const rows = ctx.work("sku", state.cursor, 50);
    if (!rows.length) return next(state, "done");
    const tracked = rows.filter((row) => row.result?.inventory_item_id);
    if (tracked.length) {
      const { inventory_items: items } = await medusa.get("/admin/inventory-items", {
        id: tracked.map((row) => row.result.inventory_item_id),
        fields: "id,location_levels.location_id,location_levels.stocked_quantity",
        limit: tracked.length,
      });
      const levelsById = new Map(items.map((item) => [item.id, item.location_levels ?? []]));
      const create = [];
      const update = [];
      for (const row of tracked) {
        const itemId = row.result.inventory_item_id;
        for (const location of state.locations) {
          let quantity = roundQuantity(row.payload[location.code] ?? 0);
          if (quantity < 0) {
            ctx.note({ kind: "negative", ref: `${row.key} @ ${location.code}`, message: `BC shows ${quantity}; set to 0.` });
            quantity = 0;
          }
          const level = (levelsById.get(itemId) ?? []).find((l) => l.location_id === location.id);
          const change = { inventory_item_id: itemId, location_id: location.id, stocked_quantity: quantity };
          if (!level) create.push(change);
          else if (Number(level.stocked_quantity) !== quantity) update.push(change);
          else summary.levels_unchanged++;
        }
      }
      if (create.length || update.length) {
        await medusa.post("/admin/inventory-items/location-levels/batch", { create, update });
      }
      summary.levels_created += create.length;
      summary.levels_updated += update.length;
    }
    state.cursor = rows[rows.length - 1].seq + 1;
  }
}
