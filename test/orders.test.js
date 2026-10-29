import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { externalNumber, mapOrderHeader, mapOrderLines } from "../src/lib/orders.js";

const order = (overrides = {}) => ({
  display_id: 1042,
  created_at: "2026-10-28T19:12:00.000Z",
  currency_code: "sar",
  email: "aziz@example.com",
  customer: { metadata: { bc_customer_number: "C0001" } },
  shipping_address: { first_name: "عبدالعزيز", last_name: "الحلوه", address_1: "شارع الملك فهد", city: "الرياض", country_code: "sa", phone: "0500000000" },
  items: [
    { title: "مخدة", quantity: 2, unit_price: 115, is_tax_inclusive: true, tax_lines: [{ rate: 15 }], discount_total: 23, discount_subtotal: 20, variant: { metadata: { bc_item_number: "1000", bc_variant_id: "v-1" } } },
  ],
  shipping_methods: [{ name: "توصيل", amount: 23, is_tax_inclusive: true, tax_lines: [{ rate: 15 }] }],
  ...overrides,
});

describe("mapOrderHeader", () => {
  it("names the order MED-<number>, takes the customer the customer sync linked, and the ship-to address", () => {
    expect(externalNumber(order())).toBe("MED-1042");
    expect(mapOrderHeader(order(), { defaultCustomerNumber: "WEB" }).header).toEqual({
      customerNumber: "C0001", externalDocumentNumber: "MED-1042", orderDate: "2026-10-28", email: "aziz@example.com", phoneNumber: "0500000000",
      shipToName: "عبدالعزيز الحلوه", shipToAddressLine1: "شارع الملك فهد", shipToCity: "الرياض", shipToCountry: "SA",
    });
  });
  it("falls back to the default customer, sends a foreign currency, and refuses with neither customer", () => {
    expect(mapOrderHeader(order({ customer: null, currency_code: "usd" }), { defaultCustomerNumber: "WEB" }).header).toMatchObject({ customerNumber: "WEB", currencyCode: "USD" });
    expect(mapOrderHeader(order({ customer: null }), {}).error).toMatch(/No BC customer/);
  });
});

describe("mapOrderLines", () => {
  it("prices lines with VAT when the BC order includes tax, without it otherwise", () => {
    const shipping = { type: "Account", number: "6810" };
    expect(mapOrderLines(order(), { pricesIncludeTax: true, locationId: "loc-1", shipping }).lines).toEqual([
      { lineType: "Item", lineObjectNumber: "1000", itemVariantId: "v-1", locationId: "loc-1", unitPrice: 115, discountAmount: 23, quantity: 2 },
      { lineType: "Account", lineObjectNumber: "6810", description: "توصيل", unitPrice: 23, quantity: 1 },
    ]);
    expect(mapOrderLines(order(), { pricesIncludeTax: false, shipping }).lines).toEqual([
      { lineType: "Item", lineObjectNumber: "1000", itemVariantId: "v-1", unitPrice: 100, discountAmount: 20, quantity: 2 },
      { lineType: "Account", lineObjectNumber: "6810", description: "توصيل", unitPrice: 20, quantity: 1 },
    ]);
  });
  it("reports items that are not BC items and shipping with nowhere to post", () => {
    const { problems } = mapOrderLines(order({ items: [{ title: "Shirt", variant_sku: "SHIRT-S", quantity: 1, unit_price: 50, variant: { metadata: {} } }] }), { pricesIncludeTax: true });
    expect(problems).toEqual([
      '"Shirt" (SKU SHIRT-S) is not a BC item: its variant has no bc_item_number.',
      'Shipping "توصيل" was charged, but no BC account or item for shipping is set (Orders tab).',
    ]);
  });
});
