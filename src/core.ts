/**
 * Transport-independent rules shared by every call: base URL check, secrets masking, retry policy, error mapping,
 * deadlines. Kept free of I/O so the behaviour matches the other Tmailor SDKs (see conformance/README.md).
 *
 * Times are milliseconds unless the name says seconds. The API itself speaks seconds (`Retry-After`,
 * `X-RateLimit-Reset`, timestamps), which are converted here.
 *
 * @internal
 */

import { randomUUID } from "node:crypto";

import {
  APIError,
  InvalidResponseError,
  MissingKeyError,
  TmailorError,
  WaitTimeoutError,
  errorClass,
} from "./errors.js";
import { parseStrictJson } from "./json.js";
import { SchemaError } from "./schema.js";
import { VERSION } from "./version.js";

export const DEFAULT_BASE_URL = "https://open-api.tmailor.com";
export const TRUSTED_HOST = "open-api.tmailor.com";
export const DEFAULT_TIMEOUT = 30_000;
export const DEFAULT_MAX_RETRIES = 2;
/** A Retry-After longer than this is not waited for automatically (for example DailyCapReached until midnight). */
export const DEFAULT_MAX_RETRY_WAIT = 60_000;
export const BACKOFF_BASE = 500;
export const BACKOFF_MAX = 8_000;
/** HTTP statuses that are retried for SAFE requests only (the request may or may not have been processed). */
export const RETRY_SAFE_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504]);
/** A Retry-After of 0 (or negative, clamped to 0) still waits this long: no busy retry loop. */
export const MIN_RETRY_AFTER = 1_000;

// ── clock

/**
 * Time source of a client. Replace it in tests (fake time); the default uses `performance.now()`, `Date.now()` and
 * `setTimeout`. All values are milliseconds.
 */
export interface Clock {
  /** Monotonic time (only differences are used). */
  now(): number;
  /** Wall-clock time, Unix epoch milliseconds (compared with `X-RateLimit-Reset`). */
  wallNow(): number;
  /** Resolve after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;
  /** Schedule `fn` after `ms` (used for request timeouts). */
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => performance.now(),
  wallNow: () => Date.now(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))),
  setTimeout: (fn, ms) => {
    const t = setTimeout(fn, Math.max(0, ms));
    (t as { unref?: () => void }).unref?.();
    return t;
  },
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

// ── API key

function env(name: string): string | undefined {
  return typeof process !== "undefined" && process.env ? process.env[name] : undefined;
}

/** The key from the option or `TMAILOR_API_KEY`; `null` when there is none (only `health()` works then). */
export function resolveApiKey(apiKey: string | null | undefined): string | null {
  const key = (apiKey !== undefined && apiKey !== null ? apiKey : env("TMAILOR_API_KEY") ?? "").trim();
  return key || null;
}

export function requireKey(key: string | null): string {
  if (!key) {
    throw new MissingKeyError("No API key: pass { apiKey } or set the TMAILOR_API_KEY environment variable", {
      code: "MissingKey",
    });
  }
  return key;
}

// ── base URL

/** A base URL that the SDK refuses to send credentials to. */
export class BaseURLError extends Error {
  constructor(message: string) {
    super(message);
    Object.defineProperty(this, "name", { value: "BaseURLError", enumerable: false, configurable: true, writable: true });
  }
}

const LOOPBACK_NAMES = new Set(["localhost", "localhost.localdomain"]);

function isLoopbackV4(host: string): boolean {
  const parts = host.split(".");
  if (parts.length !== 4) return false;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || (p.length > 1 && p.startsWith("0")) || Number(p) > 255) return false;
  }
  return parts[0] === "127";
}

function isLoopbackV6(host: string): boolean {
  const h = host.toLowerCase();
  if (!/^[0-9a-f:]+$/.test(h)) return false;
  const halves = h.split("::");
  if (halves.length > 2) return false;
  const groups = (s: string): string[] => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0] ?? "");
  const tail = halves.length === 2 ? groups(halves[1] ?? "") : [];
  if ([...head, ...tail].some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return false;
  let all: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 1) return false;
    all = [...head, ...Array<string>(fill).fill("0"), ...tail];
  } else {
    all = head;
  }
  if (all.length !== 8) return false;
  return all.slice(0, 7).every((g) => parseInt(g, 16) === 0) && parseInt(all[7] ?? "", 16) === 1;
}

function isLoopback(host: string): boolean {
  return LOOPBACK_NAMES.has(host) || isLoopbackV4(host) || isLoopbackV6(host);
}

