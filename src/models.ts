/**
 * Data returned by the API, with camelCase names (`received_at` is `receivedAt`). Timestamps are Unix seconds, as
 * the API sends them.
 *
 * Every reader validates the body against the OpenAPI schema (required fields, exact JSON types, `null` only where
 * the schema allows it) and throws instead of inventing defaults; the client turns that into
 * `InvalidResponseError` (code `InvalidResponse`) without the body. Unknown extra fields are ignored but kept in the
 * non-enumerable `raw` property, so fields added to the API later are still reachable.
 */

import { INSPECT } from "./core.js";
import * as S from "./schema.js";

function hide(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: false, writable: false, configurable: false });
}

type Init<T> = { -readonly [K in keyof T as T[K] extends (...args: never[]) => unknown ? never : K]: T[K] };

/** `GET /v1/health`. */
export class Health {
  readonly status!: string;
  readonly time!: number;
  readonly version!: string;
  /** The JSON object as received (not enumerable). */
  declare readonly raw: Record<string, unknown>;

  /** @internal */
  constructor(init: Init<Omit<Health, "raw">>, raw: Record<string, unknown>) {
    Object.assign(this, init);
    hide(this, "raw", raw);
  }

  /** @internal */
  static fromApi(data: unknown): Health {
    const d = S.obj(data, "$");
    return new Health(
      { status: S.reqStr(d, "status", "$"), time: S.reqInt(d, "time", "$"), version: S.reqStr(d, "version", "$") },
      { ...d },
    );
  }
}

export interface KeyInfo {
  readonly keyId: number;
  /** Non-secret prefix of the key (`tmk_live_<prefix>_...`). */
  readonly prefix: string;
}

export interface Limits {
  readonly quotaTotal: number;
  readonly quotaUsed: number;
  readonly quotaRemaining: number;
  readonly mailboxCount: number;
  readonly ratePerMin: number;
  readonly dailyReqCap: number;
  readonly maxIp: number;
}

export interface Subscription {
  readonly plan: string;
  readonly expiresAt: number;
  readonly periodEnd: number;
  readonly quota: number;
  readonly used: number;
}

function parseLimits(data: unknown, path: string): Limits {
  const d = S.obj(data, path);
  return {
    quotaTotal: S.reqInt(d, "quota_total", path),
    quotaUsed: S.reqInt(d, "quota_used", path),
    quotaRemaining: S.reqInt(d, "quota_remaining", path),
    mailboxCount: S.reqInt(d, "mailbox_count", path),
    ratePerMin: S.reqInt(d, "rate_per_min", path),
    dailyReqCap: S.reqInt(d, "daily_req_cap", path),
    maxIp: S.reqInt(d, "max_ip", path),
  };
}

function parseSubscription(data: unknown, path: string): Subscription {
  const d = S.obj(data, path);
  return {
    plan: S.reqStr(d, "plan", path),
    expiresAt: S.reqInt(d, "expires_at", path),
    periodEnd: S.reqInt(d, "period_end", path),
    quota: S.reqInt(d, "quota", path),
    used: S.reqInt(d, "used", path),
  };
}

/** `GET /v1/me`: your account, limits and plans. */
export class Me {
  readonly userId!: number;
  readonly key!: KeyInfo;
  readonly clientIp!: string;
  readonly limits!: Limits;
  readonly ipAllowlist!: string[];
  /**
   * Review 20b NODE-01: whether `ipAllowlist` is applied to your requests. `false` while a paid plan is active
   * (requests are accepted from any IP), `true` on the Free plan only. Required in spec 1.3.0.
   */
  readonly ipAllowlistEnforced!: boolean;
  readonly subscriptions!: Subscription[];
  declare readonly raw: Record<string, unknown>;

  /** @internal */
  constructor(init: Init<Omit<Me, "raw">>, raw: Record<string, unknown>) {
    Object.assign(this, init);
    hide(this, "raw", raw);
  }

