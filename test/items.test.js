import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { syncedStatus, unchangedSince } from "../src/sync/items.js";

describe("syncedStatus", () => {
  const ok = { handle: "bc-1000" };
  const blocked = { handle: "bc-1000", draft_reason: "blocked" };
  const empty = { handle: "bc-1000", draft_reason: "zero_inventory" };

  it("publishes every synced item by default, new or existing", () => {
    expect(syncedStatus(ok, null, true)).toEqual("published");
    for (const status of ["draft", "proposed", "rejected", "published"]) {
      expect(syncedStatus(ok, { status }, true)).toEqual("published");
    }
  });

  it("keeps blocked and zero-stock items as drafts, even when publishing", () => {
    expect(syncedStatus(blocked, null, true)).toEqual("draft");
    expect(syncedStatus(empty, { status: "published" }, true)).toEqual("draft");
  });

  it("with publishing off: new items are drafts, rejected ones go back to draft, the rest keep the admin's status", () => {
    expect(syncedStatus(ok, null, false)).toEqual("draft");
    expect(syncedStatus(ok, { status: "rejected" }, false)).toEqual("draft");
    expect(syncedStatus(ok, { status: "published" }, false)).toEqual(undefined);
    expect(syncedStatus(ok, { status: "draft" }, false)).toEqual(undefined);
  });
});

describe("unchangedSince", () => {
  const since = "2026-11-10T08:00:00.000Z";
  const product = (modified, skus = ["1000"]) => ({ metadata: { bc_last_modified: modified }, variants: skus.map((sku) => ({ sku })) });
  const current = { status: "published", variants: [{ sku: "1000" }] };
  it("leaves an item BC did not touch since the last sync", () => {
    expect(unchangedSince(product("2026-11-09T10:00:00Z"), current, since, "published")).toBe(true);
    expect(unchangedSince(product("2026-11-09T10:00:00Z"), current, since, undefined)).toBe(true);
  });
  it("updates an item changed in BC, one with a new variant, one whose status must change, and one with no time", () => {
    expect(unchangedSince(product("2026-11-10T09:00:00Z"), current, since, "published")).toBe(false);
    expect(unchangedSince(product("2026-11-09T10:00:00Z", ["1000", "1000-RED"]), current, since, "published")).toBe(false);
    expect(unchangedSince(product("2026-11-09T10:00:00Z"), current, since, "draft")).toBe(false);
    expect(unchangedSince(product(undefined), current, since, "published")).toBe(false);
  });
  it("writes everything on the first run, with the option off, and for a product Medusa does not have", () => {
    expect(unchangedSince(product("2026-11-09T10:00:00Z"), current, null, "published")).toBe(false);
    expect(unchangedSince(product("2026-11-09T10:00:00Z"), null, since, "published")).toBe(false);
  });
});
