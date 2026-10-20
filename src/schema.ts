/**
 * Strict readers for 2xx response bodies.
 *
 * Every reader checks that a field is present and has exactly the JSON type of the OpenAPI schema. `null` is
 * accepted only where the schema allows it. Nothing is coerced (no `"false"` -> false, no `"12"` -> 12, no `1.0`
 * -> 1). A violation throws {@link SchemaError}, whose message names the field and the expected type, never the
 * value (response bodies carry address tokens). The client turns it into `InvalidResponseError` without the body.
 *
 * @internal
 */

import { isFloatKey } from "./json.js";

export type JsonObject = Record<string, unknown>;

/** Internal: a response body does not match the schema. The message never contains field values. */
export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SchemaError";
  }
}

function has(d: JsonObject, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(d, key);
}

export function obj(v: unknown, path: string): JsonObject {
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new SchemaError(`${path} must be an object`);
  return v as JsonObject;
}

function get(d: JsonObject, key: string, path: string): unknown {
  if (!has(d, key)) throw new SchemaError(`${path}.${key} is missing`);
  return d[key];
}

function isInt(holder: object, key: string, v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && !isFloatKey(holder, key);
}

export function reqObj(d: JsonObject, key: string, path: string): JsonObject {
  return obj(get(d, key, path), `${path}.${key}`);
}

export function reqObjOrNull(d: JsonObject, key: string, path: string): JsonObject | null {
  const v = get(d, key, path);
  return v === null ? null : obj(v, `${path}.${key}`);
}

export function reqStr(d: JsonObject, key: string, path: string): string {
  const v = get(d, key, path);
  if (typeof v !== "string") throw new SchemaError(`${path}.${key} must be a string`);
  return v;
}

export function reqStrOrNull(d: JsonObject, key: string, path: string): string | null {
  const v = get(d, key, path);
  if (v !== null && typeof v !== "string") throw new SchemaError(`${path}.${key} must be a string or null`);
  return v;
}

export function reqInt(d: JsonObject, key: string, path: string): number {
  const v = get(d, key, path);
  if (!isInt(d, key, v)) throw new SchemaError(`${path}.${key} must be an integer`);
  return v;
}

/** Field that may be absent (`null`); when present it must be an integer (not null). */
export function optInt(d: JsonObject, key: string, path: string): number | null {
  if (!has(d, key)) return null;
  return reqInt(d, key, path);
}

export function reqBool(d: JsonObject, key: string, path: string): boolean {
  const v = get(d, key, path);
  if (typeof v !== "boolean") throw new SchemaError(`${path}.${key} must be a boolean`);
  return v;
}

export function reqList(d: JsonObject, key: string, path: string): unknown[] {
  const v = get(d, key, path);
  if (!Array.isArray(v)) throw new SchemaError(`${path}.${key} must be an array`);
  return v;
}

export function reqStrList(d: JsonObject, key: string, path: string): string[] {
  const out = reqList(d, key, path);
  out.forEach((x, i) => {
    if (typeof x !== "string") throw new SchemaError(`${path}.${key}[${i}] must be a string`);
  });
  return [...(out as string[])];
}

/** `next_cursor`: string or null (an empty string is treated as the end). */
export function cursor(d: JsonObject, path: string): string | null {
  const v = reqStrOrNull(d, "next_cursor", path);
  return v ? v : null;
}

export function hasKey(d: JsonObject, key: string): boolean {
  return has(d, key);
}
