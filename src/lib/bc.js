// Business Central client: Entra ID client-credentials token, API v2.0 and
// published OData pages. Ported from the in-Medusa plugin.

import { createHash } from "node:crypto";

const SCOPE = "https://api.businesscentral.dynamics.com/.default";
const TIMEOUT_MS = 30000;
// BC pages large lists via @odata.nextLink. Past this many pages is an
// error, never a short list: a partial item list would read as "gone from BC".
const MAX_PAGES = 1000;

export class BcError extends Error {
  constructor(code, message, status) {
    super(message);
    this.name = "BcError";
    this.code = code;
    this.status = status;
  }
}

const value = (env, name) => (typeof env[name] === "string" ? env[name].trim() : "");

export const bcCredentials = (env) => ({
  url: value(env, "BC_ENVIRONMENT_URL"),
  tenantId: value(env, "BC_TENANT_ID"),
  clientId: value(env, "BC_CLIENT_ID"),
  clientSecret: value(env, "BC_CLIENT_SECRET"),
  authority: value(env, "BC_AUTHORITY_URL") || "https://login.microsoftonline.com",
});

export const missingBcSettings = (credentials) =>
  [
    ["BC_ENVIRONMENT_URL", credentials.url],
    ["BC_TENANT_ID", credentials.tenantId],
    ["BC_CLIENT_ID", credentials.clientId],
    ["BC_CLIENT_SECRET", credentials.clientSecret],
  ]
    .filter(([, set]) => !set)
    .map(([name]) => name);

export const bcApiRoot = (url) => url.replace(/\/+$/, "").replace(/\/api\/v2\.0$/i, "") + "/api/v2.0";
const environmentRoot = (url) => bcApiRoot(url).replace(/\/api\/v2\.0$/i, "");

const timed = async (url, init) => {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === "TimeoutError") throw new BcError("timeout", "Business Central did not answer in time.");
    throw new BcError("network", `Could not reach Business Central: ${error?.message || error}`);
  }
};

// One token per (tenant, client, secret) until a minute before it expires.
// Lives as long as the isolate; a "check connection" always asks afresh.
const tokens = new Map();
const tokenKey = (c) => `${c.tenantId}|${c.clientId}|${createHash("sha256").update(c.clientSecret).digest("hex")}`;

export async function bcToken(credentials, { fresh = false, budget } = {}) {
  const missing = missingBcSettings(credentials);
  if (missing.length) throw new BcError("auth_failed", `Missing settings: ${missing.join(", ")}.`);
  const key = tokenKey(credentials);
  const cached = tokens.get(key);
  if (!fresh && cached && cached.expiresAt > Date.now()) return cached.token;
  budget?.use();
  const res = await timed(`${credentials.authority}/${encodeURIComponent(credentials.tenantId)}/oauth2/v2.0/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      scope: SCOPE,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // Entra's description carries a trace id after the first line; the first line is the reason.
    const reason = (body.error_description || `HTTP ${res.status}`).split(/\r?\n/)[0];
    throw new BcError("auth_failed", `Entra ID refused the credentials: ${reason}`, res.status);
  }
  tokens.set(key, { token: body.access_token, expiresAt: Date.now() + (Number(body.expires_in || 3600) - 60) * 1000 });
  return body.access_token;
}

/** GET a BC path (relative to the API root) or an absolute URL (a nextLink). */
export async function bcGet(credentials, pathOrUrl, options = {}) {
  const token = await bcToken(credentials, options);
  options.budget?.use();
  const url = /^https?:/i.test(pathOrUrl) ? pathOrUrl : `${bcApiRoot(credentials.url)}${pathOrUrl}`;
  const res = await timed(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new BcError(
      "http_error",
      `Business Central refused the request (HTTP ${res.status})${body.error?.message ? `: ${body.error.message}` : ""}`,
      res.status,
    );
  }
  return body;
}

/** Every row of a BC collection, following @odata.nextLink to the end. */
export async function bcGetAll(credentials, path, options = {}) {
  const rows = [];
  let next = path;
  for (let page = 0; next && page < MAX_PAGES; page++) {
    const body = await bcGet(credentials, next, { ...options, fresh: options.fresh && page === 0 });
    rows.push(...(body.value ?? []));
    next = body["@odata.nextLink"];
  }
  if (next) throw new BcError("http_error", `Business Central returned more than ${MAX_PAGES} pages; stopped rather than use a partial list.`);
  return rows;
}

const label = (row) => row.displayName || row.name || "";
const companyPath = (companyId) => `/companies(${encodeURIComponent(companyId)})`;

export const listBcCompanies = async (credentials, options) =>
  (await bcGetAll(credentials, "/companies", options)).map((c) => ({ id: c.id, name: c.name, displayName: label(c) || c.name }));

const coded = (rows) => rows.filter((row) => row.code).map((row) => ({ id: row.id ?? "", code: row.code, displayName: label(row) || row.code }));

export const listBcLocations = async (credentials, companyId, options) =>
  coded(await bcGetAll(credentials, `${companyPath(companyId)}/locations`, options));

/** Payment Methods (page 427): CASH, CARD, BANK... */
export const listBcPaymentMethods = async (credentials, companyId, options) =>
  coded(await bcGetAll(credentials, `${companyPath(companyId)}/paymentMethods`, options));

export const listBcItemCategories = (credentials, companyId, options) =>
  bcGetAll(credentials, `${companyPath(companyId)}/itemCategories`, options);

/**
 * Items that are not blocked (checked again here in case BC ignores the
 * filter), or every item when `includeBlocked` is set.
 */
export const listBcItems = async (credentials, companyId, options, { includeBlocked = false } = {}) =>
  includeBlocked
    ? bcGetAll(credentials, `${companyPath(companyId)}/items`, options)
    : (await bcGetAll(credentials, `${companyPath(companyId)}/items?$filter=${encodeURIComponent("blocked eq false")}`, options)).filter(
        (item) => item.blocked !== true,
      );

export const listBcItemVariants = (credentials, companyId, options) =>
  bcGetAll(credentials, `${companyPath(companyId)}/itemVariants`, options);

/**
 * Rows of a page published as a web service, addressed by company NAME (not
 * id, not display name: "Hoven Ltd" vs "HOVEN LTD" was a real 404).
 */
export const listBcODataRows = (credentials, companyName, service, query, options) =>
  bcGetAll(
    credentials,
    `${environmentRoot(credentials.url)}/ODataV4/Company('${encodeURIComponent(companyName.replace(/'/g, "''"))}')/${encodeURIComponent(service)}${query ? `?${query}` : ""}`,
    options,
  );
