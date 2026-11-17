// The «رفع الصور» tab (the owner, 2026-11-17: customer service puts an item's picture into Business Central from the
// middleware's page, and the picture sync carries it to the store). Pure checks, no I/O: unit-tested on their own
// (test/pictures.test.js).

// What the page sends: a JPEG or PNG the browser has already resized (index.html), as a data URL in the JSON body.
export const MAX_PICTURE_BYTES = 3 * 1024 * 1024;
const TYPES = { "image/jpeg": [0xff, 0xd8, 0xff], "image/png": [0x89, 0x50, 0x4e, 0x47] };

/**
 * The picture's bytes and type from a data URL, or { error } in Arabic for the page. The type is believed only when
 * the bytes start the way that type's files do, so nothing but a real JPEG or PNG reaches Business Central.
 */
export const decodePicture = (dataUrl) => {
  if (typeof dataUrl !== "string") return { error: "لم تصل صورة." };
  const match = dataUrl.match(/^data:(image\/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) return { error: "الصورة يجب أن تكون JPG أو PNG." };
  const [, type, base64] = match;
  if (base64.length > Math.ceil((MAX_PICTURE_BYTES * 4) / 3) + 4) return { error: "الصورة أكبر من 3 ميغابايت." };
  let bytes;
  try {
    bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  } catch {
    return { error: "تعذّرت قراءة الصورة." };
  }
  if (bytes.length < 64) return { error: "الصورة فارغة أو تالفة." };
  if (bytes.length > MAX_PICTURE_BYTES) return { error: "الصورة أكبر من 3 ميغابايت." };
  const magic = TYPES[type];
  if (!magic.every((b, i) => bytes[i] === b)) return { error: "محتوى الملف لا يطابق نوع الصورة." };
  return { bytes, contentType: type };
};

/**
 * The OData filters for the search box: one for the item number, one for the name (BC refuses an 'or' across two
 * different fields: «The 'OR' operator is not supported on distinct fields», so they are two queries whose answers are
 * merged). Quotes are doubled (OData's own escape), so what is typed is always text inside a filter, never part of it.
 * Two to forty characters.
 */
export const itemSearchFilters = (query) => {
  const q = typeof query === "string" ? query.trim() : "";
  if (q.length < 2 || q.length > 40) return null;
  const text = q.replace(/'/g, "''");
  return [`contains(number,'${text}')`, `contains(displayName,'${text}')`];
};

/** A BC item as the tab lists it. */
export const listedItem = (item) => ({
  id: item.id,
  number: item.number ?? "",
  name: item.displayName ?? "",
  blocked: item.blocked === true,
});
