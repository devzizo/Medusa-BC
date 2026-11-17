import { bcCredentials, bcGet, bcGetBinary, listBcCompanies, listBcItems, listBcLocations, listBcODataRows, listBcPaymentMethods, putBcItemPicture, searchBcItems } from "./lib/bc.js";
import { decodePicture, itemSearchFilter, listedItem } from "./lib/pictures.js";
import { productHandle } from "./lib/map.js";
import { syncProductPicture } from "./sync/images.js";
import { mapPriceLists } from "./lib/map.js";
import { medusaClient } from "./lib/medusa.js";
import { checkBusinessCentral, checkMedusa, describeSettings, isAuthorized } from "./config.js";
import { DEFAULT_INVENTORY_SERVICE } from "./sync/inventory.js";
import { postOrder, refreshOrder } from "./sync/orders.js";
import { checkMarketingTextService, DEFAULT_ITEM_CARD_SERVICE, DEFAULT_MARKETING_TEXT_SERVICE, DEFAULT_ITEM_REFERENCE_SERVICE, DEFAULT_PRICE_LIST_LINE_SERVICE, DEFAULT_PRICE_LIST_SERVICE } from "./sync/items.js";

// The middleware API behind the admin page. Everything the page saves lives
// in the MiddlewareStore Durable Object; connection settings come from env.
//
//   GET  /api/middleware/status                 env settings (set/missing) + saved settings
//   POST /api/middleware/check/marketing-text    reads the Marketing Text page as the sync would; writes nothing
//   POST /api/middleware/check/{bc,medusa}      live connection checks
//   POST /api/middleware/company                { company_id } chosen from BC's list
//   POST /api/middleware/settings               posting groups and price list service names
//   GET  /api/middleware/price-lists              BC's sales price lists, and which can be imported
//   GET  /api/middleware/orders?offset=           Medusa orders, newest first, with what was posted to BC
//   POST /api/middleware/orders/:id/sync          post one order to BC as a sales order (by hand)
//   POST /api/middleware/orders/:id/refresh       read BC's state of a posted order, write it on the Medusa order
//   GET  /api/middleware/mappings/{locations,payments,shipping}
//   POST /api/middleware/mappings/{locations,payments,shipping}   { mappings: [{ id, code|null }] }
//   GET  /api/middleware/{items,categories,images,inventory,customers}/runs
//   POST /api/middleware/{items,categories,images,inventory,customers}/run
//   GET  /api/middleware/pictures/search?q=       BC items by number or name (the «رفع الصور» tab)
//   GET  /api/middleware/pictures/log             the pictures written from the tab, newest first
//   GET  /api/middleware/pictures/:itemId         the item, its BC picture (has / size) and its product in Medusa
//   GET  /api/middleware/pictures/:itemId/content the BC picture itself, for the preview
//   POST /api/middleware/pictures/:itemId         { image: data URL } → written to the BC item's picture
//   POST /api/middleware/pictures/:itemId/transfer that item's picture carried to its Medusa product now

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });
const fail = (message, status = 400) => json({ error: message }, status);

const store = (env) => env.STORE.get(env.STORE.idFromName("main"));

const errorMessage = (error) => error?.message || String(error);

// Each mapping: the Medusa side's live list, and BC's list for the company.
const MAPPINGS = {
  locations: {
    medusa: async (env) =>
      (await medusaClient(env).listAll("/admin/stock-locations", "stock_locations", { fields: "id,name" })).map((l) => ({ id: l.id, name: l.name })),
    bc: (env, companyId) => listBcLocations(bcCredentials(env), companyId),
  },
  payments: {
    medusa: async (env) =>
      (await medusaClient(env).listAll("/admin/payments/payment-providers", "payment_providers", { fields: "id,is_enabled" })).map((p) => ({
        id: p.id,
        name: p.is_enabled === false ? `${p.id} (disabled)` : p.id,
      })),
    bc: (env, companyId) => listBcPaymentMethods(bcCredentials(env), companyId),
  },
  // Shipping Agents (page 428) are not in API v2.0: read over OData from the published page.
  shipping: {
    medusa: async (env) =>
      (await medusaClient(env).listAll("/admin/shipping-options", "shipping_options", { fields: "id,name,service_zone.name" })).map((o) => ({
        id: o.id,
        name: o.service_zone?.name ? `${o.name} (${o.service_zone.name})` : o.name,
      })),
    bc: async (env, companyId, settings) =>
      (await listBcODataRows(bcCredentials(env), settings.company_name, settings.shipping_agent_service || DEFAULT_SHIPPING_AGENT_SERVICE).catch((error) => {
        throw new Error(`${error.message} (web service "${settings.shipping_agent_service || DEFAULT_SHIPPING_AGENT_SERVICE}": publish page 428 Shipping Agents)`);
      }))
        .filter((row) => row.Code)
        .map((row) => ({ id: "", code: row.Code, displayName: row.Name || row.Code })),
  },
};