/**
 * Validate and normalize a base URL; throw {@link BaseURLError} when it is refused.
 *
 * Every authenticated request sends the API key (`Authorization`) and address tokens (JSON body) to this URL, so:
 * - only `https://` is accepted, except `http://` to a loopback host (127.0.0.0/8, ::1, localhost) for local
 *   development, which also needs `allowUntrusted`;
 * - user info (`user:pass@`), a query string, a fragment, whitespace and control characters are refused;
 * - any host other than `open-api.tmailor.com` (port 443) needs `allowUntrusted`.
 *
 * Returns `scheme://host[:port][/path]` (lower-case scheme and host, no trailing `/`).
 */
export function checkBaseUrl(url: unknown, allowUntrusted = false): string {
  if (typeof url !== "string" || !url.trim()) throw new BaseURLError("baseUrl is empty");
  const raw = url.trim();
  for (const ch of raw) {
    const c = ch.codePointAt(0) ?? 0;
    if (/\s/u.test(ch) || c < 0x20 || (c >= 0x7f && c <= 0x9f)) {
      throw new BaseURLError("baseUrl must not contain spaces or control characters");
    }
  }
  if (raw.includes("?") || raw.includes("#")) throw new BaseURLError("baseUrl must not contain a query string or a fragment");
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(raw);
  const scheme = (m?.[1] ?? "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") throw new BaseURLError("baseUrl must start with https://");
  const rest = m?.[2] ?? "";
  let netloc = "";
  let path = "";
  if (rest.startsWith("//")) {
    const after = rest.slice(2);
    const slash = after.indexOf("/");
    netloc = slash === -1 ? after : after.slice(0, slash);
    path = slash === -1 ? "" : after.slice(slash);
  } else {
    path = rest;
  }
  if (netloc.includes("@")) throw new BaseURLError("baseUrl must not contain user info (user:password@)");
  let host = "";
  let portText = "";
  if (netloc.startsWith("[")) {
    const end = netloc.indexOf("]");
    if (end === -1) throw new BaseURLError("baseUrl is not a valid URL");
    host = netloc.slice(1, end);
    const after = netloc.slice(end + 1);
    if (after !== "" && !after.startsWith(":")) throw new BaseURLError("baseUrl is not a valid URL");
    portText = after.slice(1);
  } else {
    const colon = netloc.lastIndexOf(":");
    host = colon === -1 ? netloc : netloc.slice(0, colon);
    portText = colon === -1 ? "" : netloc.slice(colon + 1);
  }
  let port: number | null = null;
  if (portText !== "") {
    if (!/^\d+$/.test(portText) || Number(portText) > 65535) throw new BaseURLError("baseUrl is not a valid URL");
    port = Number(portText);
  }
  host = host.toLowerCase();
  if (!host) throw new BaseURLError("baseUrl has no host");
  const trusted = scheme === "https" && host === TRUSTED_HOST && (port === null || port === 443);
  if (scheme === "http") {
    if (!isLoopback(host)) {
      throw new BaseURLError("plain http:// is only allowed for a loopback host (local development); use https://");
    }
    if (!allowUntrusted) {
      throw new BaseURLError("http:// to a loopback host is a development setting: pass allowUntrustedBaseUrl: true");
    }
  } else if (!trusted && !allowUntrusted) {
    throw new BaseURLError(
      `baseUrl host "${host}" is not ${TRUSTED_HOST}: your API key and address tokens would be sent to it. ` +
        "Pass allowUntrustedBaseUrl: true only if you trust that host.",
    );
  }
  let out = host.includes(":") ? `[${host}]` : host;
  if (port !== null) out += `:${port}`;
  return `${scheme}://${out}${path.replace(/\/+$/, "")}`;
}

/** The base URL from the option, `TMAILOR_BASE_URL` or the default, validated by {@link checkBaseUrl}. */
export function resolveBaseUrl(baseUrl: string | undefined, allowUntrusted = false): string {
  return checkBaseUrl(baseUrl || env("TMAILOR_BASE_URL") || DEFAULT_BASE_URL, allowUntrusted);
}

// ── masking

/** `tmk_live_<prefix>_<secret>` -> `tmk_live_<prefix>_***`. The prefix is not secret (`me()` shows it). */
export function maskKey(key: string | null): string | null {
  if (key === null) return null;
  const parts = key.split("_");
  if (parts.length >= 4 && parts[0] === "tmk") return parts.slice(0, 3).join("_") + "_***";
  return "***";
}

export function maskToken(token: string | null): string | null {
  return token ? "***" : null;
}

/** `util.inspect.custom` without importing node:util. */
export const INSPECT = Symbol.for("nodejs.util.inspect.custom");

// ── requests

export type Query = Record<string, string | number | boolean | null | undefined>;

/** One logical API call. Retries resend exactly the same body and headers. */
export class RequestSpec {
  /** True when repeating the request cannot change state twice (GET, read-only POSTs, create with Idempotency-Key). */
  readonly safe: boolean;
  /** False for the public GET /v1/health (no Authorization header is sent, no key needed). */
  readonly auth: boolean;
  readonly query: Record<string, string>;
  readonly body: string | null;
  readonly headers: Record<string, string>;

