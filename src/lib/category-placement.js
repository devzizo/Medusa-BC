// Where each BC category sits in the store's category tree, decided by the team
// (docs/category-mapping.md in devzizo/essentials-starter, from the owner's
// reviewed sheet of 2026-10-31). Keyed by the handle the sync gives the
// category (bc-cat-<slug>), so an entry names exactly one category.
//
//   parent: the handle of an existing store category to nest it under.
//   active: false hides the category from the storefront (products stay).
//
// A category without an entry is left where Medusa has it: undecided ones
// (accessories, rugs, supplies...) stay as they are on purpose, because
// hiding accessories would hide half the published products.

export const CATEGORY_PLACEMENT = {
  // الضروريات
  "bc-cat-9b8f8517": { parent: "c1069658806" }, // بيت لحاف
  "bc-cat-59f8729c": { parent: "c1069658806" }, // حشوات
  // المعطرات
  "bc-cat-7701477e": { parent: "home-fragrances" }, // معطرات
  // مراتب فاخرة
  "bc-cat-66a0ef4f": { parent: "luxury-mattresses" }, // مراتب
  "bc-cat-46862080": { active: false }, // مرتبة: cancelled by the owner (a duplicate of مراتب)
  // عازل مراتب و شراشف مغاط
  "bc-cat-99d4cd83": { parent: "mattress-protector" }, // شراشف
  "bc-cat-f06a5d29": { parent: "mattress-protector" }, // واقي مرتبة
  // مخدات فندقية
  "bc-cat-2170ece4": { parent: "مخدات" }, // مخدات
  "bc-cat-03aa5245": { parent: "مخدات" }, // بيت مخدة
  // لباد سرير
  "bc-cat-a62810bc": { parent: "لباد" }, // لباد فندقي: a duplicate of لباد سرير, nested until the products move
  // بطانيات
  "bc-cat-eba6e762": { parent: "بطانيات" }, // بطانية خفيفة
  "bc-cat-c69faabd": { parent: "بطانيات" }, // بطانية كرتون
  // الارواب & المناشف (the owner, 2026-10-31: the robes go back under it)
  "bc-cat-a0aaa2b5": { parent: "robes-and-towels" }, // أرواب
  "bc-cat-eec56857": { parent: "towels" }, // مناشف
  // المفارش
  "bc-cat-6d10286e": { parent: "مفارش" }, // مفارش عرائس
  "bc-cat-31ae4458": { parent: "مفارش" }, // مفارش فندقية نفرونص
  "bc-cat-41508a7d": { parent: "مفارش" }, // مفارش فندقية نفرين
  "bc-cat-8fe79f40": { parent: "مفارش" }, // مفارش مضغوطة نفرين
  "bc-cat-c705ac0a": { parent: "مفارش" }, // مفارش مضغوطه نفرونص
  "bc-cat-b1dcaeee": { parent: "summer-bed-sheets" }, // مفارش صيفي نفرونص
  "bc-cat-0a7b58b0": { parent: "summer-bed-sheets" }, // مفارش صيفي نفرين
  "bc-cat-890a7f22": { parent: "winter-bed-sheets-one-and-half" }, // مفارش شتوية نفرونص
  "bc-cat-0c2ffd83": { parent: "winter-bed-sheets-two-person" }, // مفارش شتوية نفرين
  // The perfume sub-category of accessories is cancelled by the owner.
  "bc-cat-perfume-3c34e589": { active: false },
  // Hidden by the owner (2026-10-31), so the header menu stays light; products stay.
  "bc-cat-862c202f": { active: false }, // دعاسات
  "bc-cat-17f74fb6": { active: false }, // الغسيل
  "bc-cat-1e57052a": { active: false }, // نظافة
};

/** The handles of the parents the placements name, for one lookup. */
export const placementParents = (handles) => [
  ...new Set(handles.map((handle) => CATEGORY_PLACEMENT[handle]?.parent).filter(Boolean)),
];

/**
 * The update a category needs to match its placement, or null when it already
 * does (or has no placement). `parent` is the parent's store category, or
 * undefined when the parent does not exist: then the nesting is skipped and
 * `missingParent` says so, so the run can report it instead of guessing.
 */
export const placementPatch = (handle, current, parent) => {
  const placement = CATEGORY_PLACEMENT[handle];
  if (!placement) return { patch: null };
  const patch = {};
  let missingParent = null;
  if (placement.parent) {
    if (!parent) missingParent = placement.parent;
    else if (current.parent_category_id !== parent.id) patch.parent_category_id = parent.id;
  }
  if (placement.active === false && current.is_active !== false) patch.is_active = false;
  return { patch: Object.keys(patch).length ? patch : null, missingParent };
};
