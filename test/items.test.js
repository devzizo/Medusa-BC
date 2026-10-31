import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { syncedStatus } from "../src/sync/items.js";

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
