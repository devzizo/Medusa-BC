import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { barcodeIndex, barcodeKey, hsCodeIndex, mapCategories, mapItems, mapPriceLists } from "../src/lib/map.js";

const item = (overrides = {}) => ({
  id: "i-1",
  number: "1000",
  displayName: "Hotel Pillow",
  displayName2: "Soft",
  itemCategoryCode: "PILLOWS",
  unitPrice: 199.999,
  priceIncludesTax: true,
  baseUnitOfMeasureCode: "PCS",
  gtin: "6281234567890",
  ...overrides,
})

describe("mapCategories", () => {
  it("keys categories by a handle made from the BC code", () => {
    expect(mapCategories([{ id: "c1", code: "PILLOWS", displayName: "Pillows" }])).toEqual([
      { handle: "bc-cat-pillows", name: "Pillows", metadata: { bc_id: "c1", bc_code: "PILLOWS" } },
    ])
  })

  it("gives codes the slug changes (Arabic, symbols, spaces) distinct, stable handles", () => {
    const handlesFor = (codes) =>
      mapCategories(codes.map((code, index) => ({ id: `c${index}`, code, displayName: code }))).map((c) => c.handle)
    const codes = ["مفارش", "مخدات", "***", "مخدة 1", "X", "X.", "BED SHEETS", "BED-SHEETS"]
    const handles = handlesFor(codes)
    expect(new Set(handles).size).toBe(codes.length)
    expect(handles[3]).toMatch(/^bc-cat-1-[0-9a-f]{8}$/)
    expect(handlesFor(codes)).toEqual(handles)
  })
})

describe("mapItems", () => {
  it("makes one default variant, with the item number as SKU and the unit price, for an item without variants", () => {
    const { products, issues } = mapItems([item()], [], "sar")
    expect(issues).toEqual([])
    expect(products[0]).toMatchObject({
      handle: "bc-1000",
      title: "Hotel Pillow",
      subtitle: "Soft",
      category_handle: "bc-cat-pillows",
      options: [{ title: "Default option", values: ["Default option value"] }],
    })
    expect(products[0].variants).toEqual([
      expect.objectContaining({ sku: "1000", barcode: "6281234567890", prices: [{ currency_code: "sar", amount: 200 }] }),
    ])
    expect(products[0].metadata).toMatchObject({ bc_item_number: "1000", bc_price_includes_vat: true, bc_base_unit_of_measure: "PCS" })
  })

  it("makes one variant per BC variant, leaves blocked ones out, and gives each the item price", () => {
    const { products } = mapItems(
      [item()],
      [
        { id: "v1", itemId: "i-1", itemNumber: "1000", code: "WHITE", description: "White" },
        { id: "v2", itemId: "i-1", itemNumber: "1000", code: "GREY" },
        { id: "v3", itemId: "i-1", itemNumber: "1000", code: "OLD", blocked: true },
        { id: "v4", itemId: "other", itemNumber: "2000", code: "RED" },
      ],
      "sar"
    )
    expect(products[0].options).toEqual([{ title: "Variant", values: ["WHITE", "GREY"] }])
    expect(products[0].variants.map((variant) => [variant.sku, variant.title, variant.options])).toEqual([
      ["1000-WHITE", "White", { Variant: "WHITE" }],
      ["1000-GREY", "GREY", { Variant: "GREY" }],
    ])
    expect(products[0].variants[0].prices).toEqual([{ currency_code: "sar", amount: 200 }])
  })

  it("imports an item without a price, and says so", () => {
    const { products, issues } = mapItems([item({ unitPrice: 0 })], [], "sar")
    expect(products[0].variants[0].prices).toEqual([])
    expect(issues).toEqual([expect.objectContaining({ kind: "price", ref: "1000" })])
  })
})