export const DEFAULT_SHIPPING_AGENT_SERVICE = "ShippingAgents";

const PUBLIC_SETTINGS = [
  "shipping_agent_service",
  "item_reference_service",
  "item_card_service",
  "marketing_text_service",
  "vat_bus_posting_group",
  "gen_bus_posting_group",
  "price_list_service",
  "price_list_line_service",
  "inventory_service",
  "price_lists",
  "order_customer_number",
  "order_shipping_type",
  "order_shipping_number",
  "order_location_code",
  "order_local_currency",
  "skip_blocked",
  "draft_zero_inventory",
  "publish_synced",
  "changed_only",
  "hide_without_picture",
];

export async function middlewareApi(request, env, pathname) {
  if (!isAuthorized(request, env)) return fail("Unauthorized", 401);
  const method = request.method;
  const body = method === "POST" ? await request.json().catch(() => ({})) : {};
  const db = store(env);

  if (pathname === "/api/middleware/status" && method === "GET") {
    const settings = describeSettings(env);
    return json({
      settings: settings.groups,
      missing: settings.missing,
      saved: await db.getSettings(),
      defaults: {
        price_list_service: DEFAULT_PRICE_LIST_SERVICE,
        price_list_line_service: DEFAULT_PRICE_LIST_LINE_SERVICE,
        inventory_service: DEFAULT_INVENTORY_SERVICE,
        shipping_agent_service: DEFAULT_SHIPPING_AGENT_SERVICE,
        item_reference_service: DEFAULT_ITEM_REFERENCE_SERVICE,
        item_card_service: DEFAULT_ITEM_CARD_SERVICE,
        marketing_text_service: DEFAULT_MARKETING_TEXT_SERVICE,
      },
    });
  }
  if (pathname === "/api/middleware/check/medusa" && method === "POST") return json(await checkMedusa(env));
  if (pathname === "/api/middleware/check/marketing-text" && method === "POST") {
    const saved = await db.getSettings();
    if (!saved.company_id) return fail("Choose a Business Central company in Settings first.", 409);
    const bc = bcCredentials(env);
    const report = await checkMarketingTextService(bc, saved, () => listBcItems(bc, saved.company_id, undefined, { includeBlocked: true })).catch((error) => ({ error: errorMessage(error) }));
    return report.error ? fail(report.error, 502) : json(report);
  }
  if (pathname === "/api/middleware/check/bc" && method === "POST") {
    return json(await checkBusinessCentral(env, (await db.getSettings()).company_id));
  }

  if (pathname === "/api/middleware/company" && method === "POST") {
    const companies = await listBcCompanies(bcCredentials(env)).catch((error) => error);
    if (companies instanceof Error) return fail(errorMessage(companies), 502);
    const company = companies.find((c) => c.id === body.company_id);
    if (!company) return fail("Business Central has no such company.");
    return json(await db.selectCompany(company));
  }

  if (pathname === "/api/middleware/settings" && method === "POST") {
    const patch = Object.fromEntries(PUBLIC_SETTINGS.filter((key) => typeof body[key] === "string").map((key) => [key, body[key]]));
    return json({ saved: await db.saveSettings(patch) });
  }

  if (pathname === "/api/middleware/price-lists" && method === "GET") {
    const saved = await db.getSettings();
    if (!saved.company_id) return fail("Choose a Business Central company in Settings first.", 409);
    const service = saved.price_list_service || DEFAULT_PRICE_LIST_SERVICE;
    const headers = await listBcODataRows(bcCredentials(env), saved.company_name, service).catch((error) => error);
    if (headers instanceof Error) return fail(`${errorMessage(headers)} (web service "${service}")`, 502);
    // The same rules the item sync applies, so the page says which lists it would skip and why.
    const { priceLists, issues } = mapPriceLists(headers, [], { currencyCode: "", storeVatBusPostingGroup: saved.vat_bus_posting_group, skusByItem: new Map(), baseUnitByItem: new Map() });
    const importable = new Set(priceLists.map((list) => list.code));
    const reasons = new Map(issues.map((issue) => [issue.ref, issue.message]));
    return json({
      price_lists: headers
        .filter((h) => h.Code)
        .map((h) => ({
          code: h.Code,
          description: h.Description ?? "",
          status: h.Status ?? "",
          currency: h.Currency_Code ?? "",
          starts: h.Starting_Date ?? "",
          ends: h.Ending_Date ?? "",
          importable: importable.has(h.Code),
          reason: reasons.get(h.Code) ?? null,
        })),
    });
  }

  if (pathname === "/api/middleware/orders" && method === "GET") {
    const offset = Math.max(0, Number(new URL(request.url).searchParams.get("offset")) || 0);
    const data = await medusaClient(env)
      .get("/admin/orders", {
        fields: "id,display_id,created_at,email,currency_code,total,status,payment_status,fulfillment_status,customer.first_name,customer.last_name,customer.company_name,customer.metadata,shipping_address.first_name,shipping_address.last_name",
        order: "-created_at",
        limit: 20,
        offset,
      })
      .catch((error) => error);
    if (data instanceof Error) return fail(errorMessage(data), 502);
    const records = new Map((await db.orderRecords(data.orders.map((o) => o.id))).map((r) => [r.order_id, r]));
    return json({ count: data.count, offset, limit: 20, orders: data.orders.map((o) => ({ ...o, bc: records.get(o.id) ?? null })) });
  }
  const orderAction = pathname.match(/^\/api\/middleware\/orders\/([^/]+)\/(sync|refresh)$/);
  if (orderAction && method === "POST") {
    const [, id, action] = orderAction;
    const result =
      action === "sync"
        ? await postOrder(env, db, decodeURIComponent(id)).catch((error) => ({ error: errorMessage(error) }))
        : await refreshOrder(env, db, decodeURIComponent(id))
            .then((record) => (record?.status === "synced" ? { record } : { error: "This order is not in BC yet." }))
            .catch((error) => ({ error: errorMessage(error) }));
    return result.error ? fail(result.error, 409) : json(result);
  }

  const mapping = pathname.match(/^\/api\/middleware\/mappings\/(locations|payments|shipping)$/);
  if (mapping) {
    const kind = mapping[1];
    const settings = await db.getSettings();
    const companyId = settings.company_id;
    if (!companyId) return fail("Choose a Business Central company in Settings first.", 409);
    if (method === "GET") {
      const [medusa, bc] = await Promise.allSettled([MAPPINGS[kind].medusa(env), MAPPINGS[kind].bc(env, companyId, settings)]);
      return json({
        medusa: medusa.status === "fulfilled" ? medusa.value : [],
        bc: bc.status === "fulfilled" ? bc.value : [],
        saved: await db.getMappings(kind, companyId),
        errors: {
          medusa: medusa.status === "rejected" ? errorMessage(medusa.reason) : null,
          bc: bc.status === "rejected" ? errorMessage(bc.reason) : null,
        },
      });
    }
    if (method === "POST") {
      const rows = Array.isArray(body.mappings) ? body.mappings.slice(0, 500) : [];
      // Both sides are checked against the live lists: a mapping can only name things that exist.
      const [medusa, bc] = await Promise.all([MAPPINGS[kind].medusa(env), MAPPINGS[kind].bc(env, companyId, settings)]).catch((error) => [error]);
      if (medusa instanceof Error) return fail(errorMessage(medusa), 502);
      const medusaIds = new Set(medusa.map((row) => row.id));
      const bcByCode = new Map(bc.map((row) => [row.code, row]));
      const unknown = rows.filter((row) => !medusaIds.has(row.id) || (row.code && !bcByCode.has(row.code)));
      if (unknown.length) return fail(`Unknown: ${unknown.map((row) => `${row.id} → ${row.code}`).join(", ")}`);
      const saved = await db.saveMappings(
        kind,
        companyId,
        rows.map((row) => ({ id: row.id, code: row.code || null, name: row.code ? bcByCode.get(row.code).displayName : null })),
      );
      return json({ saved });
    }
  }

  // ---- «رفع الصور» (the owner, 2026-11-17): an item's picture written into BC, then carried to the store ----
  if (pathname.startsWith("/api/middleware/pictures/")) {
    const saved = await db.getSettings();
    if (!saved.company_id) return fail("Choose a Business Central company in Settings first.", 409);
    const bc = bcCredentials(env);
    const company = `/companies(${encodeURIComponent(saved.company_id)})`;

    if (pathname === "/api/middleware/pictures/search" && method === "GET") {
      const filter = itemSearchFilter(new URL(request.url).searchParams.get("q"));
      if (!filter) return fail("اكتب من حرفين إلى أربعين حرفًا.");
      const items = await searchBcItems(bc, saved.company_id, filter).catch((error) => error);
      return items instanceof Error ? fail(errorMessage(items), 502) : json({ items: items.map(listedItem) });
    }
    if (pathname === "/api/middleware/pictures/log" && method === "GET") return json({ uploads: await db.listPictureUploads() });

    const match = pathname.match(/^\/api\/middleware\/pictures\/([0-9a-fA-F-]{36})(?:\/(content|transfer))?$/);
    if (!match) return fail("Not found", 404);
    const [, itemId, part] = match;
    const itemPath = `${company}/items(${encodeURIComponent(itemId)})`;
    const item = await bcGet(bc, `${itemPath}?$select=id,number,displayName,blocked`).catch((error) => error);
    if (item instanceof Error) return fail(errorMessage(item), item.status === 404 ? 404 : 502);

    // The item's product in Medusa, if the item sync made one (same handle, same BC id)
    const productOf = async (medusa) => {
      const { products } = await medusa.get("/admin/products", { handle: productHandle(item.number ?? ""), fields: "id,handle,title,status,thumbnail,metadata,images.url" });
      return (products ?? []).find((p) => p.metadata?.bc_item_id === item.id) ?? null;
    };

    if (!part && method === "GET") {
      const [picture, product] = await Promise.allSettled([bcGet(bc, `${itemPath}/picture`), productOf(medusaClient(env))]);
      const pic = picture.status === "fulfilled" ? picture.value : null;
      const p = product.status === "fulfilled" ? product.value : null;
      return json({
        item: listedItem(item),
        picture: pic ? { has: Number(pic.width) > 0 && Boolean(pic.contentType), width: pic.width ?? 0, height: pic.height ?? 0, contentType: pic.contentType ?? "" } : null,
        product: p ? { id: p.id, handle: p.handle, status: p.status, thumbnail: p.thumbnail ?? null } : null,
        errors: {
          picture: picture.status === "rejected" ? errorMessage(picture.reason) : null,
          product: product.status === "rejected" ? errorMessage(product.reason) : null,
        },
      });
    }

    if (part === "content" && method === "GET") {
      const picture = await bcGetBinary(bc, `${itemPath}/picture/pictureContent`).catch((error) => error);
      if (picture instanceof Error) return fail(errorMessage(picture), 502);
      return new Response(picture.bytes, { headers: { "content-type": picture.contentType || "application/octet-stream", "cache-control": "no-store" } });
    }

    if (!part && method === "POST") {
      const decoded = decodePicture(body.image);
      if (decoded.error) return fail(decoded.error);
      const written = await putBcItemPicture(bc, saved.company_id, item.id, decoded.bytes).catch((error) => error);
      if (written instanceof Error) return fail(errorMessage(written), 502);
      // Cloudflare Access names the signed-in person on every request it lets through
      const by = request.headers.get("cf-access-authenticated-user-email") || null;
      await db.logPictureUpload({ item_id: item.id, item_number: item.number, item_name: item.displayName, bytes: decoded.bytes.length, by });
      return json({ ok: true, item: listedItem(item), bytes: decoded.bytes.length });
    }

    if (part === "transfer" && method === "POST") {
      const medusa = medusaClient(env);
      const product = await productOf(medusa).catch((error) => error);
      if (product instanceof Error) return fail(errorMessage(product), 502);
      if (!product) return fail("لا يوجد منتج في المتجر لهذا الصنف بعد: تُنشئه مزامنة المنتجات أولًا.", 409);
      const summary = { uploaded: 0, unchanged: 0, no_picture: 0, removed: 0, failed: 0, hidden: 0, shown: 0 };
      const notes = [];
      await syncProductPicture({
        product,
        medusa,
        bc,
        hide: saved.hide_without_picture === "1",
        settings: saved,
        summary,
        note: (issue) => notes.push(issue),
      });
      return summary.failed ? fail(notes[0]?.message || "تعذّر نقل الصورة.", 502) : json({ summary, notes });
    }
    return fail("Not found", 404);
  }

  const sync = pathname.match(/^\/api\/middleware\/(items|categories|images|inventory|customers)\/(runs|run)$/);
  if (sync) {
    const [, kind, action] = sync;
    if (action === "runs" && method === "GET") return json(await db.listRuns(kind));
    if (action === "run" && method === "POST") {
      const saved = await db.getSettings();
      if (!saved.company_id) return fail("Choose a Business Central company in Settings first.", 409);
      if (kind === "inventory" && !(await db.getMappings("locations", saved.company_id)).length) {
        return fail("Map at least one stock location to a BC location first (Locations tab).", 409);
      }
      const started = await db.startRun(kind);
      return started.error ? fail(started.error, 409) : json(started, 202);
    }
  }

  return fail("Not found", 404);
}
