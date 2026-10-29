import { bcCompanyPath, bcCredentials, bcGet, bcSend, listBcLocations } from "../lib/bc.js";
import { medusaClient } from "../lib/medusa.js";
import { externalNumber, mapOrderHeader, mapOrderLines } from "../lib/orders.js";

// Posting one Medusa order to BC as a sales order, by hand from the Orders
// tab (never automatically). The order is looked up in BC first by its
// external document number (MED-<number>), as an open sales order or a
// posted invoice, so a second click or a lost record never makes a
// duplicate. If a line is refused, the half-made sales order is deleted,
// so a retry starts clean.

export const ORDER_FIELDS = [
  "id", "display_id", "created_at", "email", "currency_code", "total", "status", "payment_status", "fulfillment_status",
  "customer.id", "customer.first_name", "customer.last_name", "customer.company_name", "customer.metadata",
  "shipping_address.*",
  "items.id", "items.title", "items.quantity", "items.unit_price", "items.is_tax_inclusive", "items.discount_total", "items.discount_subtotal",
  "items.tax_lines.rate", "items.variant_sku", "items.variant.metadata",
  "shipping_methods.name", "shipping_methods.amount", "shipping_methods.is_tax_inclusive", "shipping_methods.discount_total",
  "shipping_methods.discount_subtotal", "shipping_methods.tax_lines.rate",
  "fulfillments.location_id",
].join(",");

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;

/** The sales order or posted invoice BC already holds for this order, if any. */
async function findInBc(bc, companyId, number) {
  const filter = encodeURIComponent(`externalDocumentNumber eq ${quote(number)}`);
  for (const [collection, kind] of [["salesOrders", "order"], ["salesInvoices", "invoice"]]) {
    const { value } = await bcGet(bc, `${bcCompanyPath(companyId)}/${collection}?$filter=${filter}`);
    if (value?.length) return { ...value[0], kind };
  }
  return null;
}

/** The BC location for the order: where it was fulfilled (if mapped), else the default. */
async function bcLocationId(bc, companyId, order, mappings, defaultCode) {
  const fulfilledAt = (order.fulfillments ?? []).map((f) => f.location_id).find(Boolean);
  const code = mappings.find((m) => m.id === fulfilledAt)?.code || defaultCode;
  if (!code) return null;
  const location = (await listBcLocations(bc, companyId)).find((l) => l.code === code);
  if (!location) throw new Error(`BC has no location ${code}.`);
  return location.id;
}

export async function postOrder(env, db, orderId) {
  const settings = await db.getSettings();
  if (!settings.company_id) return { error: "Choose a Business Central company in Settings first." };
  const medusa = medusaClient(env);
  const bc = bcCredentials(env);
  const { order } = await medusa.get(`/admin/orders/${encodeURIComponent(orderId)}`, { fields: ORDER_FIELDS });
  const claimed = await db.claimOrder(order.id, order.display_id);
  if (claimed.error) return { error: claimed.error };
  const companyId = settings.company_id;
  const number = externalNumber(order);
  let created = null;
  try {
    const existing = await findInBc(bc, companyId, number);
    if (existing) {
      // Already there (an earlier click whose answer was lost, or keyed in BC): link it, never duplicate.
      return {
        record: await db.finishOrder(order.id, {
          status: "synced",
          bc_order_id: existing.id,
          bc_order_number: existing.kind === "invoice" ? `${existing.number} (invoice)` : existing.number,
          bc_total: existing.totalAmountIncludingTax,
          medusa_total: order.total,
        }),
        linked: true,
      };
    }
    const mapped = mapOrderHeader(order, { defaultCustomerNumber: settings.order_customer_number, localCurrency: settings.order_local_currency || "SAR" });
    if (mapped.error) throw new Error(mapped.error);
    // Check every line before BC is touched.
    const shipping = { type: settings.order_shipping_type || "Account", number: settings.order_shipping_number };
    const precheck = mapOrderLines(order, { pricesIncludeTax: true, shipping });
    if (precheck.problems.length) throw new Error(precheck.problems.join(" "));
    const locationId = await bcLocationId(bc, companyId, order, await db.getMappings("locations", companyId), settings.order_location_code);

    created = await bcSend(bc, "POST", `${bcCompanyPath(companyId)}/salesOrders`, mapped.header);
    // Whether prices include VAT comes from the BC customer, so lines are priced after the header exists.
    const { lines } = mapOrderLines(order, { pricesIncludeTax: created.pricesIncludeTax !== false, locationId, shipping });
    for (const line of lines) {
      await bcSend(bc, "POST", `${bcCompanyPath(companyId)}/salesOrders(${created.id})/salesOrderLines`, line);
    }
    const header = await bcGet(bc, `${bcCompanyPath(companyId)}/salesOrders(${created.id})`);
    return {
      record: await db.finishOrder(order.id, {
        status: "synced",
        bc_order_id: created.id,
        bc_order_number: header.number,
        bc_total: header.totalAmountIncludingTax,
        medusa_total: order.total,
      }),
    };
  } catch (error) {
    let message = error?.message || String(error);
    if (created?.id) {
      // Leave nothing half-made in BC: the retry will create it whole.
      await bcSend(bc, "DELETE", `${bcCompanyPath(companyId)}/salesOrders(${created.id})`).catch((cleanup) => {
        message += ` The incomplete BC sales order ${created.number} could not be deleted (${cleanup.message}); delete it in BC before retrying.`;
      });
    }
    return { record: await db.finishOrder(order.id, { status: "failed", medusa_total: order.total, error: message }) };
  }
}
