import { createHash } from "node:crypto";

// Pure mapping from Business Central rows to Medusa Admin API bodies, ported
// from the in-Medusa plugin (@hoven/medusa-bc). No I/O, so every rule is
// unit-tested on its own (test/map.test.js).

// A product without BC variants still needs one option for its single variant.
export const DEFAULT_OPTION = { title: "Default option", value: "Default option value" };
const VARIANT_OPTION = "Variant";

// A handle must be unique, but a URL slug drops what BC codes often carry:
// Arabic letters ("مفارش" and "مخدات" both slug to nothing) or symbols ("X"
// and "X." both slug to "x"). Whenever the slug is not the code itself, a
// short hash of the exact code keeps distinct codes apart, stable across runs.
const slug = (value) => {
  const code = value.trim();
  const base = code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base === code.toLowerCase()) return base;
  const hash = createHash("sha256").update(code).digest("hex").slice(0, 8);
  return base ? `${base}-${hash}` : hash;
};

export const categoryHandle = (code) => `bc-cat-${slug(code)}`;
export const productHandle = (itemNumber) => `bc-${slug(itemNumber)}`;
export const variantSku = (itemNumber, variantCode) => (variantCode ? `${itemNumber}-${variantCode}` : itemNumber);

const money = (value) => Math.round(value * 100) / 100;

// undefined has no JSON form: drop it so stored metadata reads back as written.
const clean = (value) => JSON.parse(JSON.stringify(value));

export const mapCategories = (categories) =>
  categories
    .filter((category) => category.code)
    .map((category) => ({
      handle: categoryHandle(category.code),
      name: category.displayName || category.code,
      metadata: clean({ bc_id: category.id, bc_code: category.code }),
    }));

/**
 * Why an item's product must be a draft, or null: blocked in BC (when
 * blocked items are imported at all), or no stock in BC when that option is
 * on. `inventory` is the item's total over every BC location; an item BC
 * reports no figure for is never drafted for stock.
 */
export const draftReason = (item, { draftZeroInventory = false } = {}) => {
  if (item.blocked === true) return "blocked";
  if (draftZeroInventory && typeof item.inventory === "number" && item.inventory <= 0) return "zero_inventory";
  return null;
};

/**
 * One product per item, one variant per BC item variant (or a single default
 * variant when the item has none). The item's unit price is every variant's
 * "original" price; price lists override it.
 */
export const mapItems = (items, variants, currencyCode, options = {}) => {
  const issues = [];
  const variantsByItem = new Map();
  for (const variant of variants) {
    if (variant.blocked === true) continue;
    const list = variantsByItem.get(variant.itemId) ?? [];
    list.push(variant);
    variantsByItem.set(variant.itemId, list);
  }

  const products = [];
  for (const item of items) {
    if (!item.number) {
      issues.push({ kind: "item", ref: item.id, message: "Item without a number, skipped." });
      continue;
    }
    const price =
      typeof item.unitPrice === "number" && item.unitPrice > 0
        ? [{ currency_code: currencyCode, amount: money(item.unitPrice) }]
        : [];
    if (!price.length) {
      issues.push({ kind: "price", ref: item.number, message: "No unit price in BC; imported without a price." });
    }

    const itemVariants = (variantsByItem.get(item.id) ?? []).filter((variant) => variant.code);
    const shared = { bc_item_id: item.id, bc_item_number: item.number };
    const productVariants = itemVariants.length
      ? itemVariants.map((variant) => ({
          title: variant.description || variant.code,
          sku: variantSku(item.number, variant.code),
          manage_inventory: false,
          options: { [VARIANT_OPTION]: variant.code },
          prices: price,
          metadata: clean({ ...shared, bc_variant_id: variant.id, bc_variant_code: variant.code }),
        }))
      : [
          clean({
            title: item.displayName || item.number,
            sku: variantSku(item.number),
            barcode: item.gtin || undefined,
            manage_inventory: false,
            options: { [DEFAULT_OPTION.title]: DEFAULT_OPTION.value },
            prices: price,
            metadata: shared,
          }),
        ];

    products.push(
      clean({
        handle: productHandle(item.number),
        title: item.displayName || item.number,
        subtitle: item.displayName2 || undefined,
        options: itemVariants.length
          ? [{ title: VARIANT_OPTION, values: itemVariants.map((variant) => variant.code) }]
          : [{ title: DEFAULT_OPTION.title, values: [DEFAULT_OPTION.value] }],
        variants: productVariants,
        category_handle: item.itemCategoryCode ? categoryHandle(item.itemCategoryCode) : null,
        draft_reason: draftReason(item, options),
        metadata: {
          ...shared,
          bc_type: item.type,
          bc_item_category_code: item.itemCategoryCode || undefined,
          bc_base_unit_of_measure: item.baseUnitOfMeasureCode || undefined,
          bc_gtin: item.gtin || undefined,
          bc_unit_price: item.unitPrice,
          bc_price_includes_vat: item.priceIncludesTax,
          bc_gen_prod_posting_group: item.generalProductPostingGroupCode || undefined,
          bc_inventory_posting_group: item.inventoryPostingGroupCode || undefined,
          bc_last_modified: item.lastModifiedDateTime,
          bc_inventory: item.inventory,
          bc_blocked: item.blocked === true ? true : undefined,
        },
      }),
    );
  }
  return { products, issues };
};

