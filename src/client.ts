import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_RETRY_WAIT,
  DEFAULT_TIMEOUT,
  INSPECT,
  RateLimitInfo,
  baseHeaders,
  buildError,
  checkDuration,
  checkCursor,
  maskKey,
  maskToken,
  parseBody,
  parseJson,
  pastDeadline,
  realClock,
  requestHeaders,
  requestTimeout,
  resolveApiKey,
  resolveBaseUrl,
  retryDelay,
  withinDeadline,
  type Clock,
  type RawResponse,
  type RequestSpec,
} from "./core.js";
import { APIConnectionError, APITimeoutError, RateLimitedError, TmailorError, WaitTimeoutError } from "./errors.js";
import {
  DomainList,
  Health,
  Me,
  Message,
  MessagePage,
  Usage,
  parseDeleted,
  parseMailboxFields,
  parseMailboxPage,
  type MailboxFields,
  type WebAccess,
} from "./models.js";
import * as ops from "./ops.js";
import { WaitPlan } from "./wait.js";

// ── transport types

/** The response object the SDK reads (a subset of the WHATWG `Response`). */
export interface FetchResponseLike {
  readonly status: number;
  readonly statusText: string;
  readonly headers: { forEach(callback: (value: string, key: string) => void): void };
  arrayBuffer(): Promise<ArrayBuffer>;
}

/** The request options the SDK passes (a subset of `RequestInit`). */
export interface FetchInitLike {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  redirect: "manual";
}

/** A `fetch`-compatible function: the global `fetch`, undici's `fetch`, or your own wrapper (proxy, logging). */
export type FetchLike = (url: string, init: FetchInitLike) => Promise<FetchResponseLike>;

export interface ClientOptions {
  /** `tmk_live_...` key. Defaults to `TMAILOR_API_KEY`. Only `health()` works without a key. */
  apiKey?: string | null;
  /** Defaults to `TMAILOR_BASE_URL` or `https://open-api.tmailor.com`. */
  baseUrl?: string;
  /** Milliseconds for each HTTP request (default 30000). */
  timeout?: number;
  /** Automatic retries for 429, 5xx and network errors (default 2, see README "Retries"). */
  maxRetries?: number;
  /** Longest `Retry-After` that is waited for automatically, in milliseconds (default 60000). */
  maxRetryWait?: number;
  /**
   * Required (true) for a `baseUrl` whose host is not `open-api.tmailor.com` (staging, a proxy, `http://127.0.0.1`
   * for local development): the API key and address tokens are sent to that host. `http://` is accepted only for a
   * loopback host.
   */
  allowUntrustedBaseUrl?: boolean;
  /** Your own `fetch` (proxy agent, instrumentation, tests). Defaults to the global `fetch`. */
  fetch?: FetchLike;
  /** Time source (tests). Defaults to the real clock. */
  clock?: Clock;
}

interface RequestOptions {
  /** Monotonic deadline (ms) of a waitForMessage. */
  deadline?: number | null;
  /** False: a 429 RateLimited is left to the caller (waitForMessage). */
  retry429?: boolean;
}

const CONNECT_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EAI_FAIL",
  "EAI_NONAME",
  "EHOSTUNREACH",
  "EHOSTDOWN",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);
const TLS_CODE = /^(ERR_TLS_|ERR_SSL_|ERR_OSSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN|HOSTNAME_MISMATCH)/;
const TIMEOUT_CODES = new Set(["UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT"]);
const NETWORK_CODE = /^(E[A-Z0-9_]+|UND_ERR_[A-Z_]+|ERR_TLS_[A-Z_]+|ERR_SSL_[A-Z_]+|ERR_OSSL_[A-Z0-9_]+|CERT_[A-Z_]+)$/;

function errCode(e: unknown): string | null {
  const pick = (x: unknown): string | null => {
    const c = x !== null && typeof x === "object" ? (x as { code?: unknown }).code : undefined;
    return typeof c === "string" && /^[A-Z0-9_]{1,64}$/.test(c) ? c : null;
  };
  const cause = e !== null && typeof e === "object" ? (e as { cause?: unknown }).cause : undefined;
  const inner = cause !== null && typeof cause === "object" ? (cause as { errors?: unknown }).errors : undefined;
  return pick(cause) ?? (Array.isArray(inner) ? pick(inner[0]) : null) ?? pick(e);
}

