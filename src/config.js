// Middleware settings: Medusa and Business Central connection, read from the
// Worker env. Secrets come from `wrangler secret put` (or .dev.vars locally)
// and are never returned: the status only says whether each one is set.

const SETTINGS = {
  medusa: [
    { name: "MEDUSA_BACKEND_URL", secret: false },
    { name: "MEDUSA_ADMIN_API_KEY", secret: true },
  ],
  bc: [
    { name: "BC_ENVIRONMENT_URL", secret: false },
    { name: "BC_TENANT_ID", secret: false },
    { name: "BC_CLIENT_ID", secret: false },
    { name: "BC_CLIENT_SECRET", secret: true },
    { name: "BC_COMPANY_ID", secret: false },
  ],
  middleware: [{ name: "MIDDLEWARE_ADMIN_TOKEN", secret: true }],
};

const TIMEOUT_MS = 30000;
const BC_SCOPE = "https://api.businesscentral.dynamics.com/.default";

const value = (env, name) => (typeof env[name] === "string" ? env[name].trim() : "");

/** Set / missing per setting; non-secret values are shown, secrets never. */
export function describeSettings(env) {
  const groups = {};
  const missing = [];
  for (const [group, settings] of Object.entries(SETTINGS)) {
    groups[group] = settings.map(({ name, secret }) => {
      const set = Boolean(value(env, name));
      if (!set) missing.push(name);
      return secret ? { name, secret, set } : { name, secret, set, value: value(env, name) || null };
    });
  }
  return { groups, missing };
}

const withTimeout = (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });

const failure = (error) => (error?.name === "TimeoutError" ? "Timed out" : error?.message || String(error));

// Medusa secret keys go in a Basic header; a Bearer header is refused with 401.
export async function checkMedusa(env) {
  const url = value(env, "MEDUSA_BACKEND_URL");
  const key = value(env, "MEDUSA_ADMIN_API_KEY");
  if (!url || !key) return { ok: false, message: "MEDUSA_BACKEND_URL and MEDUSA_ADMIN_API_KEY are required." };
  try {
    const res = await withTimeout(new URL("/admin/stores?fields=id,name", url), {
      headers: { authorization: `Basic ${key}` },
    });
    if (res.status === 401) return { ok: false, message: "Medusa refused the secret API key (401)." };
    if (!res.ok) return { ok: false, message: `Medusa answered HTTP ${res.status}.` };
    const body = await res.json();
    return { ok: true, message: `Connected to Medusa store "${body.stores?.[0]?.name ?? "?"}".` };
  } catch (error) {
    return { ok: false, message: `Could not reach Medusa: ${failure(error)}` };
  }
}

const bcApiRoot = (url) => url.replace(/\/+$/, "").replace(/\/api\/v2\.0$/i, "") + "/api/v2.0";

// Always a fresh Entra token: this is the check that the saved secret works.
export async function checkBusinessCentral(env) {
  const names = ["BC_ENVIRONMENT_URL", "BC_TENANT_ID", "BC_CLIENT_ID", "BC_CLIENT_SECRET"];
  if (names.some((name) => !value(env, name))) return { ok: false, message: `${names.join(", ")} are required.` };
  const authority = value(env, "BC_AUTHORITY_URL") || "https://login.microsoftonline.com";
  try {
    const tokenRes = await withTimeout(`${authority}/${encodeURIComponent(value(env, "BC_TENANT_ID"))}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: value(env, "BC_CLIENT_ID"),
        client_secret: value(env, "BC_CLIENT_SECRET"),
        scope: BC_SCOPE,
      }),
    });
    const token = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !token.access_token) {
      // Entra's description carries a trace id after the first line; the first line is the reason.
      const reason = (token.error_description || `HTTP ${tokenRes.status}`).split(/\r?\n/)[0];
      return { ok: false, message: `Entra ID refused the credentials: ${reason}` };
    }
    const res = await withTimeout(`${bcApiRoot(value(env, "BC_ENVIRONMENT_URL"))}/companies`, {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, message: `Business Central answered HTTP ${res.status}${body.error?.message ? `: ${body.error.message}` : ""}` };
    const companies = (body.value ?? []).map((c) => ({ id: c.id, name: c.name, displayName: c.displayName || c.name }));
    const companyId = value(env, "BC_COMPANY_ID");
    const company = companies.find((c) => c.id === companyId);
    return {
      ok: Boolean(company),
      message: company
        ? `Connected to Business Central, company "${company.displayName}".`
        : companyId
          ? "Connected, but BC_COMPANY_ID is not one of the companies below."
          : "Connected. Set BC_COMPANY_ID to one of the companies below.",
      companies,
    };
  } catch (error) {
    return { ok: false, message: `Could not reach Business Central: ${failure(error)}` };
  }
}

/** Constant-time comparison of the admin token, so it cannot be guessed byte by byte. */
export function isAuthorized(request, env) {
  const expected = value(env, "MIDDLEWARE_ADMIN_TOKEN");
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}

const json = (body, status = 200) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

/**
 * The middleware API, all behind MIDDLEWARE_ADMIN_TOKEN:
 *   GET  /api/middleware/status        which settings are set or missing (never a secret's value)
 *   POST /api/middleware/check/medusa  live check of the Medusa secret key
 *   POST /api/middleware/check/bc      live check of the BC credentials and company
 */
export async function middlewareApi(request, env, pathname) {
  if (!value(env, "MIDDLEWARE_ADMIN_TOKEN")) {
    return json({ error: "MIDDLEWARE_ADMIN_TOKEN is not set; the middleware API is closed." }, 503);
  }
  if (!isAuthorized(request, env)) return json({ error: "Unauthorized" }, 401);

  if (pathname === "/api/middleware/status" && request.method === "GET") {
    const settings = describeSettings(env);
    return json({ settings: settings.groups, missing: settings.missing });
  }
  if (pathname === "/api/middleware/check/medusa" && request.method === "POST") return json(await checkMedusa(env));
  if (pathname === "/api/middleware/check/bc" && request.method === "POST") return json(await checkBusinessCentral(env));
  return json({ error: "Not found" }, 404);
}