// ---- Price lists (OData pages, so field names are the page's captions) ----

// BC renamed "Asset" to "Product" on the price list pages; read either.
const pick = (row, ...keys) => {
  for (const key of keys) if (row[key] !== undefined && row[key] !== null) return row[key];
  return undefined;
};
const text = (row, ...keys) => {
  const value = pick(row, ...keys);
  return value === undefined ? "" : String(value).trim();
};
const num = (row, ...keys) => {
  const value = Number(pick(row, ...keys));
  return Number.isFinite(value) ? value : 0;
};
const bool = (row, ...keys) => pick(row, ...keys) === true;
// BC writes "no date" as 0001-01-01.
const date = (row, ...keys) => {
  const value = text(row, ...keys);
  return !value || value.startsWith("0001-01-01") ? null : new Date(value).toISOString();
};

/**
 * Active sales price lists and their item price lines, in Medusa terms.
 * Left out, each with an issue: lists not Active or not for sales; lists
 * whose prices include VAT for another VAT Bus. Posting Group; discount
 * lines; other units of measure; items or variants not imported. A line
 * without a variant code applies to every variant of its item.
 */
export const mapPriceLists = (headers, lines, context) => {
  const issues = [];
  const linesByList = new Map();
  for (const line of lines) {
    const code = text(line, "Price_List_Code");
    if (!code) continue;
    const list = linesByList.get(code) ?? [];
    list.push(line);
    linesByList.set(code, list);
  }

  const priceLists = [];
  for (const header of headers) {
    const code = text(header, "Code");
    if (!code) continue;
    // Settings may name the lists to import; the others count as not offered.
    if (context.selectedCodes && !context.selectedCodes.has(code)) continue;
    const status = text(header, "Status");
    if (status && status !== "Active") {
      issues.push({ kind: "price_list", ref: code, message: `Status is ${status}, not Active; skipped.` });
      continue;
    }
    const priceType = text(header, "Price_Type");
    if (priceType && priceType !== "Sale") {
      issues.push({ kind: "price_list", ref: code, message: `Price type is ${priceType}; only sales prices are imported.` });
      continue;
    }
    const includesVat = bool(header, "Price_Includes_VAT");
    const vatGroup = text(header, "VAT_Bus_Posting_Gr_Price");
    if (includesVat && vatGroup && context.storeVatBusPostingGroup && vatGroup !== context.storeVatBusPostingGroup) {
      issues.push({
        kind: "price_list",
        ref: code,
        message: `Prices include VAT for posting group ${vatGroup}, not the store's ${context.storeVatBusPostingGroup}; skipped.`,
      });
      continue;
    }
    const currency = (text(header, "Currency_Code") || context.currencyCode).toLowerCase();

    const prices = [];
    for (const line of linesByList.get(code) ?? []) {
      const assetType = text(line, "Product_Type", "Asset_Type");
      const itemNo = text(line, "Product_No", "Asset_No");
      const ref = `${code}/${itemNo || "?"}`;
      if (assetType && assetType !== "Item") continue;
      if (text(line, "Amount_Type") === "Discount") continue;
      const lineStatus = text(line, "Status");
      if (lineStatus && lineStatus !== "Active") continue;
      const unitPrice = num(line, "Unit_Price");
      if (!itemNo || unitPrice <= 0) continue;
      const unit = text(line, "Unit_of_Measure_Code");
      const baseUnit = context.baseUnitByItem.get(itemNo);
      if (unit && baseUnit && unit !== baseUnit) {
        issues.push({ kind: "price_line", ref, message: `Price is per ${unit}, not the base unit ${baseUnit}; skipped.` });
        continue;
      }
      const itemSkus = context.skusByItem.get(itemNo);
      if (!itemSkus) {
        issues.push({ kind: "price_line", ref, message: "Item not imported (blocked, missing or skipped); line skipped." });
        continue;
      }
      const variantCode = text(line, "Variant_Code");
      const skus = variantCode ? itemSkus.filter((sku) => sku === variantSku(itemNo, variantCode)) : itemSkus;
      if (!skus.length) {
        issues.push({ kind: "price_line", ref, message: `Variant ${variantCode} not imported; line skipped.` });
        continue;
      }
      const minQuantity = num(line, "Minimum_Quantity");
      for (const sku of skus) {
        prices.push({ sku, currency_code: currency, amount: money(unitPrice), ...(minQuantity > 1 ? { min_quantity: minQuantity } : {}) });
      }
    }

    const description = text(header, "Description");
    priceLists.push({
      code,
      title: description ? `${code} - ${description}` : code,
      description: description || `Business Central price list ${code}`,
      starts_at: date(header, "Starting_Date"),
      ends_at: date(header, "Ending_Date"),
      prices,
      metadata: clean({
        bc_price_list_code: code,
        bc_price_includes_vat: includesVat,
        bc_vat_bus_posting_group_price: vatGroup || undefined,
        bc_currency_code: text(header, "Currency_Code") || undefined,
      }),
    });
  }
  return { priceLists, issues };
};