  /** @internal */
  static fromApi(data: unknown): Me {
    const d = S.obj(data, "$");
    const k = S.reqObj(d, "key", "$");
    return new Me(
      {
        userId: S.reqInt(d, "user_id", "$"),
        key: { keyId: S.reqInt(k, "key_id", "$.key"), prefix: S.reqStr(k, "prefix", "$.key") },
        clientIp: S.reqStr(d, "client_ip", "$"),
        limits: parseLimits(S.reqObj(d, "limits", "$"), "$.limits"),
        ipAllowlist: S.reqStrList(d, "ip_allowlist", "$"),
        ipAllowlistEnforced: S.reqBool(d, "ip_allowlist_enforced", "$"), // Review 20b NODE-01
        subscriptions: S.reqList(d, "subscriptions", "$").map((s, i) => parseSubscription(s, `$.subscriptions[${i}]`)),
      },
      { ...d },
    );
  }
}

/** One of your own domains. Shared domains are never listed. */
export class Domain {
  readonly domain!: string;
  readonly isUserDomain!: boolean;
  readonly allowCustomName!: boolean;
  readonly status!: string;
  readonly verified!: boolean;
  readonly usable!: boolean;
  declare readonly raw: Record<string, unknown>;

  /** @internal */
  constructor(init: Init<Omit<Domain, "raw">>, raw: Record<string, unknown>) {
    Object.assign(this, init);
    hide(this, "raw", raw);
  }

  /** @internal */
  static fromApi(data: unknown, path = "$"): Domain {
    const d = S.obj(data, path);
    return new Domain(
      {
        domain: S.reqStr(d, "domain", path),
        isUserDomain: S.reqBool(d, "is_user_domain", path),
        allowCustomName: S.reqBool(d, "allow_custom_name", path),
        status: S.reqStr(d, "status", path),
        verified: S.reqBool(d, "verified", path),
        usable: S.reqBool(d, "usable", path),
      },
      { ...d },
    );
  }
}

/** `GET /v1/domains`. Iterable: `for (const d of list)` yields the domains. */
export class DomainList implements Iterable<Domain> {
  readonly items: Domain[];
  readonly sharedDomainsAvailable: boolean;

  /** @internal */
  constructor(items: Domain[], sharedDomainsAvailable: boolean) {
    this.items = items;
    this.sharedDomainsAvailable = sharedDomainsAvailable;
  }

  get length(): number {
    return this.items.length;
  }

  [Symbol.iterator](): Iterator<Domain> {
    return this.items[Symbol.iterator]();
  }

  /** @internal */
  static fromApi(data: unknown): DomainList {
    const d = S.obj(data, "$");
    return new DomainList(
      S.reqList(d, "items", "$").map((x, i) => Domain.fromApi(x, `$.items[${i}]`)),
      S.reqBool(d, "shared_domains_available", "$"),
    );
  }
}

/**
 * Tokens to use the address on tmailor.com. Anyone holding them can read the inbox (and, with `transferToken`, take
 * the address over): treat them like passwords. `util.inspect`, `JSON.stringify` and `String()` show `***`.
 */
export class WebAccess {
  readonly #accessToken: string;
  readonly #transferToken: string;
  readonly #reuseUrl: string;

  /** @internal */
  constructor(accessToken: string, transferToken: string, reuseUrl: string) {
    this.#accessToken = accessToken;
    this.#transferToken = transferToken;
    this.#reuseUrl = reuseUrl;
  }

  /** `accesstoken` of the API (the same value as `Mailbox.token`). */
  get accessToken(): string {
    return this.#accessToken;
  }

  /** `transfertoken` of the API. */
  get transferToken(): string {
    return this.#transferToken;
  }

  /** `reuse_url` of the API (contains a token). */
  get reuseUrl(): string {
    return this.#reuseUrl;
  }

  toJSON(): Record<string, string> {
    return { accessToken: "***", transferToken: "***", reuseUrl: "***" };
  }

  toString(): string {
    return "WebAccess { accessToken: '***', transferToken: '***', reuseUrl: '***' }";
  }

  [INSPECT](): string {
    return this.toString();
  }

  /** @internal */
  static fromApi(data: unknown, path = "$.web"): WebAccess {
    const d = S.obj(data, path);
    return new WebAccess(S.reqStr(d, "accesstoken", path), S.reqStr(d, "transfertoken", path), S.reqStr(d, "reuse_url", path));
  }
}

