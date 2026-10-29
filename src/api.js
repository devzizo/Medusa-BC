import { bcCredentials, listBcCompanies, listBcLocations, listBcPaymentMethods } from "./lib/bc.js";
import { medusaClient } from "./lib/medusa.js";
import { checkBusinessCentral, checkMedusa, describeSettings, isAuthorized } from "./config.js";
import { DEFAULT_INVENTORY_SERVICE } from "./sync/inventory.js";
import { DEFAULT_PRICE_LIST_LINE_SERVICE, DEFAULT_PRICE_LIST_SERVICE } from "./sync/items.js";

// The middleware API behind the admin page. Everything the page saves lives
// in the MiddlewareStore Durable Object; connection settings come from env.
//
//   GET  /api/middleware/status                 env settings (set/missing) + saved settings
//   POST /api/middleware/check/{bc,medusa}      live connection checks
//   POST /api/middleware/company                { company_id } chosen from BC's list
//   POST /api/middleware/settings               posting groups and price list service names
//   GET  /api/middleware/mappings/{locations,payments}
//   POST /api/middleware/mappings/{locations,payments}   { mappings: [{ id, code|null }] }
//   GET  /api/middleware/{items,categories,inventory,customers}/runs
//   POST /api/middleware/{items,categories,inventory,customers}/run

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
};

const PUBLIC_SETTINGS = [
  "vat_bus_posting_group",
  "gen_bus_posting_group",
  "price_list_service",
  "price_list_line_service",
  "inventory_service",
  "skip_blocked",
  "draft_zero_inventory",
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
      },
    });
  }
  if (pathname === "/api/middleware/check/medusa" && method === "POST") return json(await checkMedusa(env));
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

  const mapping = pathname.match(/^\/api\/middleware\/mappings\/(locations|payments)$/);
  if (mapping) {
    const kind = mapping[1];
    const companyId = (await db.getSettings()).company_id;
    if (!companyId) return fail("Choose a Business Central company in Settings first.", 409);
    if (method === "GET") {
      const [medusa, bc] = await Promise.allSettled([MAPPINGS[kind].medusa(env), MAPPINGS[kind].bc(env, companyId)]);
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
      const [medusa, bc] = await Promise.all([MAPPINGS[kind].medusa(env), MAPPINGS[kind].bc(env, companyId)]).catch((error) => [error]);
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

  const sync = pathname.match(/^\/api\/middleware\/(items|categories|inventory|customers)\/(runs|run)$/);
  if (sync) {
    const [, kind, action] = sync;
    if (action === "runs" && method === "GET") return json({ runs: await db.listRuns(kind) });
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
