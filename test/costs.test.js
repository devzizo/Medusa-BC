import { describe, it } from "node:test";
import http from "node:http";
import { expect } from "./expect.js";
import { mapItems } from "../src/lib/map.js";
import { costs, costItems } from "../src/sync/items.js";
import { makeBudget, medusaClient } from "../src/lib/medusa.js";

const item = (overrides = {}) => ({ id: "i-1", number: "1000", displayName: "Pillow", unitPrice: 100, unitCost: 41.126, ...overrides });

// A real local server standing in for Medusa, recording what the sync sends.
const serve = (handler) =>
  new Promise((resolve) => {
    const calls = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        calls.push({ method: req.method, url: req.url, body: body ? JSON.parse(body) : undefined });
        const [status, json] = handler(req, calls[calls.length - 1]);
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ calls, url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() }));
  });

const context = (rows) => {
  const notes = [];
  return {
    notes,
    state: { stage: "costs", cursor: 0 },
    summary: {},
    note: (n) => notes.push(n),
    work: (kind, from = 0, limit = 1e6) => rows.filter((row) => row.seq >= from).slice(0, limit),
  };
};
const row = (seq, handle, unit_cost, status = "updated") => ({ seq, key: handle, payload: { handle, unit_cost }, result: { status } });
const clientFor = (url) => medusaClient({ MEDUSA_BACKEND_URL: url, MEDUSA_ADMIN_API_KEY: "k" }, makeBudget(40));

describe("unit cost in the item mapping", () => {
  it("is a product field (rounded), and never in metadata or on variants", () => {
    const { products } = mapItems([item()], [], "sar");
    expect(products[0].unit_cost).toEqual(41.13);
    expect(JSON.stringify(products[0].metadata).includes("41.1")).toBe(false);
    expect(JSON.stringify(products[0].variants).includes("41.1")).toBe(false);
  });
  it("is left out when BC has none or zero", () => {
    expect(mapItems([item({ unitCost: 0 })], [], "sar").products[0].unit_cost).toEqual(undefined);
    expect(mapItems([item({ unitCost: undefined })], [], "sar").products[0].unit_cost).toEqual(undefined);
  });
});

describe("costItems", () => {
  it("keeps only synced products with a cost", () => {
    expect(costItems([row(0, "bc-1", 10), row(1, "bc-2", undefined), row(2, "bc-3", 5, "skipped"), row(3, "bc-4", 7, "created")])).toEqual([
      { product_handle: "bc-1", cost: 10 },
      { product_handle: "bc-4", cost: 7 },
    ]);
  });
});

describe("costs stage against a real HTTP server", () => {
  it("posts the batch to /admin/product-costs and moves on when the work is done", async () => {
    const server = await serve(() => [200, { created: 1, updated: 1, unknown_handles: ["bc-9"] }]);
    try {
      const ctx = context([row(0, "bc-1", 10), row(1, "bc-9", 20)]);
      await costs({ ctx, medusa: clientFor(server.url), budget: makeBudget(40) });
      expect(server.calls.length).toEqual(1);
      expect(server.calls[0].method).toEqual("POST");
      expect(server.calls[0].url).toEqual("/admin/product-costs");
      expect(server.calls[0].body).toEqual({ items: [{ product_handle: "bc-1", cost: 10 }, { product_handle: "bc-9", cost: 20 }] });
      expect(ctx.summary.costs_written).toEqual(2);
      expect(ctx.notes.map((n) => n.ref)).toEqual(["bc-9"]);
      expect(ctx.state.cursor).toEqual(2);
      await costs({ ctx, medusa: clientFor(server.url), budget: makeBudget(40) });
      expect(ctx.state.stage).toEqual("priceListsRead");
      expect(server.calls.length).toEqual(1);
    } finally {
      server.close();
    }
  });

  it("a Medusa without the endpoint is noted once and the sync carries on", async () => {
    const server = await serve(() => [404, { message: "Not found" }]);
    try {
      const ctx = context([row(0, "bc-1", 10)]);
      await costs({ ctx, medusa: clientFor(server.url), budget: makeBudget(40) });
      expect(ctx.state.stage).toEqual("priceListsRead");
      expect(ctx.notes.length).toEqual(1);
      expect(ctx.notes[0].message.startsWith("Costs not written")).toBe(true);
    } finally {
      server.close();
    }
  });
});