/** True for errors that `fetch` throws when there is no HTTP response; other errors (bugs) are re-thrown. */
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  if (e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError")) return true;
  const code = errCode(e);
  return code !== null && NETWORK_CODE.test(code);
}

type SendResult =
  | { ok: true; res: RawResponse }
  | { ok: false; error: TmailorError; connectFailed: boolean; timedOut: boolean };

function defaultFetch(): FetchLike {
  const f = (globalThis as { fetch?: unknown }).fetch;
  if (typeof f !== "function") throw new TypeError("No global fetch: use Node.js 18 or later, or pass the fetch option");
  return f.bind(globalThis) as FetchLike;
}

/**
 * Client of the Tmailor Open API (server-side only).
 *
 * ```ts
 * const client = new Client(); // reads TMAILOR_API_KEY
 * const box = await client.mailboxes.create();
 * const msg = await box.waitForMessage({ timeout: 120_000 });
 * ```
 */
export class Client {
  readonly baseUrl: string;
  readonly timeout: number;
  readonly maxRetries: number;
  readonly maxRetryWait: number;
  readonly mailboxes: Mailboxes;
  /** `X-RateLimit-*` values of the last response that had them. */
  lastRateLimit: RateLimitInfo | null = null;

  readonly #apiKey: string | null;
  readonly #fetch: FetchLike;
  readonly #headers: Record<string, string>;
  /** @internal */
  declare readonly clock: Clock;

  constructor(options: ClientOptions = {}) {
    // A missing key is reported by the first call that needs it, not here (health() is public).
    this.#apiKey = resolveApiKey(options.apiKey);
    this.baseUrl = resolveBaseUrl(options.baseUrl, options.allowUntrustedBaseUrl ?? false);
    // Review 20b NODE-04: durations must be finite (Infinity would reach setTimeout and fire after 1 ms).
    const timeout = checkDuration("timeout", options.timeout ?? DEFAULT_TIMEOUT, true);
    const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new RangeError("maxRetries must be an integer >= 0");
    const maxRetryWait = checkDuration("maxRetryWait", options.maxRetryWait ?? DEFAULT_MAX_RETRY_WAIT);
    this.timeout = timeout;
    this.maxRetries = maxRetries;
    this.maxRetryWait = maxRetryWait;
    this.#fetch = options.fetch ?? defaultFetch();
    this.#headers = baseHeaders();
    Object.defineProperty(this, "clock", { value: options.clock ?? realClock, enumerable: false });
    this.mailboxes = new Mailboxes(this);
  }

  toString(): string {
    return `Client { baseUrl: '${this.baseUrl}', apiKey: ${JSON.stringify(maskKey(this.#apiKey))} }`;
  }