export interface Sender {
  readonly name: string;
  readonly address: string;
}

/**
 * A message. From a message list `text`/`html`/`bodyAvailable` are `null` (`hasBody` false) and `otp`/`codes`/`links`
 * are empty; from `Mailbox.message(id)` or `waitForMessage` they hold the body and the values found by the API.
 * `seen` is true once the message was read (reading one message marks it as read).
 */
export class Message {
  readonly id!: string;
  readonly from!: Sender;
  readonly to!: string;
  readonly subject!: string;
  /** Unix seconds. */
  readonly receivedAt!: number;
  /** Unix seconds (messages are kept 24 hours). */
  readonly expiresAt!: number;
  readonly seen!: boolean;
  /** Plain-text body, or `null` (list items, or no text part). */
  readonly text!: string | null;
  /** Sanitized HTML body, or `null`. */
  readonly html!: string | null;
  /** `null` for list items. */
  readonly bodyAvailable!: boolean | null;
  /** One-time code found by the API (field `otp`), or `null` when there is no confident answer. */
  readonly otp!: string | null;
  /** Every distinct code-like value found by the API, subject first (field `codes`). */
  readonly codes!: string[];
  /** Unique absolute http(s) links of the body found by the API (field `links`). */
  readonly links!: string[];
  declare readonly raw: Record<string, unknown>;

  /** @internal */
  constructor(init: Init<Omit<Message, "raw" | "hasBody">>, raw: Record<string, unknown>) {
    Object.assign(this, init);
    hide(this, "raw", raw);
  }

  /** True when `text` or `html` is set. */
  get hasBody(): boolean {
    return this.text !== null || this.html !== null;
  }

  /**
   * @internal
   * `withBody`: the response of `POST /v1/mailbox/message` (`text`, `html` and `bodyAvailable` are required there,
   * `otp`/`codes`/`links` are read when present: API 1.3.0).
   */
  static fromApi(data: unknown, path = "$", withBody = false): Message {
    const d = S.obj(data, path);
    const f = S.reqObj(d, "from", path);
    const fp = `${path}.from`;
    let text: string | null = null;
    let html: string | null = null;
    let bodyAvailable: boolean | null = null;
    let otp: string | null = null;
    let codes: string[] = [];
    let links: string[] = [];
    if (withBody) {
      text = S.reqStrOrNull(d, "text", path);
      html = S.reqStrOrNull(d, "html", path);
      bodyAvailable = S.reqBool(d, "body_available", path);
      if (S.hasKey(d, "otp")) otp = S.reqStrOrNull(d, "otp", path);
      if (S.hasKey(d, "codes")) codes = S.reqStrList(d, "codes", path);
      if (S.hasKey(d, "links")) links = S.reqStrList(d, "links", path);
    }
    const seen = S.reqBool(d, "seen", path);
    if (withBody && seen !== true) {
      // POST /v1/mailbox/message marks the message as read, so a full message must come back with seen: true.
      throw new S.SchemaError(`${path}.seen must be true for a message read with its body`);
    }
    return new Message(
      {
        id: S.reqStr(d, "id", path),
        from: { name: S.reqStr(f, "name", fp), address: S.reqStr(f, "address", fp) },
        to: S.reqStr(d, "to", path),
        subject: S.reqStr(d, "subject", path),
        receivedAt: S.reqInt(d, "received_at", path),
        expiresAt: S.reqInt(d, "expires_at", path),
        seen,
        text,
        html,
        bodyAvailable,
        otp,
        codes,
        links,
      },
      { ...d },
    );
  }

  /** @internal */
  static fromApiWithBody(data: unknown): Message {
    return Message.fromApi(data, "$", true);
  }
}

/** One page of messages: `items` (no bodies), `nextCursor`, `total`. */
export class MessagePage {
  /** @internal */
  constructor(
    readonly items: Message[],
    readonly nextCursor: string | null,
    readonly total: number,
  ) {}

