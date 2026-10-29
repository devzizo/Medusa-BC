// Connection settings: Medusa and Business Central, read from the Worker env
// (Cloudflare → Variables and Secrets). Secrets are never returned: the
// status only says whether each one is set.

import { BcError, bcCredentials, listBcCompanies } from "./lib/bc.js";
import { medusaClient } from "./lib/medusa.js";

const SETTINGS = {
  medusa: [
    { name: "MEDUSA_BACKEND_URL", secret: false },
    { name: "MEDUSA_ADMIN_API_KEY", secret: true },
  ],
  // The company is chosen in the Settings tab, not here.
  bc: [
    { name: "BC_ENVIRONMENT_URL", secret: false },
    { name: "BC_TENANT_ID", secret: false },
    { name: "BC_CLIENT_ID", secret: false },
    { name: "BC_CLIENT_SECRET", secret: true },
  ],
};

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

export async function checkMedusa(env) {
  try {
    const { stores } = await medusaClient(env).get("/admin/stores", { fields: "id,name" });
    return { ok: true, message: `Connected to Medusa store "${stores?.[0]?.name ?? "?"}".` };
  } catch (error) {
    return { ok: false, message: error.message };
  }
}

// Always a fresh Entra token: this is the check that the saved secret works.
export async function checkBusinessCentral(env, companyId) {
  try {
    const companies = await listBcCompanies(bcCredentials(env), { fresh: true });
    const company = companies.find((c) => c.id === companyId);
    return {
      ok: Boolean(company),
      message: company
        ? `Connected to Business Central, company "${company.displayName}".`
        : companyId
          ? "Connected, but the chosen company is no longer in Business Central. Choose it again."
          : "Connected. Choose the company below.",
      companies,
    };
  } catch (error) {
    return { ok: false, message: error instanceof BcError ? error.message : `Could not reach Business Central: ${error.message}` };
  }
}

/**
 * Optional extra lock. Without MIDDLEWARE_ADMIN_TOKEN the API is open to
 * whoever can reach the page, so protect the page with Cloudflare Access.
 * With it, every call needs the token (compared in constant time).
 */
export function isAuthorized(request, env) {
  const expected = value(env, "MIDDLEWARE_ADMIN_TOKEN");
  if (!expected) return true;
  const header = request.headers.get("authorization") ?? "";
  const given = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ given.charCodeAt(i);
  return diff === 0;
}
