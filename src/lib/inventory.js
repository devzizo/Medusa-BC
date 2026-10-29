import { variantSku } from "./map.js";

// Pure inventory arithmetic for the stock sync, ported from the in-Medusa
// plugin. No I/O, so it is unit-tested on its own (test/inventory.test.js).

/**
 * Which columns the published "Item Ledger Entries" page carries. Pages are
 * published as they are in each tenant: Hoven's page 38 has no Variant Code,
 * and asking for a column the page lacks is an HTTP 400 for the whole query.
 */
export const detectLedgerFields = (sample) => {
  const has = (field) => field in sample;
  const missing = ["Item_No", "Location_Code"].filter((field) => !has(field));
  if (!has("Remaining_Quantity") && !has("Quantity")) missing.push("Remaining_Quantity or Quantity");
  if (missing.length) {
    return `The published Item Ledger Entries page has no ${missing.join(", ")}. Columns it has: ${Object.keys(sample)
      .filter((key) => !key.startsWith("@"))
      .join(", ")}.`;
  }
  // Remaining_Quantity over open entries, else Quantity over every entry:
  // both total to the stock on hand.
  const remainingOnly = has("Remaining_Quantity");
  return {
    item: "Item_No",
    location: "Location_Code",
    variant: has("Variant_Code") ? "Variant_Code" : null,
    quantity: remainingOnly ? "Remaining_Quantity" : "Quantity",
    remainingOnly,
  };
};

const quote = (value) => `'${value.replace(/'/g, "''")}'`;

/** The OData query for the mapped locations' entries, with only the page's own columns. */
export const ledgerQuery = (locationCodes, fields) => {
  const locations = locationCodes.map((code) => `${fields.location} eq ${quote(code)}`).join(" or ");
  const filter = fields.remainingOnly ? `${fields.quantity} ne 0 and (${locations})` : locations;
  const select = [fields.item, fields.variant, fields.location, fields.quantity].filter(Boolean).join(",");
  return `$filter=${encodeURIComponent(filter)}&$select=${select}`;
};

/**
 * Stock per SKU and BC location code, as { sku: { code: quantity } }. SKUs
 * follow the item sync; without a variant column every entry counts for the
 * item's own SKU.
 */
export const sumInventory = (entries, locationCodes, fields) => {
  const wanted = new Set(locationCodes);
  const stock = {};
  for (const entry of entries) {
    const item = entry[fields.item];
    const location = entry[fields.location];
    if (typeof item !== "string" || !item || typeof location !== "string" || !wanted.has(location)) continue;
    const variant = fields.variant ? entry[fields.variant] : undefined;
    const sku = variantSku(item, typeof variant === "string" && variant ? variant : undefined);
    stock[sku] ??= {};
    stock[sku][location] = (stock[sku][location] ?? 0) + Number(entry[fields.quantity] ?? 0);
  }
  return stock;
};

/** Every SKU BC has for its non-blocked items: the item's own, and one per non-blocked variant. */
export const bcSkus = (items, variants) => {
  const skus = new Set(items.filter((item) => item.number).map((item) => variantSku(item.number)));
  const numberById = new Map(items.map((item) => [item.id, item.number]));
  for (const variant of variants) {
    if (variant.blocked === true || !variant.code) continue;
    const number = numberById.get(variant.itemId);
    if (number) skus.add(variantSku(number, variant.code));
  }
  return skus;
};

// BC keeps 5 decimals; summing entries in floating point can drift past that.
export const roundQuantity = (value) => Math.round(value * 100000) / 100000;