  /** @internal */
  static fromApi(data: unknown): MessagePage {
    const d = S.obj(data, "$");
    return new MessagePage(
      S.reqList(d, "items", "$").map((x, i) => Message.fromApi(x, `$.items[${i}]`)),
      S.cursor(d, "$"),
      S.reqInt(d, "total", "$"),
    );
  }
}

export interface UsageDay {
  readonly date: string;
  readonly reqTotal: number;
  readonly req4xx: number;
  readonly req5xx: number;
  readonly req429: number;
  readonly reqIpDenied: number;
  readonly mailboxCreated: number;
  readonly msgList: number;
  readonly msgRead: number;
}

function parseUsageDay(data: unknown, path: string): UsageDay {
  const d = S.obj(data, path);
  return {
    date: S.reqStr(d, "date", path),
    reqTotal: S.reqInt(d, "req_total", path),
    req4xx: S.reqInt(d, "req_4xx", path),
    req5xx: S.reqInt(d, "req_5xx", path),
    req429: S.reqInt(d, "req_429", path),
    reqIpDenied: S.reqInt(d, "req_ip_denied", path),
    mailboxCreated: S.reqInt(d, "mailbox_created", path),
    msgList: S.reqInt(d, "msg_list", path),
    msgRead: S.reqInt(d, "msg_read", path),
  };
}

/** `GET /v1/usage`: daily counters (Asia/Ho_Chi_Minh days). */
export class Usage {
  readonly from!: string;
  readonly to!: string;
  readonly timezone!: string;
  readonly days!: UsageDay[];
  declare readonly raw: Record<string, unknown>;

  /** @internal */
  constructor(init: Init<Omit<Usage, "raw">>, raw: Record<string, unknown>) {
    Object.assign(this, init);
    hide(this, "raw", raw);
  }

  /** @internal */
  static fromApi(data: unknown): Usage {
    const d = S.obj(data, "$");
    return new Usage(
      {
        from: S.reqStr(d, "from", "$"),
        to: S.reqStr(d, "to", "$"),
        timezone: S.reqStr(d, "timezone", "$"),
        days: S.reqList(d, "days", "$").map((x, i) => parseUsageDay(x, `$.days[${i}]`)),
      },
      { ...d },
    );
  }
}

/** `POST /v1/mailbox/messages/clear`: `{"deleted": n}`. @internal */
export function parseDeleted(data: unknown): number {
  return S.reqInt(S.obj(data, "$"), "deleted", "$");
}

/** Validated fields of the Mailbox schema. @internal */
export interface MailboxFields {
  email: string;
  domain: string;
  isUserDomain: boolean;
  customName: boolean;
  createdAt: number;
  messageCount: number | null;
  token: string | null;
  web: WebAccess | null;
  raw: Record<string, unknown>;
}

/** @internal */
export function parseMailboxFields(data: unknown, path = "$"): MailboxFields {
  const d = S.obj(data, path);
  const token = S.reqStrOrNull(d, "token", path);
  const w = S.reqObjOrNull(d, "web", path);
  const web = w !== null ? WebAccess.fromApi(w, `${path}.web`) : null;
  // token and web are null together, and token is the same value as web.accesstoken (OpenAPI Mailbox).
  if ((token === null) !== (web === null)) throw new S.SchemaError(`${path}.token and ${path}.web must both be null or both be set`);
  if (token !== null && web !== null && token !== web.accessToken) {
    throw new S.SchemaError(`${path}.token must equal ${path}.web.accesstoken`);
  }
  return {
    email: S.reqStr(d, "email", path),
    domain: S.reqStr(d, "domain", path),
    isUserDomain: S.reqBool(d, "is_user_domain", path),
    customName: S.reqBool(d, "custom_name", path),
    createdAt: S.reqInt(d, "created_at", path),
    messageCount: S.optInt(d, "message_count", path),
    token,
    web,
    raw: { ...d },
  };
}

/** `GET /v1/mailboxes`: items + next_cursor. @internal */
export function parseMailboxPage(data: unknown): { items: MailboxFields[]; nextCursor: string | null } {
  const d = S.obj(data, "$");
  const items = S.reqList(d, "items", "$").map((x, i) => parseMailboxFields(x, `$.items[${i}]`));
  return { items, nextCursor: S.cursor(d, "$") };
}