  constructor(
    readonly method: "GET" | "POST",
    readonly path: string,
    opts: {
      query?: Query;
      json?: Record<string, unknown>;
      safe?: boolean;
      headers?: Record<string, string>;
      auth?: boolean;
    } = {},
  ) {
    this.safe = opts.safe ?? false;
    this.auth = opts.auth ?? true;
    this.headers = { ...(opts.headers ?? {}) };
    this.body = opts.json !== undefined ? JSON.stringify(opts.json) : null;
    if (this.body !== null && !hasHeader(this.headers, "content-type")) this.headers["Content-Type"] = "application/json";
    const q: Record<string, string> = {};
    for (const [k, v] of Object.entries(opts.query ?? {})) {
      if (v !== null && v !== undefined) q[k] = String(v);
    }
    this.query = q;
  }
}

function hasHeader(h: Record<string, string>, name: string): boolean {
  return Object.keys(h).some((k) => k.toLowerCase() === name);
}

export function newIdempotencyKey(): string {
  return randomUUID();
}

export function userAgent(): string {
  const nodeVersion = typeof process !== "undefined" && process.versions?.node ? process.versions.node : "unknown";
  return `tmailor-node/${VERSION} (node ${nodeVersion})`;
}

export function baseHeaders(): Record<string, string> {
  return { "User-Agent": userAgent(), Accept: "application/json" };
}

/** Headers of one request. Authorization only for operations that need the key. */
export function requestHeaders(spec: RequestSpec, base: Record<string, string>, apiKey: string | null): Record<string, string> {
  const headers: Record<string, string> = { ...base };
  if (spec.auth) headers["Authorization"] = `Bearer ${requireKey(apiKey)}`;
  Object.assign(headers, spec.headers);
  return headers;
}

// ── responses

/** Response headers with lower-case names. */
export type HeaderMap = ReadonlyMap<string, string>;

/** Values of the `X-RateLimit-*` headers of the last response that had them. */
export class RateLimitInfo {
  constructor(
    /** Requests allowed per window. */
    readonly limit: number | null,
    /** Requests left in the current window. */
    readonly remaining: number | null,
    /** Unix time (seconds) when the window resets. */
    readonly reset: number | null,
  ) {}

  static fromHeaders(headers: HeaderMap): RateLimitInfo | null {
    const lim = intHeader(headers, "x-ratelimit-limit");
    const rem = intHeader(headers, "x-ratelimit-remaining");
    const rst = intHeader(headers, "x-ratelimit-reset");
    if (lim === null && rem === null && rst === null) return null;
    return new RateLimitInfo(lim, rem, rst);
  }
}

