import { bcCredentials, listBcCustomers } from "../lib/bc.js";
import { makeBudget, medusaClient } from "../lib/medusa.js";
import { addressChanged, addressUpdate, customerChanged, customerUpdate, mapCustomer } from "../lib/customers.js";

// The customer sync, BC → Medusa: every BC customer (blocked ones too, with
// their state in metadata) becomes a Medusa customer with one address named
// "Business Central". A customer is owned by its BC number
// (metadata.bc_customer_number), so a second run updates rather than
// duplicates, and a customer that did not come from BC is never touched.
// Medusa allows one guest customer per email: an email already held by a
// customer the sync does not own, or by an earlier BC customer, is left out
// and reported, never taken over. Runs in steps under a call budget.

const BUDGET = 40;
const PAGE = 100;
const MEDUSA_FIELDS = "id,email,has_account,phone,first_name,last_name,company_name,metadata,addresses.*";
export const ADDRESS_NAME = "Business Central";

export async function runCustomerSyncStep(ctx, env) {
  const budget = makeBudget(Number(env.SYNC_STEP_BUDGET) || BUDGET);
  const medusa = medusaClient(env, budget);
  const bc = bcCredentials(env);
  const { state } = ctx;
  const stages = { read, index, match, write };
  while (state.stage !== "done" && budget.left() > 5) {
    const before = `${state.stage}:${state.cursor}`;
    await stages[state.stage]({ ctx, budget, medusa, bc });
    // A stage that stopped without moving is waiting for a fresh budget.
    if (`${state.stage}:${state.cursor}` === before) break;
  }
  return state.stage === "done";
}

const next = (state, stage) => {
  state.stage = stage;
  state.cursor = 0;
};

// ---- read: every BC customer, mapped ----

async function read({ ctx, bc, budget }) {
  const { state, summary, settings } = ctx;
  if (!settings.company_id) throw new Error("Choose a Business Central company in Settings first.");
  const customers = await listBcCustomers(bc, settings.company_id, { budget });
  Object.assign(summary, { bc_customers: customers.length, created: 0, updated: 0, unchanged: 0, failed: 0, email_left_out: 0, issues: 0 });
  const rows = [];
  for (const customer of customers) {
    if (!customer.number) continue;
    const { body, address, issues } = mapCustomer(customer);
    issues.forEach((issue) => ctx.note(issue));
    rows.push({ key: customer.number, payload: { body, address, name: customer.displayName || customer.number } });
  }
  ctx.putWork("customer", rows);
  next(state, "index");
}

// ---- index: Medusa's customers, page by page (by id: created_at ties reorder) ----

async function index({ ctx, medusa, budget }) {
  const { state } = ctx;
  while (budget.left() > 3) {
    const { customers } = await medusa.get("/admin/customers", { fields: MEDUSA_FIELDS, order: "id", limit: PAGE, offset: state.cursor });
    // Only the sync's own customers need their full copy; the rest matter for their email.
    ctx.putWork(
      "medusa",
      customers.map((c) => ({
        key: c.id,
        payload: c.metadata?.bc_customer_number
          ? { ...c, addresses: (c.addresses ?? []).filter((a) => a.address_name === ADDRESS_NAME) }
          : { id: c.id, email: c.email, has_account: c.has_account },
      })),
      state.cursor,
    );
    state.cursor += customers.length;
    if (customers.length < PAGE) return next(state, "match");
  }
}

// ---- match: each BC customer to its Medusa customer, and settle emails ----

async function match({ ctx }) {
  const { state, summary } = ctx;
  const medusa = ctx.work("medusa").map((row) => row.payload);
  const byNumber = new Map(medusa.filter((c) => c.metadata?.bc_customer_number).map((c) => [c.metadata.bc_customer_number, c]));
  // Admin-created customers are guests; Medusa keeps guest emails unique.
  const guestEmail = new Map(medusa.filter((c) => c.email && !c.has_account).map((c) => [c.email.toLowerCase(), c]));
  const claimed = new Map();
  for (const row of ctx.work("customer")) {
    const { body } = row.payload;
    const current = byNumber.get(row.key) ?? null;
    const email = body.email;
    if (email) {
      const holder = guestEmail.get(email);
      const reason = claimed.has(email)
        ? `BC customer ${claimed.get(email)} has the same email`
        : holder && holder.id !== current?.id
          ? holder.metadata?.bc_customer_number
            ? `Medusa customer of BC customer ${holder.metadata.bc_customer_number} already has it`
            : `Medusa customer ${holder.id} (not from BC) already has it`
          : null;
      if (reason) {
        delete body.email;
        summary.email_left_out++;
        ctx.note({ kind: "email", ref: row.key, message: `Email ${email} left out: ${reason}. Fix it in BC or Medusa, then run again.` });
      } else claimed.set(email, row.key);
    }
    ctx.setResult("customer", row.seq, { body, current });
  }
  next(state, "write");
}

// ---- write: create or update, two calls at most per customer ----

async function write({ ctx, medusa, budget }) {
  const { state, summary } = ctx;
  while (budget.left() > 3) {
    const [row] = ctx.work("customer", state.cursor, 1);
    if (!row) return next(state, "done");
    const { body, current } = row.result;
    const { address } = row.payload;
    try {
      let id = current?.id;
      let wrote = false;
      if (!current) {
        id = (await medusa.post("/admin/customers", body)).customer.id;
        summary.created++;
        wrote = true;
      } else if (customerChanged(body, current)) {
        await medusa.post(`/admin/customers/${id}`, customerUpdate(body, current));
        wrote = true;
      }
      const existing = current?.addresses?.[0];
      if (address && !existing) {
        await medusa.post(`/admin/customers/${id}/addresses`, address);
        wrote = true;
      } else if (address && addressChanged(address, existing)) {
        await medusa.post(`/admin/customers/${id}/addresses/${existing.id}`, addressUpdate(address));
        wrote = true;
      }
      if (current) summary[wrote ? "updated" : "unchanged"]++;
    } catch (error) {
      summary.failed++;
      ctx.note({ kind: "customer", ref: row.key, message: `${row.payload.name}: ${error?.message || error}` });
    }
    state.cursor = row.seq + 1;
  }
}
