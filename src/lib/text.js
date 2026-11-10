// Text from Business Central as the store shows it.

const ENTITIES = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };

/**
 * The plain text of a BC text field. Marketing Text is edited in a rich-text box, so it may arrive as HTML: the
 * storefront and Medusa's admin show a description as plain text, so tags would print as they are. Paragraphs and
 * breaks become lines, list items become "• " lines, every other tag goes. Returns "" for nothing.
 */
export const plainText = (value) => {
  if (typeof value !== "string") return "";
  return value
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n• ")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#?\w+);/g, (match, name) => ENTITIES[name.toLowerCase()] ?? match)
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
};

/**
 * A short fingerprint of a text (FNV-1a, 32 bits), to tell later whether a description is still the one the sync wrote
 * or the team has changed it. Not for security.
 */
export const textHash = (value) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};
