import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { bcSkus, detectLedgerFields, ledgerQuery, sumInventory } from "../src/lib/inventory.js";

const full = { item: "Item_No", location: "Location_Code", variant: "Variant_Code", quantity: "Remaining_Quantity", remainingOnly: true };

describe("detectLedgerFields", () => {
  it("uses Variant Code and Remaining Quantity when the page has them", () => {
    expect(detectLedgerFields({ Item_No: "1", Variant_Code: "", Location_Code: "MAIN", Remaining_Quantity: 1, Quantity: 1 })).toEqual(full);
  });
  it("works without Variant Code, as on Hoven's page", () => {
    expect(detectLedgerFields({ Item_No: "1", Location_Code: "MAIN", Remaining_Quantity: 1 })).toEqual({ ...full, variant: null });
  });
  it("falls back to Quantity over every entry without Remaining Quantity", () => {
    expect(detectLedgerFields({ Item_No: "1", Location_Code: "MAIN", Quantity: 1 })).toEqual({ ...full, variant: null, quantity: "Quantity", remainingOnly: false });
  });
  it("names what is missing and what the page has", () => {
    expect(detectLedgerFields({ "@odata.etag": "x", Entry_No: 1, Item_No: "1", Quantity: 1 })).toBe(
      "The published Item Ledger Entries page has no Location_Code. Columns it has: Entry_No, Item_No, Quantity.",
    );
  });
});

describe("sumInventory", () => {
  it("sums per SKU and location with the item sync's SKUs", () => {
    const stock = sumInventory(
      [
        { Item_No: "1000", Variant_Code: "", Location_Code: "MAIN", Remaining_Quantity: 5 },
        { Item_No: "1000", Location_Code: "MAIN", Remaining_Quantity: 2.5 },
        { Item_No: "1000", Location_Code: "JED", Remaining_Quantity: 1 },
        { Item_No: "2000", Variant_Code: "GREY", Location_Code: "MAIN", Remaining_Quantity: 4 },
        { Item_No: "2000", Variant_Code: "GREY", Location_Code: "MAIN", Remaining_Quantity: -1 },
        { Item_No: "1000", Location_Code: "OTHER", Remaining_Quantity: 9 },
        { Location_Code: "MAIN", Remaining_Quantity: 9 },
      ],
      ["MAIN", "JED"],
      full,
    );
    expect(stock).toEqual({ 1000: { MAIN: 7.5, JED: 1 }, "2000-GREY": { MAIN: 3 } });
  });
});

describe("ledgerQuery", () => {
  it("asks only for open entries of the mapped locations, quoting codes", () => {
    expect(decodeURIComponent(ledgerQuery(["MAIN", "O'HARE"], full))).toBe(
      "$filter=Remaining_Quantity ne 0 and (Location_Code eq 'MAIN' or Location_Code eq 'O''HARE')&$select=Item_No,Variant_Code,Location_Code,Remaining_Quantity",
    );
  });
  it("selects only the columns the page has", () => {
    expect(decodeURIComponent(ledgerQuery(["MAIN"], { ...full, variant: null, quantity: "Quantity", remainingOnly: false }))).toBe(
      "$filter=Location_Code eq 'MAIN'&$select=Item_No,Location_Code,Quantity",
    );
  });
});

describe("bcSkus", () => {
  it("has each item's own SKU and one per non-blocked variant", () => {
    const skus = bcSkus(
      [{ id: "a", number: "1000" }, { id: "b", number: "2000" }],
      [
        { itemId: "b", code: "GREY" },
        { itemId: "b", code: "OLD", blocked: true },
        { itemId: "gone", code: "X" },
      ],
    );
    expect([...skus].sort()).toEqual(["1000", "2000", "2000-GREY"]);
  });
});
