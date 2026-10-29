// The few Jest matchers the ported specs use, on node:assert.
import assert from "node:assert/strict";

class Containing {
  constructor(expected) { this.expected = expected; }
}

// Deep equality where an expect.objectContaining() matches loosely.
const equal = (actual, expected, loose = false) => {
  if (expected instanceof Containing) return equal(actual, expected.expected, true);
  if (expected instanceof Map) {
    return actual instanceof Map && actual.size === expected.size && [...expected].every(([k, v]) => equal(actual.get(k), v));
  }
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((v, i) => equal(actual[i], v));
  }
  if (expected && typeof expected === "object") {
    if (!actual || typeof actual !== "object") return false;
    const keys = Object.keys(expected);
    if (!loose && Object.keys(actual).length !== keys.length) return false;
    return keys.every((key) => equal(actual[key], expected[key], loose));
  }
  return Object.is(actual, expected);
};

const show = (value) => JSON.stringify(value, (_, v) => (v instanceof Map ? [...v] : v instanceof Containing ? v.expected : v));

export const expect = (actual) => ({
  toEqual: (expected) => assert.ok(equal(actual, expected), `${show(actual)}\n  !== ${show(expected)}`),
  toBe: (expected) => assert.strictEqual(actual, expected),
  toMatch: (pattern) => assert.match(actual, pattern),
  toMatchObject: (expected) => assert.ok(equal(actual, expected, true), `${show(actual)}\n  does not match ${show(expected)}`),
});
expect.objectContaining = (expected) => new Containing(expected);
