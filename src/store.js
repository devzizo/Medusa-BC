import { DurableObject } from "cloudflare:workers";
import { runCustomerSyncStep } from "./sync/customers.js";
import { runImageSyncStep } from "./sync/images.js";
import { runInventorySyncStep } from "./sync/inventory.js";
import { runCategorySyncStep, runItemSyncStep } from "./sync/items.js";

const STEPS = { items: runItemSyncStep, categories: runCategorySyncStep, inventory: runInventorySyncStep, customers: runCustomerSyncStep, images: runImageSyncStep };

// All of the middleware's own state, in one Durable Object with SQLite:
// settings chosen in the page (company, posting groups), the location and
// payment method mappings, and the sync runs (items, inventory) with their
// work queue. Only one run of either kind goes at a time.
// One instance (named "main") serves everything, so reads are consistent.

// Enough for every duplicate barcode and drafted product of a real catalog.
const MAX_ISSUES = 2000;
// A run older than this is taken as dead rather than left blocking the next.
const STALE_AFTER_MS = 2 * 60 * 60 * 1000;
// Pause between sync steps; each step stays inside one invocation's budget.
const STEP_DELAY_MS = 50;

export const SETTING_KEYS = [
  "company_id",
  "company_name",
  "company_display_name",
  "vat_bus_posting_group",
  "gen_bus_posting_group",
  "price_list_service",
  "price_list_line_service",
  "inventory_service",
  "shipping_agent_service",
  // Order posting (Orders tab): default BC customer, shipping line, default location, BC's local currency.
  "order_customer_number",
  "order_shipping_type",
  "order_shipping_number",
  "order_location_code",
  "order_local_currency",
  // BC price lists to import: "" = every active sales list, else a JSON array of codes.
  "price_lists",
  // Item sync options, "0" = off (unset = on).
  "skip_blocked",
  "draft_zero_inventory",
  "publish_synced",
];

const MAPPINGS = {
  locations: { table: "location_map", key: "stock_location_id", code: "bc_location_code", name: "bc_location_name" },
  shipping: { table: "shipping_map", key: "shipping_option_id", code: "bc_shipping_agent_code", name: "bc_shipping_agent_name" },
  payments: { table: "payment_map", key: "payment_provider_id", code: "bc_payment_method_code", name: "bc_payment_method_name" },
};

