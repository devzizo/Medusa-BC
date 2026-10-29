// Medusa Admin API client with the secret API key. Medusa takes secret keys
// as HTTP Basic; a Bearer header is refused with 401.

const TIMEOUT_MS = 30000;
const PAGE = 100;

export class MedusaApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "MedusaApiError";
    this.status = status;
  }
}

const value = (env, name) => (typeof env[name] === "string" ? env[name].trim() : "");

// Arrays become key[]=a&key[]=b, which Medusa's query parser reads as a list.
const toQuery = (query = {}) => {
  const params = new URLSearchParams();
  for (const [key, val] of Object.entries(query)) {
    if (val === undefined || val === null) continue;
    if (Array.isArray(val)) val.forEach((item) => params.append(`${key}[]`, item));
    else params.set(key, String(val));
  }
  const text = params.toString();
  return text ? `?${text}` : "";
};

/**
 * A client for one call budget. `budget` (optional) counts subrequests so a
 * sync step can stop before the Worker's per-invocation limit.
 */
export function medusaClient(env, budget) {
  const base = value(env, "MEDUSA_BACKEND_URL");
  const key = value(env, "MEDUSA_ADMIN_API_KEY");

  const call = async (method, path, { query, body } = {}) => {
    if (!base || !key) throw new MedusaApiError("MEDUSA_BACKEND_URL and MEDUSA_ADMIN_API_KEY are required.");
    budget?.use();
    let res;
    try {
      res = await fetch(new URL(`${path}${toQuery(query)}`, base), {
        method,
        headers: { authorization: `Basic ${key}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      throw new MedusaApiError(error?.name === "TimeoutError" ? "Medusa did not answer in time." : `Could not reach Medusa: ${error?.message || error}`);
    }
    if (res.status === 401) throw new MedusaApiError("Medusa refused the secret API key (401).", 401);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new MedusaApiError(`Medusa ${method} ${path}: ${data.message || `HTTP ${res.status}`}`, res.status);
    return data;
  };

  /** Every row of a list endpoint, page by page. */
  const listAll = async (path, key, query = {}) => {
    const rows = [];
    for (let offset = 0; ; offset += PAGE) {
      const data = await call("GET", path, { query: { ...query, limit: PAGE, offset } });
      rows.push(...(data[key] ?? []));
      if (rows.length >= (data.count ?? 0) || !(data[key] ?? []).length) return rows;
    }
  };

  /** Uploads one file through Medusa's file provider; returns { id, url }. */
  const upload = async (name, bytes, type) => {
    if (!base || !key) throw new MedusaApiError("MEDUSA_BACKEND_URL and MEDUSA_ADMIN_API_KEY are required.");
    budget?.use();
    const form = new FormData();
    form.append("files", new Blob([bytes], { type }), name);
    let res;
    try {
      res = await fetch(new URL("/admin/uploads", base), { method: "POST", headers: { authorization: `Basic ${key}` }, body: form, signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch (error) {
      throw new MedusaApiError(`Could not upload to Medusa: ${error?.message || error}`);
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.files?.[0]?.url) throw new MedusaApiError(`Medusa upload: ${data.message || `HTTP ${res.status}`}`, res.status);
    return data.files[0];
  };

  return {
    upload,
    get: (path, query) => call("GET", path, { query }),
    post: (path, body, query) => call("POST", path, { body: body ?? {}, query }),
    del: (path) => call("DELETE", path),
    listAll,
  };
}

/** Counts subrequests; `left()` says how many the current invocation may still make. */
export const makeBudget = (limit) => {
  let used = 0;
  return {
    use() {
      used++;
    },
    left: () => limit - used,
    get used() {
      return used;
    },
  };
};