export function intHeader(headers: HeaderMap, name: string): number | null {
  const v = headers.get(name.toLowerCase());
  if (v === undefined) return null;
  const s = v.trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

/** Retry-After in seconds: header first, then `error.retry_after`; negative values become 0. */
export function retryAfterSeconds(headers: HeaderMap, bodyError: Record<string, unknown>): number | null {
  let v = intHeader(headers, "retry-after");
  if (v === null) {
    const ra = bodyError["retry_after"];
    if (typeof ra === "number" && Number.isInteger(ra)) v = ra;
  }
  if (v !== null && v < 0) v = 0;
  return v;
}

const KEEP_ERROR_HEADERS = new Set([
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "x-request-id",
  "allow",
]);

const REASONS: Record<number, string> = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** A received HTTP response (body fully read). */
export interface RawResponse {
  status: number;
  statusText: string;
  headers: HeaderMap;
  body: Uint8Array;
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Turn an error response into a typed error. Never includes the request body or headers. */
export function buildError(res: RawResponse): APIError {
  const status = res.status;
  let err: Record<string, unknown> = {};
  try {
    const data: unknown = JSON.parse(decodeUtf8(res.body));
    if (isPlainObject(data) && isPlainObject(data["error"])) err = data["error"];
  } catch {
    err = {};
  }
  const code = typeof err["code"] === "string" ? err["code"] : null;
  let message = typeof err["message"] === "string" ? err["message"] : "";
  if (!message) message = `HTTP ${status} ${REASONS[status] ?? res.statusText ?? ""}`.trim();
  const description = typeof err["description"] === "string" ? err["description"] : "";
  let requestId = typeof err["request_id"] === "string" ? err["request_id"] : null;
  if (requestId === null) requestId = res.headers.get("x-request-id") ?? null;
  const keep: Record<string, string> = {};
  for (const [k, v] of res.headers) if (KEEP_ERROR_HEADERS.has(k)) keep[k] = v;
  const Cls = errorClass(code, status);
  return new Cls(message, {
    code: code || `HTTP${status}`,
    status,
    description,
    requestId,
    retryAfter: retryAfterSeconds(res.headers, err),
    body: err,
    headers: keep,
  });
}

/** Decode a 2xx body. Not JSON raises InvalidResponseError without the body or the decoder error. */
export function parseJson(res: RawResponse): unknown {
  if (res.status === 204 || res.body.length === 0) return null;
  let ok = true;
  let data: unknown = null;
  try {
    data = parseStrictJson(decodeUtf8(res.body));
  } catch {
    ok = false;
  }
  if (!ok) {
    throw new InvalidResponseError("The API returned a response that is not JSON", {
      status: res.status,
      requestId: res.headers.get("x-request-id") ?? null,
    });
  }
  return data;
}

/** Validate a 2xx body with a reader. A violation names the field only: no value, no body, no cause. */
export function parseBody<T>(res: RawResponse, data: unknown, parse: (data: unknown) => T): T {
  let problem = "";
  try {
    return parse(data);
  } catch (e) {
    if (!(e instanceof SchemaError)) throw e;
    problem = e.message;
  }
  throw new InvalidResponseError(`The API response does not match the expected format: ${problem}`, {
    status: res.status,
    requestId: res.headers.get("x-request-id") ?? null,
  });
}

/** Stop paginating when the API hands out a cursor that was already used (loop or cycle). */
export function checkCursor(seen: Set<string>, cursor: string): void {
  if (seen.has(cursor)) {
    throw new InvalidResponseError("The API returned a pagination cursor that was already used; stopping to avoid a loop");
  }
  seen.add(cursor);
}

// ── retries and deadlines

/** Exponential backoff with full jitter: random in [c/2, c], c = min(8 s, 0.5 s * 2^attempt). */
export function backoff(attempt: number, random: () => number = Math.random): number {
  const ceiling = Math.min(BACKOFF_MAX, BACKOFF_BASE * 2 ** attempt);
  return ceiling / 2 + random() * (ceiling / 2);
}

/**
 * Milliseconds to wait before the next attempt, or null when the request must not be retried.
 *
 * - at most `maxRetries` retries;
 * - 429 RateLimited: the API did not process the request, so ANY request is retried after Retry-After;
 *   DailyCapReached or a Retry-After above `maxRetryWait` is not retried;
 * - 500/502/503/504 and network errors: only SAFE requests, except a failed connection (nothing was sent);
 * - 503 CacheUnavailable is never retried.
 */
export function retryDelay(
  spec: RequestSpec,
  attempt: number,
  opts: { error: TmailorError | null; maxRetries: number; maxRetryWait: number; connectFailed?: boolean },
): number | null {
  const { error } = opts;
  if (attempt >= opts.maxRetries) return null;
  if (error === null) return null;
  const status = error.status;
  if (status === 429) {
    if (error.code === "DailyCapReached") return null;
    const ra = error.retryAfter;
    if (ra === null) return backoff(attempt);
    if (ra * 1000 > opts.maxRetryWait) return null;
    return Math.max(ra * 1000, MIN_RETRY_AFTER);
  }
  if (status === null) {
    if (opts.connectFailed || spec.safe) return backoff(attempt);
    return null;
  }
  if (RETRY_SAFE_STATUSES.has(status) && spec.safe) {
    if (error.code === "CacheUnavailable") return null;
    const ra = error.retryAfter;
    if (ra !== null) return ra * 1000 <= opts.maxRetryWait ? Math.max(ra * 1000, MIN_RETRY_AFTER) : null;
    return backoff(attempt);
  }
  return null;
}

/** A retry sleep that would end at or after `deadline` is not taken (null). */
export function withinDeadline(delay: number | null, now: number, deadline: number | null): number | null {
  if (delay === null || deadline === null) return delay;
  return now + delay < deadline ? delay : null;
}

/**
 * The timeout of one attempt inside a deadline (waitForMessage). Without a deadline it is the client timeout. With
 * one, the time left caps the request: nothing left throws WaitTimeoutError BEFORE anything is sent, and
 * `deadlineBound` is true when the cap is the deadline (a timeout of that request is then a WaitTimeoutError).
 */
export function requestTimeout(timeout: number, now: number, deadline: number | null): { timeout: number; deadlineBound: boolean } {
  if (deadline === null) return { timeout, deadlineBound: false };
  const remaining = deadline - now;
  if (remaining <= 0) throw new WaitTimeoutError();
  if (remaining <= timeout) return { timeout: remaining, deadlineBound: true };
  return { timeout, deadlineBound: false };
}

/** True when a request ended after the wait deadline (its result is not used). */
export function pastDeadline(now: number, deadline: number | null): boolean {
  return deadline !== null && now > deadline;
}