export class MiddlewareStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS setting (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS location_map (stock_location_id TEXT PRIMARY KEY, bc_company_id TEXT NOT NULL,
        bc_location_code TEXT NOT NULL, bc_location_name TEXT);
      CREATE TABLE IF NOT EXISTS shipping_map (shipping_option_id TEXT PRIMARY KEY, bc_company_id TEXT NOT NULL,
        bc_shipping_agent_code TEXT NOT NULL, bc_shipping_agent_name TEXT);
      CREATE TABLE IF NOT EXISTS payment_map (payment_provider_id TEXT PRIMARY KEY, bc_company_id TEXT NOT NULL,
        bc_payment_method_code TEXT NOT NULL, bc_payment_method_name TEXT);
      CREATE TABLE IF NOT EXISTS run (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, state TEXT NOT NULL, summary TEXT NOT NULL,
        issues TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS order_sync (order_id TEXT PRIMARY KEY, display_id INTEGER, status TEXT NOT NULL,
        bc_order_id TEXT, bc_order_number TEXT, bc_total REAL, medusa_total REAL, at TEXT NOT NULL, error TEXT);
      CREATE TABLE IF NOT EXISTS work (run_id TEXT NOT NULL, kind TEXT NOT NULL, seq INTEGER NOT NULL,
        key TEXT NOT NULL, payload TEXT NOT NULL, result TEXT, PRIMARY KEY (run_id, kind, seq));
    `);
  }

  rows(query, ...bindings) {
    return this.sql.exec(query, ...bindings).toArray();
  }

  // ---- Settings ----

  getSettings() {
    const stored = Object.fromEntries(this.rows("SELECT key, value FROM setting").map((row) => [row.key, row.value]));
    return Object.fromEntries(SETTING_KEYS.map((key) => [key, stored[key] ?? ""]));
  }

  saveSettings(patch) {
    for (const key of SETTING_KEYS) {
      if (patch[key] === undefined) continue;
      this.sql.exec("INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, String(patch[key]).trim());
    }
    return this.getSettings();
  }

  /** A different company drops both mappings: they name the old company's codes. */
  selectCompany(company) {
    const previous = this.getSettings().company_id;
    this.ctx.storage.transactionSync(() => {
      if (previous !== company.id) {
        this.sql.exec("DELETE FROM location_map");
        this.sql.exec("DELETE FROM payment_map");
        this.sql.exec("DELETE FROM shipping_map");
      }
      this.saveSettings({ company_id: company.id, company_name: company.name, company_display_name: company.displayName });
    });
    return { settings: this.getSettings(), cleared: previous !== company.id && Boolean(previous) };
  }

  // ---- Mappings ----

  getMappings(kind, companyId) {
    const m = MAPPINGS[kind];
    return this.rows(`SELECT ${m.key} AS id, ${m.code} AS code, ${m.name} AS name FROM ${m.table} WHERE bc_company_id = ?`, companyId);
  }

  /** rows: [{ id, code, name }]; a null code unmaps that id. */
  saveMappings(kind, companyId, rows) {
    const m = MAPPINGS[kind];
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        this.sql.exec(`DELETE FROM ${m.table} WHERE ${m.key} = ?`, row.id);
        if (row.code) {
          this.sql.exec(`INSERT INTO ${m.table} (${m.key}, bc_company_id, ${m.code}, ${m.name}) VALUES (?, ?, ?, ?)`, row.id, companyId, row.code, row.name ?? null);
        }
      }
    });
    return this.getMappings(kind, companyId);
  }

  // ---- Orders posted to BC (one row per Medusa order, by hand) ----

  orderRecords(ids) {
    if (!ids.length) return [];
    return this.rows(`SELECT * FROM order_sync WHERE order_id IN (${ids.map(() => "?").join(",")})`, ...ids);
  }

  /**
   * Claims an order for posting. Refused when it is already in BC, or being
   * posted right now (a click older than 5 minutes is taken as dead).
   */
  claimOrder(orderId, displayId) {
    const current = this.rows("SELECT * FROM order_sync WHERE order_id = ?", orderId)[0];
    if (current?.status === "synced") return { error: `Already in BC as ${current.bc_order_number}.` };
    if (current?.status === "syncing" && Date.now() - Date.parse(current.at) < 5 * 60 * 1000) return { error: "This order is being posted right now." };
    this.sql.exec(
      "INSERT INTO order_sync (order_id, display_id, status, at) VALUES (?, ?, 'syncing', ?) ON CONFLICT(order_id) DO UPDATE SET status = 'syncing', at = excluded.at, error = NULL",
      orderId,
      displayId,
      new Date().toISOString(),
    );
    return { ok: true };
  }

  finishOrder(orderId, result) {
    this.sql.exec(
      "UPDATE order_sync SET status = ?, bc_order_id = ?, bc_order_number = ?, bc_total = ?, medusa_total = ?, at = ?, error = ? WHERE order_id = ?",
      result.status,
      result.bc_order_id ?? null,
      result.bc_order_number ?? null,
      result.bc_total ?? null,
      result.medusa_total ?? null,
      new Date().toISOString(),
      result.error ?? null,
      orderId,
    );
    return this.rows("SELECT * FROM order_sync WHERE order_id = ?", orderId)[0];
  }

  // ---- Runs ----

  view(row) {
    return {
      id: row.id,
      kind: row.kind,
      status: row.status,
      started_at: row.started_at,
      finished_at: row.finished_at,
      stage: JSON.parse(row.state).stage,
      summary: JSON.parse(row.summary),
      issues: JSON.parse(row.issues),
      error: row.error,
      // Each sync kind counts its runs: 1 for the first ever.
      number: row.number,
    };
  }

  listRuns(kind) {
    const total = this.rows("SELECT COUNT(*) AS n FROM run WHERE kind = ?", kind)[0].n;
    return {
      total,
      runs: this.rows(
        "SELECT run.*, (SELECT COUNT(*) FROM run r2 WHERE r2.kind = run.kind AND r2.started_at <= run.started_at) AS number FROM run WHERE kind = ? ORDER BY started_at DESC LIMIT 10",
        kind,
      ).map((row) => this.view(row)),
    };
  }

  /** Starts a run unless one is going; the alarm then drives it step by step. */
  async startRun(kind) {
    const live = this.rows("SELECT id, started_at FROM run WHERE status = 'running'");
    for (const run of live) {
      if (Date.now() - Date.parse(run.started_at) < STALE_AFTER_MS) {
        return { error: "A sync is already running." };
      }
      this.finish(run.id, "failed", "Stopped: it ran for over 2 hours without finishing.");
    }
    const id = crypto.randomUUID();
    this.sql.exec(
      "INSERT INTO run (id, kind, status, started_at, state, summary, issues) VALUES (?, ?, 'running', ?, ?, '{}', '[]')",
      id,
      kind,
      new Date().toISOString(),
      JSON.stringify({ stage: "read", cursor: 0 }),
    );
    // Old runs' work rows are not needed once a new run starts.
    this.sql.exec("DELETE FROM work WHERE run_id <> ?", id);
    await this.ctx.storage.setAlarm(Date.now());
    return { run: this.view(this.rows("SELECT * FROM run WHERE id = ?", id)[0]) };
  }

  finish(id, status, error = null) {
    const row = this.rows("SELECT state FROM run WHERE id = ?", id)[0];
    const state = row ? JSON.parse(row.state) : {};
    this.sql.exec(
      "UPDATE run SET status = ?, finished_at = ?, error = ?, state = ? WHERE id = ?",
      status,
      new Date().toISOString(),
      error,
      JSON.stringify({ ...state, stage: status === "succeeded" ? "Done" : "Failed" }),
      id,
    );
  }

  // Helpers the sync steps use to keep their state here.
  runContext(id) {
    const row = this.rows("SELECT * FROM run WHERE id = ?", id)[0];
    const state = JSON.parse(row.state);
    const summary = JSON.parse(row.summary);
    const issues = JSON.parse(row.issues);
    const save = () =>
      this.sql.exec("UPDATE run SET state = ?, summary = ?, issues = ? WHERE id = ?", JSON.stringify(state), JSON.stringify(summary), JSON.stringify(issues), id);
    return {
      id,
      state,
      summary,
      note: (issue) => {
        if (issues.length < MAX_ISSUES) issues.push(issue);
        summary.issues = issues.length;
      },
      save,
      settings: this.getSettings(),
      mappings: (kind) => this.getMappings(kind, this.getSettings().company_id),
      // `from` lets a stage append page after page to the same list.
      putWork: (kind, items, from = 0) => {
        items.forEach((item, i) =>
          this.sql.exec("INSERT INTO work (run_id, kind, seq, key, payload) VALUES (?, ?, ?, ?, ?)", id, kind, from + i, item.key, JSON.stringify(item.payload)),
        );
      },
      work: (kind, from = 0, limit = 1000000) =>
        this.rows("SELECT seq, key, payload, result FROM work WHERE run_id = ? AND kind = ? AND seq >= ? ORDER BY seq LIMIT ?", id, kind, from, limit).map(
          (row) => ({ seq: row.seq, key: row.key, payload: JSON.parse(row.payload), result: row.result ? JSON.parse(row.result) : null }),
        ),
      setResult: (kind, seq, result) =>
        this.sql.exec("UPDATE work SET result = ? WHERE run_id = ? AND kind = ? AND seq = ?", JSON.stringify(result), id, kind, seq),
    };
  }

  async alarm() {
    const run = this.rows("SELECT id, kind FROM run WHERE status = 'running' ORDER BY started_at LIMIT 1")[0];
    if (!run) return;
    const context = this.runContext(run.id);
    try {
      const done = await STEPS[run.kind](context, this.env);
      context.save();
      if (done) this.finish(run.id, "succeeded");
      else await this.ctx.storage.setAlarm(Date.now() + STEP_DELAY_MS);
    } catch (error) {
      context.save();
      this.finish(run.id, "failed", error?.message || String(error));
    }
  }
}
