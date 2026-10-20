/**
 * Strict JSON decoding for 2xx bodies.
 *
 * JavaScript has one number type, so `JSON.parse("1.0")` and `JSON.parse("1")` give the same value. The OpenAPI
 * schema only has integers, and the other SDKs reject `1.0` where an integer is required (Python: a float is not an
 * int). To behave the same, numbers written with a fraction or an exponent are remembered: the object or array that
 * holds such a number gets a hidden (non-enumerable) {@link FLOAT_KEYS} set with the key, which the schema readers
 * check. Values are unchanged (`1.0` is still the number 1), so extra fields stay usable in `raw`.
 *
 * Bodies without any such number (the normal case) are decoded by `JSON.parse` alone.
 */

/** Hidden marker: keys of a parsed object/array whose number literal had a fraction or an exponent. */
export const FLOAT_KEYS: unique symbol = Symbol("tmailor.floatKeys");

const TOKENS = /"(?:[^"\\]|\\[\s\S])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function isFloatLiteral(tok: string): boolean {
  return tok.charCodeAt(0) !== 34 /* " */ && /[.eE]/.test(tok);
}

/** `JSON.parse` that also records number literals with a fraction or an exponent (see module doc). Throws on bad JSON. */
export function parseStrictJson(text: string): unknown {
  TOKENS.lastIndex = 0;
  let found = false;
  for (let m = TOKENS.exec(text); m !== null; m = TOKENS.exec(text)) {
    if (isFloatLiteral(m[0])) {
      found = true;
      break;
    }
  }
  if (!found) return JSON.parse(text);

  // Slow path: swap every non-integer literal for a unique string marker, parse, then turn the markers back into
  // numbers while recording where they were.
  const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const prefix = `\u0000tmailor-num-${nonce}:`;
  const literals: string[] = [];
  const replaced = text.replace(TOKENS, (tok) => {
    if (!isFloatLiteral(tok)) return tok;
    literals.push(tok);
    return JSON.stringify(prefix + String(literals.length - 1));
  });
  return JSON.parse(replaced, function (this: unknown, key: string, value: unknown): unknown {
    if (typeof value === "string" && value.startsWith(prefix)) {
      const lit = literals[Number(value.slice(prefix.length))];
      if (lit !== undefined && this !== null && typeof this === "object") {
        markFloat(this as object, key);
        return Number(lit);
      }
    }
    return value;
  });
}

function markFloat(holder: object, key: string): void {
  let set = (holder as { [FLOAT_KEYS]?: Set<string> })[FLOAT_KEYS];
  if (!set) {
    set = new Set<string>();
    Object.defineProperty(holder, FLOAT_KEYS, { value: set, enumerable: false });
  }
  set.add(key);
}

/** True when `holder[key]` was written as a number with a fraction or an exponent. */
export function isFloatKey(holder: object, key: string): boolean {
  const set = (holder as { [FLOAT_KEYS]?: Set<string> })[FLOAT_KEYS];
  return set !== undefined && set.has(key);
}