describe("mapPriceLists", () => {
  const context = (overrides = {}) => ({
    currencyCode: "sar",
    storeVatBusPostingGroup: "DOMESTIC",
    skusByItem: new Map([
      ["1000", ["1000-WHITE", "1000-GREY"]],
      ["2000", ["2000"]],
    ]),
    baseUnitByItem: new Map([
      ["1000", "PCS"],
      ["2000", "PCS"],
    ]),
    ...overrides,
  })
  const header = (overrides = {}) => ({
    Code: "S00001",
    Description: "Winter sale",
    Status: "Active",
    Price_Type: "Sale",
    Starting_Date: "2026-11-01",
    Ending_Date: "0001-01-01",
    Currency_Code: "",
    Price_Includes_VAT: true,
    VAT_Bus_Posting_Gr_Price: "DOMESTIC",
    ...overrides,
  })

  it("maps an active sales list and its item lines, an empty variant code covering every variant", () => {
    const { priceLists, issues } = mapPriceLists(
      [header()],
      [
        { Price_List_Code: "S00001", Product_Type: "Item", Product_No: "1000", Variant_Code: "", Unit_Price: 150, Unit_of_Measure_Code: "PCS" },
        { Price_List_Code: "S00001", Asset_Type: "Item", Asset_No: "2000", Unit_Price: 80.555, Minimum_Quantity: 3 },
      ],
      context()
    )
    expect(issues).toEqual([])
    expect(priceLists[0]).toMatchObject({
      code: "S00001",
      title: "S00001 - Winter sale",
      starts_at: "2026-11-01T00:00:00.000Z",
      ends_at: null,
      metadata: { bc_price_list_code: "S00001", bc_price_includes_vat: true },
    })
    expect(priceLists[0].prices).toEqual([
      { sku: "1000-WHITE", currency_code: "sar", amount: 150 },
      { sku: "1000-GREY", currency_code: "sar", amount: 150 },
      { sku: "2000", currency_code: "sar", amount: 80.56, min_quantity: 3 },
    ])
  })

  it("imports only the lists chosen in Settings when a choice is saved", () => {
    const headers = [header(), header({ Code: "S00002", Description: "Eid" })]
    expect(mapPriceLists(headers, [], context({ selectedCodes: new Set(["S00002"]) })).priceLists.map((l) => l.code)).toEqual(["S00002"])
    expect(mapPriceLists(headers, [], context({ selectedCodes: new Set() })).priceLists).toEqual([])
    expect(mapPriceLists(headers, [], context()).priceLists.map((l) => l.code)).toEqual(["S00001", "S00002"])
  })

  it("prices one variant when the line names it", () => {
    const { priceLists } = mapPriceLists(
      [header()],
      [{ Price_List_Code: "S00001", Product_Type: "Item", Product_No: "1000", Variant_Code: "GREY", Unit_Price: 120 }],
      context()
    )
    expect(priceLists[0].prices.map((price) => price.sku)).toEqual(["1000-GREY"])
  })

  it("skips lists that are inactive, for purchases, or VAT-inclusive for another posting group", () => {
    const { priceLists, issues } = mapPriceLists(
      [
        header({ Code: "DRAFT", Status: "Draft" }),
        header({ Code: "BUY", Price_Type: "Purchase" }),
        header({ Code: "EXPORT", VAT_Bus_Posting_Gr_Price: "EXPORT" }),
      ],
      [],
      context()
    )
    expect(priceLists).toEqual([])
    expect(issues.map((issue) => issue.ref)).toEqual(["DRAFT", "BUY", "EXPORT"])
  })

  it("skips discount lines, other units of measure, and items or variants that were not imported", () => {
    const { priceLists, issues } = mapPriceLists(
      [header()],
      [
        { Price_List_Code: "S00001", Product_Type: "Item", Product_No: "2000", Amount_Type: "Discount", Unit_Price: 0 },
        { Price_List_Code: "S00001", Product_Type: "Item", Product_No: "2000", Unit_of_Measure_Code: "BOX", Unit_Price: 900 },
        { Price_List_Code: "S00001", Product_Type: "Item", Product_No: "9999", Unit_Price: 10 },
        { Price_List_Code: "S00001", Product_Type: "Item", Product_No: "1000", Variant_Code: "BLUE", Unit_Price: 10 },
        { Price_List_Code: "S00001", Product_Type: "Item Discount Group", Product_No: "X", Unit_Price: 5 },
      ],
      context()
    )
    expect(priceLists[0].prices).toEqual([])
    expect(issues.map((issue) => issue.ref)).toEqual(["S00001/2000", "S00001/9999", "S00001/1000"])
  })
})