  toJSON(): Record<string, unknown> {
    return { baseUrl: this.baseUrl, apiKey: maskKey(this.#apiKey) };
  }

  [INSPECT](): string {
    return this.toString();
  }

  // ── account

  /** `GET /v1/health` (public: no key needed, none is sent). A degraded service answers 503 (code `HTTP503`). */
  health(): Promise<Health> {
    return this.call(ops.health(), Health.fromApi);
  }

  /** `GET /v1/me`: account, limits (quota, rate per minute, daily cap...), IP allowlist, plans. */
  me(): Promise<Me> {
    return this.call(ops.me(), Me.fromApi);
  }

  /** `GET /v1/domains`: your own domains and whether shared domains are available. */
  domains(): Promise<DomainList> {
    return this.call(ops.domains(), DomainList.fromApi);
  }

  /** `GET /v1/usage`: daily counters. `from`/`to` are `YYYY-MM-DD` strings or Dates (local calendar date). */
  usage(range: { from?: ops.DateLike | null; to?: ops.DateLike | null } = {}): Promise<Usage> {
    return this.call(ops.usage(range.from, range.to), Usage.fromApi);
  }

  /** A Mailbox for a token you stored earlier. No request is made; call `info()` to load its fields. */
  mailbox(token: string): Mailbox {
    if (typeof token !== "string" || !token.trim()) throw new TypeError("token is required");
    return new Mailbox(this, token.trim());
  }

  // ── transport

  /** @internal */
  async call<T>(spec: RequestSpec, parse: (data: unknown) => T, opts: RequestOptions = {}): Promise<T> {
    const { data, res } = await this.request(spec, opts);
    return parseBody(res, data, parse);
  }

  /**
   * @internal
   * Send `spec` with the retry rules. `deadline` (monotonic ms) bounds every retry sleep and every HTTP attempt: no
   * time left throws WaitTimeoutError before sending, the attempt timeout is `min(timeout, time left)` and a timeout
   * caused by the deadline is a WaitTimeoutError. The abort signal cancels the whole request (connect, headers and
   * body), so the deadline is a hard limit.
   */
  async request(spec: RequestSpec, opts: RequestOptions = {}): Promise<{ data: unknown; res: RawResponse }> {
    const deadline = opts.deadline ?? null;
    const retry429 = opts.retry429 ?? true;
    const qs = new URLSearchParams(spec.query).toString();
    const url = this.baseUrl + spec.path + (qs ? `?${qs}` : "");
    const headers = requestHeaders(spec, this.#headers, this.#apiKey);
    let attempt = 0;
    for (;;) {
      const { timeout, deadlineBound } = requestTimeout(this.timeout, this.clock.now(), deadline);
      const out = await this.send(spec, url, headers, timeout);
      let err: TmailorError;
      let connectFailed = false;
      if (out.ok) {
        if (pastDeadline(this.clock.now(), deadline)) throw new WaitTimeoutError();
        const rl = RateLimitInfo.fromHeaders(out.res.headers);
        if (rl !== null) this.lastRateLimit = rl;
        // Review 20b NODE-03: only 2xx is success. Redirects are never followed (redirect: "manual", the Authorization
        // header must not go to another host), so a 3xx is an APIError (code HTTP3xx), never a silent success.
        if (out.res.status >= 200 && out.res.status < 300) return { data: parseJson(out.res), res: out.res };
        err = buildError(out.res);
      } else {
        if (out.timedOut && (deadlineBound || pastDeadline(this.clock.now(), deadline))) throw new WaitTimeoutError();
        err = out.error;
        connectFailed = out.connectFailed;
      }
      let delay: number | null = null;
      if (retry429 || err.status !== 429) {
        delay = retryDelay(spec, attempt, {
          error: err,
          maxRetries: this.maxRetries,
          maxRetryWait: this.maxRetryWait,
          connectFailed,
        });
        delay = withinDeadline(delay, this.clock.now(), deadline);
      }
      if (delay === null) throw err;
      await this.clock.sleep(delay);
      attempt += 1;
    }
  }

  private async send(spec: RequestSpec, url: string, headers: Record<string, string>, timeout: number): Promise<SendResult> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = this.clock.setTimeout(() => {
      timedOut = true;
      ac.abort();
    }, timeout);
    try {
      const init: FetchInitLike = { method: spec.method, headers: { ...headers }, signal: ac.signal, redirect: "manual" };
      if (spec.body !== null) init.body = spec.body;
      const resp = await this.#fetch(url, init);
      const body = new Uint8Array(await resp.arrayBuffer());
      const h = new Map<string, string>();
      resp.headers.forEach((value, key) => h.set(key.toLowerCase(), value));
      return { ok: true, res: { status: resp.status, statusText: resp.statusText ?? "", headers: h, body } };
    } catch (e) {
      // The original error is dropped: it can carry the request (headers with the API key) in some fetch versions.
      if (timedOut) return { ok: false, error: new APITimeoutError("Request timed out"), connectFailed: false, timedOut: true };
      if (!isNetworkError(e)) throw e;
      const code = errCode(e);
      const name = e instanceof Error && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : "Error";
      const label = code ?? name;
      if ((code !== null && TIMEOUT_CODES.has(code)) || name === "TimeoutError") {
        return {
          ok: false,
          error: new APITimeoutError(`Request timed out (${label})`),
          connectFailed: code === "UND_ERR_CONNECT_TIMEOUT",
          timedOut: true,
        };
      }
      if (code !== null && (CONNECT_CODES.has(code) || TLS_CODE.test(code))) {
        return { ok: false, error: new APIConnectionError(`Connection failed (${label})`), connectFailed: true, timedOut: false };
      }
      return { ok: false, error: new APIConnectionError(`Network error (${label})`), connectFailed: false, timedOut: false };
    } finally {
      this.clock.clearTimeout(timer);
    }
  }
}

/**
 * A Mailbox whose fields were loaded from the API (returned by `create()`, `list()`, `listPage()` and `info()`):
 * `email`, `domain`, `isUserDomain`, `customName` and `createdAt` are set. `token` and `web` can still be `null`.
 */
export type LoadedMailbox = Mailbox & {
  readonly email: string;
  readonly domain: string;
  readonly isUserDomain: boolean;
  readonly customName: boolean;
  readonly createdAt: number;
};

/** One page of `client.mailboxes.listPage()`. */
export interface MailboxPage {
  readonly items: LoadedMailbox[];
  readonly nextCursor: string | null;
}

/** `client.mailboxes`: create and list addresses. `for await (const box of client.mailboxes)` lists them all. */
export class Mailboxes implements AsyncIterable<LoadedMailbox> {
  readonly #client: Client;

  /** @internal */
  constructor(client: Client) {
    this.#client = client;
  }

  /**
   * Create an address (uses 1 unit of mailbox quota; never expires).
   *
   * Without `domain` a random shared domain and a random name are used. `domain` must be one of your usable domains
   * (`client.domains()`); `name` is only allowed with your own domain. An `Idempotency-Key` is generated (or pass
   * yours) and retries reuse it, so a retry never creates a second address.
   */
  async create(
    options: { domain?: string | null; name?: string | null; idempotencyKey?: string | null } = {},
  ): Promise<LoadedMailbox> {
    const spec = ops.mailboxesCreate(options.domain, options.name, options.idempotencyKey);
    const f = await this.#client.call(spec, parseMailboxFields);
    return Mailbox.fromFields(this.#client, f);
  }

  /** One page of addresses (newest first) with their current tokens. */
  async listPage(options: { cursor?: string | null; pageSize?: number | null } = {}): Promise<MailboxPage> {
    const { items, nextCursor } = await this.#client.call(ops.mailboxesList(options.cursor, options.pageSize), parseMailboxPage);
    return { items: items.map((f) => Mailbox.fromFields(this.#client, f)), nextCursor };
  }

  /**
   * Every address of the account (newest first) with its current token, following `nextCursor`. `limit` caps the
   * total number yielded. A cursor the API already returned throws InvalidResponseError instead of looping.
   */
  async *list(options: { limit?: number | null; pageSize?: number | null } = {}): AsyncGenerator<LoadedMailbox, void, undefined> {
    const limit = options.limit ?? null;
    const seen = new Set<string>();
    let cursor: string | null = null;
    let n = 0;
    const size = options.pageSize ?? (limit ? Math.min(limit, 100) : 50);
    for (;;) {
      const page: MailboxPage = await this.listPage({ cursor, pageSize: size });
      for (const mb of page.items) {
        if (limit !== null && n >= limit) return;
        yield mb;
        n += 1;
      }
      if (!page.nextCursor || (limit !== null && n >= limit)) return;
      checkCursor(seen, page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<LoadedMailbox> {
    return this.list();
  }
}

export interface MessagesOptions extends ops.MessageFilters {
  /** Caps the total number of messages yielded. */
  limit?: number | null;
  /** Page size, 1 to 100 (default 50, or `limit` when smaller). */
  pageSize?: number | null;
}

export interface MessagesPageOptions extends ops.MessageFilters {
  pageSize?: number | null;
  cursor?: string | null;
}

export interface WaitOptions {
  /** Milliseconds before WaitTimeoutError (default 120000). The deadline also bounds every HTTP request. */
  timeout?: number;
  /** Text in the sender name or address (server-side, case-insensitive). */
  from?: string | null;
  /** Text in the subject (server-side, case-insensitive). */
  subjectContains?: string | null;
  /** Fixed delay between polls in milliseconds (at least 500). Default: 1 s growing to 10 s. */
  pollInterval?: number | null;
  /**
   * Accept every message received strictly after this time (Unix **seconds** or a Date) instead of only messages
   * that were not in the inbox when the wait started. Use `(box.createdAt ?? 0) - 1` to include a message received
   * in the second the address was created.
   */
  since?: ops.TimeLike | null;
}

function mid(m: string | Message): string {
  return m instanceof Message ? m.id : m;
}

/**
 * One address. Every operation sends `token` in the JSON body. `email`, `domain`, ... are `null` on a mailbox built
 * with `client.mailbox(token)` until `info()`. `util.inspect`, `JSON.stringify` and `String()` never show the token.
 */
export class Mailbox {
  readonly #client: Client;
  #token: string | null;
  #web: WebAccess | null = null;
  #raw: Record<string, unknown> = {};
  #email: string | null = null;
  #domain: string | null = null;
  #isUserDomain: boolean | null = null;
  #customName: boolean | null = null;
  #createdAt: number | null = null;
  #messageCount: number | null = null;

  /** @internal Use `client.mailbox(token)` or `client.mailboxes.create()`. */
  constructor(client: Client, token: string | null) {
    this.#client = client;
    this.#token = token;
  }

  /** @internal */
  static fromFields(client: Client, f: MailboxFields): LoadedMailbox {
    const mb = new Mailbox(client, null);
    mb.#set(f);
    return mb as LoadedMailbox;
  }

  #set(f: MailboxFields): void {
    this.#email = f.email;
    this.#domain = f.domain;
    this.#isUserDomain = f.isUserDomain;
    this.#customName = f.customName;
    this.#createdAt = f.createdAt;
    if (f.messageCount !== null) this.#messageCount = f.messageCount;
    // Always the value of the response, also when it is null (never keep an older token).
    this.#token = f.token;
    this.#web = f.web;
    this.#raw = f.raw;
  }

  get email(): string | null {
    return this.#email;
  }
  get domain(): string | null {
    return this.#domain;
  }
  get isUserDomain(): boolean | null {
    return this.#isUserDomain;
  }
  get customName(): boolean | null {
    return this.#customName;
  }
  /** Unix seconds (server time). */
  get createdAt(): number | null {
    return this.#createdAt;
  }
  get messageCount(): number | null {
    return this.#messageCount;
  }
  /** The address token: the key to the address. Store it to use the address later; treat it like a password. */
  get token(): string | null {
    return this.#token;
  }
  /** Tokens the tmailor.com website uses, or `null`. Treat them like passwords. */
  get web(): WebAccess | null {
    return this.#web;
  }
  /** The Mailbox JSON object as received (contains the token). */
  get raw(): Record<string, unknown> {
    return this.#raw;
  }

  toJSON(): Record<string, unknown> {
    return {
      email: this.#email,
      domain: this.#domain,
      isUserDomain: this.#isUserDomain,
      customName: this.#customName,
      createdAt: this.#createdAt,
      messageCount: this.#messageCount,
      token: maskToken(this.#token),
      web: this.#web === null ? null : this.#web.toJSON(),
    };
  }

  toString(): string {
    const q = (v: string | null): string => (v === null ? "null" : `'${v}'`);
    return (
      `Mailbox { email: ${q(this.#email)}, domain: ${q(this.#domain)}, createdAt: ${this.#createdAt}, ` +
      `messageCount: ${this.#messageCount}, token: ${q(maskToken(this.#token))} }`
    );
  }

  [INSPECT](): string {
    return this.toString();
  }

  /** Reload the address (`messageCount`, current tokens). Updates this object and returns it. */
  async info(): Promise<this & LoadedMailbox> {
    this.#set(await this.#client.call(ops.mailboxInfo(this.#token), parseMailboxFields));
    return this as this & LoadedMailbox;
  }

  #page(f: MessagesPageOptions, opts: RequestOptions = {}): Promise<MessagePage> {
    const spec = ops.mailboxMessages(this.#token, {
      unread: f.unread,
      from: f.from,
      subject: f.subject,
      since: f.since,
      size: f.pageSize,
      cursor: f.cursor,
    });
    return this.#client.call(spec, MessagePage.fromApi, opts);
  }

  /** One page of messages (newest first) with `total` and `nextCursor`. Items have no body. */
  messagesPage(options: MessagesPageOptions = {}): Promise<MessagePage> {
    return this.#page(options);
  }

  /**
   * Messages of the last 24 hours, newest first, following the cursor (`for await`). Filters run on the server:
   * `unread`, `from` (text in sender name or address), `subject` (text in subject), `since` (Unix seconds or a Date;
   * EXCLUSIVE: only `receivedAt > since`). Items have no body: use `message(id)`.
   */
  async *messages(options: MessagesOptions = {}): AsyncGenerator<Message, void, undefined> {
    const limit = options.limit ?? null;
    const seen = new Set<string>();
    let cursor: string | null = null;
    let n = 0;
    const size = options.pageSize ?? (limit ? Math.min(limit, 100) : 50);
    for (;;) {
      const page: MessagePage = await this.#page({
        unread: options.unread,
        from: options.from,
        subject: options.subject,
        since: options.since,
        pageSize: size,
        cursor,
      });
      for (const m of page.items) {
        if (limit !== null && n >= limit) return;
        yield m;
        n += 1;
      }
      if (!page.nextCursor || (limit !== null && n >= limit)) return;
      checkCursor(seen, page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  /**
   * Read one message with `text`, sanitized `html` and the `otp`/`codes`/`links` found by the API. This marks the
   * message as read (`seen` is true in the result and in later lists). There is no separate "mark as read" call.
   */
  message(messageId: string | Message): Promise<Message> {
    return this.#client.call(ops.mailboxMessage(this.#token, mid(messageId)), Message.fromApiWithBody);
  }

  /** Delete one message. */
  async deleteMessage(messageId: string | Message): Promise<void> {
    await this.#client.request(ops.mailboxMessageDelete(this.#token, mid(messageId)));
  }

  /** Delete every message. Returns how many were deleted. */
  clear(): Promise<number> {
    return this.#client.call(ops.mailboxClear(this.#token), parseDeleted);
  }

  /** Delete the address like "Delete" on tmailor.com. Quota is not returned; all tokens stop working. */
  async delete(): Promise<void> {
    await this.#client.request(ops.mailboxDelete(this.#token));
  }

  /**
   * One page for waitForMessage. A 429 RateLimited is not retried by the transport (no fresh retry budget per poll):
   * the plan sleeps Retry-After (at least 1 s) when it fits before the deadline, otherwise the wait times out.
   */
  async #waitPage(plan: WaitPlan, f: MessagesPageOptions): Promise<MessagePage> {
    const c = this.#client;
    for (;;) {
      let retryAfter: number | null;
      try {
        return await this.#page({ ...f, pageSize: 100 }, { deadline: plan.deadline, retry429: false });
      } catch (e) {
        if (!(e instanceof RateLimitedError)) throw e;
        retryAfter = e.retryAfter;
      }
      const d = plan.rateLimitDelay(c.clock.now(), retryAfter);
      if (d === null) throw new WaitTimeoutError();
      await c.clock.sleep(d);
    }
  }

  /**
   * Poll until a NEW matching message arrives and return it with its body (it is then marked as read).
   *
   * "New" means not in the inbox when the wait started (the ids of ALL current messages are recorded first, without
   * filters). Pass `since` instead to accept every message received strictly after it. `from` and
   * `subjectContains` filter the polls on the server. The delay grows from 1 s to 10 s (or is fixed with
   * `pollInterval`) and slows down when `X-RateLimit-Remaining` gets low or the API answers 429. No sleep, retry or
   * request goes past `timeout`. Throws WaitTimeoutError after `timeout` (`timeout: 0` sends nothing).
   */
  async waitForMessage(options: WaitOptions = {}): Promise<Message> {
    const c = this.#client;
    const plan = new WaitPlan(options.timeout ?? 120_000, options.pollInterval, c.clock.now());
    const sinceTs = ops.unixTime(options.since);
    const baseline = new Set<string>();
    if (sinceTs === null) {
      // The baseline lists every current message WITHOUT from/subject (conformance rule 5).
      let cursor: string | null = null;
      const seen = new Set<string>();
      for (;;) {
        const page: MessagePage = await this.#waitPage(plan, { cursor });
        for (const m of page.items) baseline.add(m.id);
        if (!page.nextCursor) break;
        checkCursor(seen, page.nextCursor);
        cursor = page.nextCursor;
      }
    }
    for (;;) {
      const page = await this.#waitPage(plan, { from: options.from, subject: options.subjectContains, since: sinceTs });
      const fresh = page.items.filter((m) => !baseline.has(m.id));
      if (fresh.length > 0) {
        let first = fresh[0] as Message;
        for (const m of fresh) {
          if (m.receivedAt < first.receivedAt || (m.receivedAt === first.receivedAt && m.id < first.id)) first = m;
        }
        return c.call(ops.mailboxMessage(this.#token, first.id), Message.fromApiWithBody, { deadline: plan.deadline });
      }
      const delay = plan.nextDelay(c.clock.now(), c.clock.wallNow(), c.lastRateLimit);
      if (delay === null) throw new WaitTimeoutError();
      await c.clock.sleep(delay);
    }
  }
}
