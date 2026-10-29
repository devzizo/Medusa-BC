// Pure mapping of a Medusa order to a Business Central sales order (API v2.0
// salesOrders + salesOrderLines). No I/O, so it is unit-tested on its own
// (test/orders.test.js).

const clean = (value) => JSON.parse(JSON.stringify(value));
const round = (value) => Math.round(value * 100) / 100;
const text = (value) => (typeof value === "string" ? value.trim() : "");

/** "MED-1042": the order's number in BC, and how a second sync finds it. */
export const externalNumber = (order) => `MED-${order.display_id}`;

const rate = (line) => (line.tax_lines ?? []).reduce((sum, tax) => sum + Number(tax.rate || 0), 0);

/**
 * A line's unit price and discount as BC wants them: including VAT when the
 * BC order's prices include tax (the customer decides that in BC), else
 * excluding it. Medusa may hold either; its tax lines give the rate.
 */
const amounts = (line, quantity, pricesIncludeTax) => {
  const factor = 1 + rate(line) / 100;
  const unit = Number(line.unit_price ?? line.amount ?? 0);
  const unitIncl = line.is_tax_inclusive ? unit : unit * factor;
  const unitExcl = line.is_tax_inclusive ? unit / factor : unit;
  const discountIncl = Number(line.discount_total ?? 0);
  const discountExcl = line.discount_subtotal !== undefined && line.discount_subtotal !== null ? Number(line.discount_subtotal) : discountIncl / factor;
  return {
    unitPrice: round(pricesIncludeTax ? unitIncl : unitExcl),
    ...(discountIncl > 0 ? { discountAmount: round(pricesIncludeTax ? discountIncl : discountExcl) } : {}),
    quantity,
  };
};

/**
 * The sales order header. The BC customer is the one the customer sync
 * linked (metadata.bc_customer_number), else the default web customer.
 */
export const mapOrderHeader = (order, { defaultCustomerNumber, localCurrency = "SAR" }) => {
  const customerNumber = text(order.customer?.metadata?.bc_customer_number) || text(defaultCustomerNumber);
  if (!customerNumber) {
    return { error: "No BC customer: this customer was not moved from BC, and no default BC customer is set (Orders tab)." };
  }
  const address = order.shipping_address ?? {};
  const name = [address.first_name, address.last_name].map(text).filter(Boolean).join(" ");
  const currency = text(order.currency_code).toUpperCase();
  return {
    header: clean({
      customerNumber,
      externalDocumentNumber: externalNumber(order),
      orderDate: String(order.created_at).slice(0, 10),
      currencyCode: currency && currency !== text(localCurrency).toUpperCase() ? currency : undefined,
      email: text(order.email) || undefined,
      phoneNumber: text(address.phone) || undefined,
      shipToName: name || text(address.company) || undefined,
      shipToAddressLine1: text(address.address_1) || undefined,
      shipToAddressLine2: text(address.address_2) || undefined,
      shipToCity: text(address.city) || undefined,
      shipToState: text(address.province) || undefined,
      shipToPostCode: text(address.postal_code) || undefined,
      shipToCountry: text(address.country_code).toUpperCase() || undefined,
    }),
  };
};

/**
 * The sales order lines: one Item line per order item (the BC item and
 * variant the item sync recorded on the variant), and one line for
 * shipping when the order charged any. Every problem is returned; a single
 * one means the order is not sent.
 */
export const mapOrderLines = (order, { pricesIncludeTax, locationId, shipping }) => {
  const lines = [];
  const problems = [];
  for (const item of order.items ?? []) {
    const metadata = item.variant?.metadata ?? {};
    const quantity = Number(item.quantity ?? item.detail?.quantity ?? 0);
    if (!metadata.bc_item_number) {
      problems.push(`"${item.title}" (SKU ${item.variant_sku || "-"}) is not a BC item: its variant has no bc_item_number.`);
      continue;
    }
    lines.push(
      clean({
        lineType: "Item",
        lineObjectNumber: metadata.bc_item_number,
        itemVariantId: metadata.bc_variant_id || undefined,
        locationId: locationId || undefined,
        ...amounts(item, quantity, pricesIncludeTax),
      }),
    );
  }
  for (const method of order.shipping_methods ?? []) {
    if (!(Number(method.amount) > 0)) continue;
    if (!shipping?.type || !shipping?.number) {
      problems.push(`Shipping "${method.name}" was charged, but no BC account or item for shipping is set (Orders tab).`);
      continue;
    }
    lines.push({ lineType: shipping.type, lineObjectNumber: shipping.number, description: text(method.name).slice(0, 100) || "Shipping", ...amounts(method, 1, pricesIncludeTax) });
  }
  if (!lines.length && !problems.length) problems.push("The order has no lines.");
  return { lines, problems };
};