describe("draftReason", async () => {
  const { draftReason } = await import("../src/lib/map.js");
  it("drafts blocked items, and zero stock only when the option is on and BC gives a figure", () => {
    expect(draftReason({ blocked: true, inventory: 5 })).toBe("blocked");
    expect(draftReason({ inventory: 0 }, { draftZeroInventory: true })).toBe("zero_inventory");
    expect(draftReason({ inventory: -2 }, { draftZeroInventory: true })).toBe("zero_inventory");
    expect(draftReason({ inventory: 0 }, { draftZeroInventory: false })).toBe(null);
    expect(draftReason({ inventory: 3 }, { draftZeroInventory: true })).toBe(null);
    expect(draftReason({}, { draftZeroInventory: true })).toBe(null);
  });
});

describe("barcodes and HS codes", () => {
  it("indexes Bar Code references per item and variant, base unit only, discontinued left out", () => {
    const index = barcodeIndex([
      { Item_No: "1000", Variant_Code: "", Unit_of_Measure: "PCS", Reference_Type: "Bar Code", Reference_No: "6281000000001" },
      { Item_No: "1000", Variant_Code: "", Unit_of_Measure: "BOX", Reference_Type: "Bar Code", Reference_No: "BOX-1" },
      { Item_No: "2000", Variant_Code: "WHITE", Unit_of_Measure: "", Reference_Type: "Bar Code", Reference_No: "6281000000020" },
      { Item_No: "2000", Variant_Code: "GREY", Reference_Type: "Bar Code", Reference_No: "OLD", Discontinue_Bar_Code: true },
      { Item_No: "2000", Variant_Code: "GREY", Reference_Type: "Customer", Reference_No: "CUST-1" },
    ], new Map([["1000", "PCS"], ["2000", "PCS"]]))
    expect([...index]).toEqual([["1000|", "6281000000001"], ["2000|WHITE", "6281000000020"]])
    expect([...hsCodeIndex([{ No: "1000", Tariff_No: "94049000" }, { No: "2000", Tariff_No: "" }])]).toEqual([["1000", "94049000"]])
  })

  it("puts each variant's own barcode on it, never the item GTIN on several variants, and the HS code everywhere", () => {
    const items = [
      { id: "i1", number: "1000", displayName: "Pillow", unitPrice: 10, gtin: "GTIN-1000" },
      { id: "i2", number: "2000", displayName: "Sheet", unitPrice: 20, gtin: "GTIN-2000" },
    ]
    const variants = [
      { id: "v1", itemId: "i2", code: "WHITE" },
      { id: "v2", itemId: "i2", code: "GREY" },
    ]
    const { products } = mapItems(items, variants, "sar", {
      barcodes: new Map([[barcodeKey("2000", "WHITE"), "BAR-WHITE"]]),
      hsCodes: new Map([["2000", "63022100"]]),
    })
    expect(products[0].variants[0].barcode).toBe("GTIN-1000")
    expect(products[1].hs_code).toBe("63022100")
    expect(products[1].metadata.bc_tariff_no).toBe("63022100")
    expect(products[1].variants.map((v) => [v.sku, v.barcode, v.hs_code])).toEqual([["2000-WHITE", "BAR-WHITE", "63022100"], ["2000-GREY", undefined, "63022100"]])
  })
})
