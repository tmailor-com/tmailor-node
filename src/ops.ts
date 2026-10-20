/**
 * Request builders: one function per API operation, returning a RequestSpec. Keep this table identical to the other
 * SDKs (paths, methods, bodies, safety flags): see `_ops.py` of the Python SDK.
 *
 * @internal
 */

import { RequestSpec, newIdempotencyKey } from "./core.js";
import { TmailorError } from "./errors.js";

/** A `YYYY-MM-DD` string, or a `Date` (its local calendar date is used). */
export type DateLike = string | Date;
/** Unix time in **seconds**, or a `Date`. */
export type TimeLike = number | Date;

export const MAX_PAGE = 100;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function dateParam(v: DateLike | null | undefined, name: string): string | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) throw new RangeError(`${name} is an invalid Date`);
    return `${pad(v.getFullYear(), 4)}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  }
  if (typeof v === "string") return v;
  throw new TypeError(`${name} must be a Date or a 'YYYY-MM-DD' string`);
}

/** Unix seconds (truncated) from a number of seconds or a Date; null when absent. */
export function unixTime(v: TimeLike | null | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (v instanceof Date) {
    const ms = v.getTime();
    if (Number.isNaN(ms)) throw new RangeError("since is an invalid Date");
    return Math.floor(ms / 1000);
  }
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new RangeError("since must be a finite unix time in seconds");
    return Math.trunc(v);
  }
  throw new TypeError("since must be a unix time in seconds or a Date");
}

export function pageSize(v: number | null | undefined): number {
  const n = v === undefined || v === null ? 50 : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > MAX_PAGE) {
    throw new RangeError(`pageSize must be an integer between 1 and ${MAX_PAGE}`);
  }
  return n;
}

function token(t: string | null): string {
  if (!t) {
    throw new TmailorError(
      "This mailbox has no token (tokens can be temporarily unavailable). Get it again with client.mailboxes.list()",
      { code: "NoToken" },
    );
  }
  return t;
}

function messageId(id: unknown): string {
  if (typeof id !== "string" || !id) throw new TypeError("messageId is required");
  return id;
}

export function health(): RequestSpec {
  // Public endpoint, sent without Authorization (works without an API key).
  return new RequestSpec("GET", "/v1/health", { safe: true, auth: false });
}

export function me(): RequestSpec {
  return new RequestSpec("GET", "/v1/me", { safe: true });
}

export function domains(): RequestSpec {
  return new RequestSpec("GET", "/v1/domains", { safe: true });
}

export function usage(from?: DateLike | null, to?: DateLike | null): RequestSpec {
  return new RequestSpec("GET", "/v1/usage", {
    query: { from: dateParam(from, "from"), to: dateParam(to, "to") },
    safe: true,
  });
}

export function mailboxesCreate(domain?: string | null, name?: string | null, idempotencyKey?: string | null): RequestSpec {
  const body: Record<string, unknown> = {};
  if (domain !== undefined && domain !== null) body["domain"] = domain;
  if (name !== undefined && name !== null) body["name"] = name;
  const key = idempotencyKey !== undefined && idempotencyKey !== null ? idempotencyKey : newIdempotencyKey();
  if (typeof key !== "string" || key.length < 1 || key.length > 128 || !/^[\x21-\x7e]+$/.test(key)) {
    throw new RangeError("idempotencyKey must be 1-128 visible ASCII characters");
  }
  // Safe to retry: the server returns the first result for the same key + same body.
  return new RequestSpec("POST", "/v1/mailboxes", { json: body, safe: true, headers: { "Idempotency-Key": key } });
}

export function mailboxesList(cursor?: string | null, size?: number | null): RequestSpec {
  return new RequestSpec("GET", "/v1/mailboxes", { query: { limit: pageSize(size), cursor: cursor ?? null }, safe: true });
}

// one address: POST + token in the JSON body (never in the URL or a header)

export function mailboxInfo(t: string | null): RequestSpec {
  return new RequestSpec("POST", "/v1/mailbox/info", { json: { token: token(t) }, safe: true });
}

export interface MessageFilters {
  unread?: boolean | null;
  from?: string | null;
  subject?: string | null;
  since?: TimeLike | null;
}

export function mailboxMessages(
  t: string | null,
  f: MessageFilters & { size?: number | null; cursor?: string | null } = {},
): RequestSpec {
  const body: Record<string, unknown> = { token: token(t) };
  if (f.unread !== undefined && f.unread !== null) body["unread"] = Boolean(f.unread);
  if (f.from) body["from"] = f.from;
  if (f.subject) body["subject"] = f.subject;
  const s = unixTime(f.since);
  if (s !== null) body["since"] = s;
  body["limit"] = pageSize(f.size);
  if (f.cursor) body["cursor"] = f.cursor;
  return new RequestSpec("POST", "/v1/mailbox/messages", { json: body, safe: true });
}

export function mailboxMessage(t: string | null, id: string): RequestSpec {
  // The server marks the message as read; that is idempotent, so the request stays safe to retry.
  return new RequestSpec("POST", "/v1/mailbox/message", { json: { token: token(t), message_id: messageId(id) }, safe: true });
}

export function mailboxMessageDelete(t: string | null, id: string): RequestSpec {
  return new RequestSpec("POST", "/v1/mailbox/message/delete", { json: { token: token(t), message_id: messageId(id) } });
}

export function mailboxClear(t: string | null): RequestSpec {
  return new RequestSpec("POST", "/v1/mailbox/messages/clear", { json: { token: token(t) } });
}

export function mailboxDelete(t: string | null): RequestSpec {
  return new RequestSpec("POST", "/v1/mailbox/delete", { json: { token: token(t) } });
}
