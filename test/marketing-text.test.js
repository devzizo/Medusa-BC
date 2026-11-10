import { describe, it } from "node:test";
import { expect } from "./expect.js";
import { plainText, textHash } from "../src/lib/text.js";
import { mapItems } from "../src/lib/map.js";
import { descriptionUpdate } from "../src/sync/items.js";

describe("plainText", () => {
  it("turns rich text into plain lines", () => {
    expect(plainText("<p>مرتبة <b>فاخرة</b></p><p>بنوابض منفصلة</p>")).toEqual("مرتبة فاخرة\nبنوابض منفصلة");
    expect(plainText("سطر<br/>سطر ثانٍ")).toEqual("سطر\nسطر ثانٍ");
    expect(plainText("<ul><li>الطبقة الأولى</li><li>الطبقة الثانية</li></ul>")).toEqual("• الطبقة الأولى\n• الطبقة الثانية");
  });

  it("decodes the entities a rich-text box writes, and collapses the spaces", () => {
    expect(plainText("A&nbsp;&amp;&nbsp;B   C")).toEqual("A & B C");
    expect(plainText("a &lt; b &unknown; c")).toEqual("a < b &unknown; c");
  });

  it("is empty for nothing, and plain text stays as it is", () => {
    for (const value of [undefined, null, "", "  ", 5, "<p> </p>"]) expect(plainText(value)).toEqual("");
    expect(plainText("وصف عادي")).toEqual("وصف عادي");
  });
});

describe("textHash", () => {
  it("tells one text from another and is stable", () => {
    expect(textHash("نص")).toEqual(textHash("نص"));
    expect(textHash("نص") === textHash("نص ثانٍ")).toEqual(false);
  });
});

describe("mapItems: Marketing Text", () => {
  const item = { id: "1", number: "IT1", displayName: "مرتبة", unitPrice: 100 };

  it("carries the item's Marketing Text as the product's description, with its fingerprint", () => {
    const [product] = mapItems([{ ...item, marketingText: "<p>وصف المرتبة</p>" }], [], "sar").products;
    expect(product.description).toEqual("وصف المرتبة");
    expect(product.metadata.bc_description_hash).toEqual(textHash("وصف المرتبة"));
  });

  it("has no description when BC returns none (the field may not exist), and says nothing else", () => {
    for (const marketingText of [undefined, "", "<p> </p>"]) {
      const [product] = mapItems([{ ...item, marketingText }], [], "sar").products;
      expect("description" in product).toEqual(false);
      expect("bc_description_hash" in product.metadata).toEqual(false);
    }
  });
});

describe("descriptionUpdate", () => {
  const text = "وصف من BC";
  const product = { description: text, metadata: { bc_item_number: "IT1", bc_description_hash: textHash(text) } };

  it("writes the description where Medusa has none", () => {
    for (const current of [{ description: null, metadata: {} }, { description: "", metadata: null }, { metadata: {} }]) {
      const result = descriptionUpdate(product, current);
      expect(result.description).toEqual(text);
      expect(result.metadata).toEqual({ bc_item_number: "IT1", bc_description_hash: textHash(text) });
    }
  });

  it("brings a change made in BC, while the description is still the one the sync wrote", () => {
    const next = { description: "وصف جديد", metadata: { bc_item_number: "IT1", bc_description_hash: textHash("وصف جديد") } };
    const current = { description: text, metadata: { bc_description_hash: textHash(text) } };
    expect(descriptionUpdate(next, current).description).toEqual("وصف جديد");
  });

  it("keeps the team's own text, and keeps the old fingerprint", () => {
    const edited = { description: "كتبه الفريق", metadata: { bc_description_hash: textHash(text) } };
    const result = descriptionUpdate(product, edited);
    expect(result.kept).toEqual(true);
    expect("description" in result).toEqual(false);
    expect("bc_description_hash" in result.metadata).toEqual(false);
    // A description with no fingerprint at all was typed in Medusa, so it is the team's as well
    expect(descriptionUpdate(product, { description: "كتبه الفريق", metadata: {} }).kept).toEqual(true);
  });

  it("never clears a description when BC has no text", () => {
    const result = descriptionUpdate({ metadata: { bc_item_number: "IT1" } }, { description: "كتبه الفريق", metadata: {} });
    expect(result).toEqual({ metadata: { bc_item_number: "IT1" } });
  });
});
