import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { CATEGORY_PLACEMENT, placementParents, placementPatch } from "../src/lib/category-placement.js";
import { categoryHandle } from "../src/lib/map.js";

describe("placementParents", () => {
  it("lists each parent once, for the categories that have a placement", () => {
    expect(placementParents(["bc-cat-eba6e762", "bc-cat-c69faabd", "bc-cat-unknown", "bc-cat-46862080"])).toEqual(["بطانيات"]);
  });
});

describe("placementPatch", () => {
  const parent = { id: "cat_parent", handle: "luxury-mattresses" };

  it("does nothing for a category without a placement", () => {
    expect(placementPatch("bc-cat-79cc29ad", { id: "c", parent_category_id: null, is_active: true }, undefined)).toEqual({ patch: null });
  });

  it("nests a category under its parent", () => {
    const result = placementPatch("bc-cat-66a0ef4f", { id: "c", parent_category_id: null, is_active: true }, parent);
    expect(result.patch).toEqual({ parent_category_id: "cat_parent" });
  });

  it("is idempotent: a second run changes nothing", () => {
    const result = placementPatch("bc-cat-66a0ef4f", { id: "c", parent_category_id: "cat_parent", is_active: true }, parent);
    expect(result.patch).toEqual(null);
  });

  it("reports a missing parent instead of guessing", () => {
    const result = placementPatch("bc-cat-66a0ef4f", { id: "c", parent_category_id: null, is_active: true }, undefined);
    expect(result).toEqual({ patch: null, missingParent: "luxury-mattresses" });
  });

  it("hides a cancelled category once", () => {
    expect(placementPatch("bc-cat-46862080", { id: "c", is_active: true }, undefined).patch).toEqual({ is_active: false });
    expect(placementPatch("bc-cat-46862080", { id: "c", is_active: false }, undefined).patch).toEqual(null);
  });
});

describe("CATEGORY_PLACEMENT", () => {
  it("names only handles the sync produces for BC codes, and a parent that is not a BC category", () => {
    for (const [handle, placement] of Object.entries(CATEGORY_PLACEMENT)) {
      expect(handle.startsWith("bc-cat-")).toEqual(true);
      if (placement.parent) expect(placement.parent.startsWith("bc-cat-")).toEqual(false);
    }
  });

  it("keys the owner's 2026-10-31 changes by the handles their BC codes produce", () => {
    expect(categoryHandle("دعاسات")).toEqual("bc-cat-862c202f");
    expect(categoryHandle("الغسيل")).toEqual("bc-cat-17f74fb6");
    expect(categoryHandle("نظافة")).toEqual("bc-cat-1e57052a");
    expect(categoryHandle("أرواب")).toEqual("bc-cat-a0aaa2b5");
    for (const handle of ["bc-cat-862c202f", "bc-cat-17f74fb6", "bc-cat-1e57052a"]) expect(CATEGORY_PLACEMENT[handle]).toEqual({ active: false });
    expect(CATEGORY_PLACEMENT["bc-cat-a0aaa2b5"]).toEqual({ parent: "robes-and-towels" });
  });

  it("keeps the handle scheme the placements are keyed by", () => {
    expect(categoryHandle("PILLOWS")).toEqual("bc-cat-pillows");
  });
});
