import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { pictureVisibility } from "../src/sync/images.js";

// The owner's rule (2026-11-17): a product with no picture at all is not shown.
describe("pictureVisibility", () => {
  it("drafts and marks a published product that has no picture anywhere", () => {
    expect(pictureVisibility({ hide: true, hasImage: false, status: "published", flagged: false })).toEqual({ status: "draft", flag: true });
  });

  it("leaves a draft with no picture alone (blocked in BC, or already hidden)", () => {
    expect(pictureVisibility({ hide: true, hasImage: false, status: "draft", flagged: false })).toEqual({});
    expect(pictureVisibility({ hide: true, hasImage: false, status: "draft", flagged: true })).toEqual({});
  });

  it("does nothing for a product with a picture, but lifts a mark it carries (the item sync then publishes it)", () => {
    expect(pictureVisibility({ hide: true, hasImage: true, status: "published", flagged: false })).toEqual({});
    expect(pictureVisibility({ hide: true, hasImage: true, status: "draft", flagged: true })).toEqual({ flag: false });
  });

  it("with the rule off nothing is hidden and every mark is lifted", () => {
    expect(pictureVisibility({ hide: false, hasImage: false, status: "published", flagged: false })).toEqual({});
    expect(pictureVisibility({ hide: false, hasImage: false, status: "draft", flagged: true })).toEqual({ flag: false });
  });
});
