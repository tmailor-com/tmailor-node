/**
 * Runs one shared conformance scenario (conformance/scenarios/*.json) against the Node SDK.
 *
 * Port of `tests/conformance_runner.py` of the Python SDK; the format is described in conformance/README.md. Every
 * request the SDK sends must match the next exchange; the scenario fails if a request is unexpected, differs, or if
 * an exchange is left unused. Scenario times are seconds; the Node SDK uses milliseconds, so the runner converts.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect, isDeepStrictEqual } from "node:util";

import * as T from "../src/index.js";
import type { Clock, FetchInitLike, FetchLike, FetchResponseLike } from "../src/index.js";

/** Number of scenario files shipped with this SDK version; a smaller count means fixtures were lost. */
export const EXPECTED_SCENARIOS = 83; // Review 20b: +3 (ip_allowlist_enforced, 3xx)
export const DEFAULT_KEY = "tmk_live_c0nf0rmance01_TESTSECRETdoNotUseAnywhere0000000000000";
export const BASE_URL = "https://open-api.test";

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export interface Scenario {
  id: string;
  description?: string;
  client?: { api_key?: string; max_retries?: number; max_retry_wait?: number; timeout?: number };
  clock?: { wall_start?: number };
  call: { op: string; token?: string; args?: Record<string, Json>; then?: string };
  exchanges: Array<{ request: Record<string, Json>; response: Record<string, Json> }>;
  expect: Record<string, Json>;
}

/** `$TMAILOR_CONFORMANCE_DIR`, else the first `conformance/scenarios` found walking up from this file. */
export function scenarioDir(): string {
  const env = process.env["TMAILOR_CONFORMANCE_DIR"];
  if (env) return env;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const cand = join(dir, "conformance", "scenarios");
    if (existsSync(cand)) return cand;
    dir = resolve(dir, "..");
  }
  return join(process.cwd(), "conformance", "scenarios");
}

export function loadScenarios(): Scenario[] {
  const dir = scenarioDir();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Scenario);
}

export const ERROR_CLASSES: Record<string, new (...args: never[]) => T.TmailorError> = {
  MissingKey: T.MissingKeyError,
  InvalidKey: T.InvalidKeyError,
  KeyRevoked: T.KeyRevokedError,
  AccountLocked: T.AccountLockedError,
  IpNotAllowed: T.IpNotAllowedError,
  InvalidJson: T.InvalidJsonError,
  InvalidField: T.InvalidFieldError,
  InvalidDomain: T.InvalidDomainError,
  CustomNameNotAllowed: T.CustomNameNotAllowedError,
  InvalidName: T.InvalidNameError,
  QuotaExceeded: T.QuotaExceededError,
  MailboxNotFound: T.MailboxNotFoundError,
  MessageNotFound: T.MessageNotFoundError,
  NotFound: T.NotFoundError,
  MailboxExists: T.MailboxExistsError,
  Conflict: T.ConflictError,
  RateLimited: T.RateLimitedError,
  DailyCapReached: T.DailyCapReachedError,
  InternalServerError: T.InternalServerError,
  ServiceUnavailable: T.ServiceUnavailableError,
  NoDomainAvailable: T.NoDomainAvailableError,
  IdempotencyUnavailable: T.IdempotencyUnavailableError,
  CacheUnavailable: T.CacheUnavailableError,
  BadRequest: T.BadRequestError,
  InvalidResponse: T.InvalidResponseError,
  ConnectionError: T.APIConnectionError,
  Timeout: T.APITimeoutError,
  WaitTimeout: T.WaitTimeoutError,
  APIError: T.APIError, // Review 20b: any other HTTP error (for example a 3xx)
};

/** Fake time in milliseconds: sleeps and slow responses advance it; timers fire when it passes them. */
export class FakeClock implements Clock {
  current = 0;
  readonly sleeps: number[] = [];
  private timers = new Map<number, { due: number; fn: () => void }>();
  private nextId = 1;

  constructor(private readonly wallStartMs: number) {}

  now(): number {
    return this.current;
  }

  wallNow(): number {
    return this.wallStartMs + this.current;
  }

  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.advanceTo(this.current + ms);
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { due: this.current + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** The earliest timer due strictly before `target`, if any. */
  firstTimerBefore(target: number): { id: number; due: number; fn: () => void } | null {
    let best: { id: number; due: number; fn: () => void } | null = null;
    for (const [id, t] of this.timers) if (t.due < target && (best === null || t.due < best.due)) best = { id, ...t };
    return best;
  }

  /** Move time forward to `target`, firing the timers due before it; stop early when `stop()` becomes true. */
  advanceTo(target: number, stop: () => boolean = () => false): void {
    for (let t = this.firstTimerBefore(target); t !== null; t = this.firstTimerBefore(target)) {
      this.current = Math.max(this.current, t.due);
      this.timers.delete(t.id);
      t.fn();
      if (stop()) return;
    }
    this.current = Math.max(this.current, target);
  }
}

/** A mismatch found by the replay transport (not a network error: the SDK re-throws it). */
export class ReplayFailure extends Error {}

function networkError(code: string, message: string): TypeError {
  const cause = Object.assign(new Error(message), { code });
  return new TypeError("fetch failed", { cause });
}

function isMatcher(v: Json): v is { [k: string]: Json } {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** A `fetch` that checks each request against the scenario and answers with the canned response. */
export class Replay {
  readonly sid: string;
  i = 0;
  readonly captures: Record<string, string> = {};
  failure: string | null = null;
  readonly fetch: FetchLike;

  constructor(
    private readonly scenario: Scenario,
    private readonly clock: FakeClock,
  ) {
    this.sid = scenario.id;
    this.fetch = (url, init) => this.handle(url, init);
  }

  private fail(msg: string): never {
    if (this.failure === null) this.failure = msg;
    throw new ReplayFailure(msg);
  }

  private async handle(url: string, init: FetchInitLike): Promise<FetchResponseLike> {
    const exchanges = this.scenario.exchanges;
    if (this.i >= exchanges.length) this.fail(`${this.sid}: unexpected extra request ${init.method} ${url}`);
    const ex = exchanges[this.i] as { request: Record<string, Json>; response: Record<string, Json> };
    this.i += 1;
    const n = this.i;
    const exp = ex.request;
    const u = new URL(url);
    if (init.method !== exp["method"]) this.fail(`${this.sid}#${n}: method ${init.method} != ${String(exp["method"])}`);
    if (u.pathname !== exp["path"]) this.fail(`${this.sid}#${n}: path ${u.pathname} != ${String(exp["path"])}`);
    const query: Record<string, string> = {};
    u.searchParams.forEach((v, k) => (query[k] = v));
    if (!isDeepStrictEqual(query, exp["query"] ?? {})) {
      this.fail(`${this.sid}#${n}: query ${JSON.stringify(query)} != ${JSON.stringify(exp["query"])}`);
    }
    const headers = new Map(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
    for (const [name, matcher] of Object.entries((exp["headers"] ?? {}) as Record<string, Json>)) {
      this.checkHeader(n, name, headers.get(name.toLowerCase()), matcher);
    }
    const expJson = exp["json"] ?? null;
    if (expJson === null) {
      if (init.body !== undefined && init.body !== "") this.fail(`${this.sid}#${n}: expected no body, got one`);
    } else {
      let got: unknown;
      try {
        got = JSON.parse(String(init.body));
      } catch {
        this.fail(`${this.sid}#${n}: body is not JSON`);
      }
      if (!isDeepStrictEqual(got, expJson)) this.fail(`${this.sid}#${n}: body ${JSON.stringify(got)} != ${JSON.stringify(expJson)}`);
    }
    if ("token" in query) this.fail(`${this.sid}#${n}: token in query string`);
    for (const v of Object.values(query)) if (v.includes("conformance-token")) this.fail(`${this.sid}#${n}: token in URL`);

    const resp = ex.response;
    // "delay" = seconds the server takes. The fake clock advances by it, or only up to the request's own timeout
    // (the SDK's abort timer fires, as a real slow server would cause).
    const delay = resp["delay"];
    if (typeof delay === "number") {
      this.clock.advanceTo(this.clock.now() + delay * 1000, () => init.signal.aborted);
      if (init.signal.aborted) throw init.signal.reason ?? new DOMException("This operation was aborted", "AbortError");
    }
    if ("network_error" in resp) {
      const kind = resp["network_error"];
      if (kind === "connect") throw networkError("ECONNREFUSED", "connect ECONNREFUSED 192.0.2.1:443");
      if (kind === "timeout") throw networkError("UND_ERR_HEADERS_TIMEOUT", "Headers Timeout Error");
      throw networkError("ECONNRESET", "read ECONNRESET");
    }
    const h = new Headers((resp["headers"] ?? {}) as Record<string, string>);
    let content: string;
    if ("json" in resp) {
      content = JSON.stringify(resp["json"]);
      if (!h.has("content-type")) h.set("Content-Type", "application/json");
    } else {
      content = String(resp["body"] ?? "");
    }
    const status = resp["status"] as number;
    const nullBody = status === 204 || status === 205 || status === 304;
    return new Response(nullBody ? null : content, { status, headers: h });
  }

  private checkHeader(n: number, name: string, got: string | undefined, m: Json): void {
    const where = `${this.sid}#${n}: header ${name}`;
    if (typeof m === "string") {
      if (got !== m) this.fail(`${where}: ${JSON.stringify(got)} != ${JSON.stringify(m)}`);
    } else if (!isMatcher(m)) {
      this.fail(`${where}: bad matcher`);
    } else if (m["$absent"]) {
      if (got !== undefined) this.fail(`${where} must be absent`);
    } else if (m["$present"]) {
      if (!got) this.fail(`${where} must be present`);
    } else if ("$regex" in m) {
      if (got === undefined || !new RegExp(String(m["$regex"])).test(got)) this.fail(`${where}: ${JSON.stringify(got)} !~ ${String(m["$regex"])}`);
    } else if ("$capture" in m) {
      if (!got) this.fail(`${where} must be present`);
      this.captures[String(m["$capture"])] = got;
    } else if ("$equals" in m) {
      if (got !== this.captures[String(m["$equals"])]) this.fail(`${where}: ${JSON.stringify(got)} differs from captured value`);
    } else {
      this.fail(`${where}: unknown matcher ${JSON.stringify(m)}`);
    }
  }

  done(): string | null {
    if (this.i !== this.scenario.exchanges.length) return `${this.sid}: ${this.scenario.exchanges.length - this.i} exchange(s) not used`;
    return null;
  }
}

const SNAKE_SPECIAL: Record<string, string> = { req4xx: "req_4xx", req5xx: "req_5xx", req429: "req_429" };

function snake(k: string): string {
  return SNAKE_SPECIAL[k] ?? k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
}

/** SDK result -> JSON-like value with the API field names. */
export function toPlain(v: unknown): Json {
  if (v === undefined || v === null) return null;
  if (v instanceof T.Mailbox) {
    const d: { [k: string]: Json } = {
      email: v.email,
      domain: v.domain,
      is_user_domain: v.isUserDomain,
      custom_name: v.customName,
      created_at: v.createdAt,
      token: v.token,
      web: toPlain(v.web),
    };
    if (v.messageCount !== null) d["message_count"] = v.messageCount;
    return d;
  }
  if (v instanceof T.WebAccess) return { accesstoken: v.accessToken, transfertoken: v.transferToken, reuse_url: v.reuseUrl };
  if (v instanceof T.DomainList) return { items: v.items.map(toPlain), shared_domains_available: v.sharedDomainsAvailable };
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) out[snake(k)] = toPlain(x);
    return out;
  }
  return v as Json;
}

/** Deep subset match; returns the first difference or null. */
export function subset(sid: string, exp: Json, got: Json, path = "$"): string | null {
  if (isMatcher(exp)) {
    if (!isMatcher(got)) return `${sid}: ${path} expected object, got ${JSON.stringify(got)}`;
    for (const [k, v] of Object.entries(exp)) {
      if (!(k in got)) return `${sid}: ${path}.${k} missing in ${JSON.stringify(Object.keys(got).sort())}`;
      const r = subset(sid, v, got[k] as Json, `${path}.${k}`);
      if (r) return r;
    }
    return null;
  }
  if (Array.isArray(exp)) {
    if (!Array.isArray(got) || got.length !== exp.length) return `${sid}: ${path} expected ${exp.length} items, got ${JSON.stringify(got)}`;
    for (let i = 0; i < exp.length; i++) {
      const r = subset(sid, exp[i] as Json, got[i] as Json, `${path}[${i}]`);
      if (r) return r;
    }
    return null;
  }
  return exp === got ? null : `${sid}: ${path} ${JSON.stringify(got)} != ${JSON.stringify(exp)}`;
}

function camel(k: string): string {
  return k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

/** Neutral scenario args -> Node option object (seconds -> milliseconds where the Node API uses ms). */
function nodeArgs(op: string, args: Record<string, Json>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (op === "mailbox.wait_for_message" && (k === "timeout" || k === "poll_interval") && typeof v === "number") {
      out[camel(k)] = v * 1000;
    } else {
      out[camel(k)] = v;
    }
  }
  return out;
}

export interface Run {
  client: T.Client;
  replay: Replay;
  clock: FakeClock;
}

export function makeClient(scn: Scenario): Run {
  const cfg = scn.client ?? {};
  const clock = new FakeClock((scn.clock?.wall_start ?? 1760342400) * 1000);
  const replay = new Replay(scn, clock);
  const client = new T.Client({
    apiKey: cfg.api_key ?? DEFAULT_KEY,
    baseUrl: BASE_URL,
    allowUntrustedBaseUrl: true, // fake host
    fetch: replay.fetch,
    clock,
    maxRetries: cfg.max_retries ?? 2,
    maxRetryWait: (cfg.max_retry_wait ?? 60) * 1000,
    timeout: (cfg.timeout ?? 30) * 1000,
  });
  return { client, replay, clock };
}

async function collect<X>(it: AsyncIterable<X>): Promise<X[]> {
  const out: X[] = [];
  for await (const x of it) out.push(x);
  return out;
}

type MailboxMethod = (this: T.Mailbox, ...a: unknown[]) => Promise<unknown>;

/** Returns [result, mailbox or null, error or null]. */
export async function callOp(client: T.Client, scn: Scenario): Promise<[unknown, T.Mailbox | null, unknown]> {
  const op = scn.call.op;
  const a = nodeArgs(op, scn.call.args ?? {});
  let mb: T.Mailbox | null = null;
  try {
    if (op === "mailboxes.create") {
      mb = await client.mailboxes.create(a);
      return [mb, mb, null];
    }
    if (op === "mailboxes.list") return [await collect(client.mailboxes.list(a)), null, null];
    if (op.startsWith("mailbox.")) {
      mb = client.mailbox(scn.call.token ?? "");
      const name = camel(op.slice("mailbox.".length));
      let res: unknown;
      if (name === "messages") {
        res = await collect(mb.messages(a));
      } else if (name === "message" || name === "deleteMessage") {
        res = await (mb[name] as MailboxMethod).call(mb, a["messageId"]);
      } else if (name === "waitForMessage") {
        res = await mb.waitForMessage(a);
      } else {
        res = await ((mb as unknown as Record<string, MailboxMethod>)[name] as MailboxMethod).call(mb);
      }
      const then = scn.call.then;
      if (then) await ((mb as unknown as Record<string, MailboxMethod>)[camel(then.split(".")[1] ?? "")] as MailboxMethod).call(mb);
      return [res, mb, null];
    }
    if (op === "usage") return [await client.usage(a), null, null];
    const fn = (client as unknown as Record<string, () => Promise<unknown>>)[op];
    if (typeof fn !== "function") throw new ReplayFailure(`${scn.id}: unknown op ${op}`);
    return [await fn.call(client), null, null];
  } catch (e) {
    return [null, mb, e];
  }
}

const SECRETS = [DEFAULT_KEY, "TESTSECRET", "conformance-token"];

/** Runs one scenario; returns the list of failures (empty = pass). */
export async function runScenario(scn: Scenario): Promise<string[]> {
  const { client, replay, clock } = makeClient(scn);
  const [outcome, mailbox, err] = await callOp(client, scn);
  const sid = scn.id;
  const fails: string[] = [];
  if (replay.failure) return [replay.failure];
  if (err instanceof ReplayFailure) return [err.message];
  const left = replay.done();
  if (left) fails.push(left);
  const exp = scn.expect;
  if ("error" in exp) {
    const e = exp["error"] as Record<string, Json>;
    const cls = ERROR_CLASSES[String(e["class"])];
    if (err === null) {
      fails.push(`${sid}: expected ${String(e["class"])}, got result ${inspect(outcome)}`);
    } else if (!cls || !(err instanceof cls)) {
      fails.push(`${sid}: ${inspect(err)} is not ${String(e["class"])}`);
    } else if (!(err instanceof T.TmailorError)) {
      fails.push(`${sid}: not a TmailorError`);
    } else {
      if (err.code !== e["code"]) fails.push(`${sid}: code ${err.code} != ${String(e["code"])}`);
      if (err.status !== e["status"]) fails.push(`${sid}: status ${err.status} != ${String(e["status"])}`);
      if ("request_id" in e && err.requestId !== e["request_id"]) fails.push(`${sid}: request_id ${err.requestId} != ${String(e["request_id"])}`);
      if ("retry_after" in e && err.retryAfter !== e["retry_after"]) fails.push(`${sid}: retry_after ${err.retryAfter} != ${String(e["retry_after"])}`);
      if ("message" in e && err.message !== e["message"]) fails.push(`${sid}: message ${JSON.stringify(err.message)} != ${JSON.stringify(e["message"])}`);
      if ("secret_changed" in e && !(err instanceof T.CacheUnavailableError && err.secretChanged === e["secret_changed"])) {
        fails.push(`${sid}: secret_changed`);
      }
      if ("reason" in e && !(err instanceof T.InvalidNameError && err.reason === e["reason"])) fails.push(`${sid}: reason`);
      const text = `${String(err)} ${err.stack ?? ""} ${inspect(err, { depth: 5 })} ${JSON.stringify(err)} ${JSON.stringify(err.body)} ${JSON.stringify(err.headers)}`;
      if (SECRETS.some((s) => text.includes(s))) fails.push(`${sid}: secret in error`);
      if ((err as { cause?: unknown }).cause !== undefined) fails.push(`${sid}: error keeps a cause`);
    }
  } else {
    if (err !== null) {
      fails.push(`${sid}: unexpected error ${inspect(err)}`);
    } else {
      const r = subset(sid, exp["result"] ?? null, toPlain(outcome));
      if (r) fails.push(r);
      const msg = outcome as T.Message;
      if ("otp" in exp && msg.otp !== exp["otp"]) fails.push(`${sid}: otp ${JSON.stringify(msg.otp)} != ${JSON.stringify(exp["otp"])}`);
      for (const k of ["codes", "links"] as const) {
        if (k in exp && !isDeepStrictEqual(msg[k], exp[k])) fails.push(`${sid}: ${k} ${JSON.stringify(msg[k])} != ${JSON.stringify(exp[k])}`);
      }
    }
  }
  const sleeps = clock.sleeps.map((ms) => ms / 1000);
  if ("sleeps" in exp) {
    const want = exp["sleeps"] as number[];
    if (sleeps.length !== want.length || sleeps.some((s, i) => Math.abs(s - (want[i] as number)) >= 1e-6)) {
      fails.push(`${sid}: sleeps ${JSON.stringify(sleeps)} != ${JSON.stringify(want)}`);
    }
  }
  if ("elapsed_max" in exp && clock.now() / 1000 > (exp["elapsed_max"] as number) + 1e-6) {
    fails.push(`${sid}: elapsed ${clock.now() / 1000} > ${String(exp["elapsed_max"])}`);
  }
  if ("sleep_count" in exp && sleeps.length !== exp["sleep_count"]) fails.push(`${sid}: ${sleeps.length} sleeps != ${String(exp["sleep_count"])}`);
  if ("rate_limit" in exp) {
    const rl = client.lastRateLimit;
    const got = rl === null ? null : { limit: rl.limit, remaining: rl.remaining, reset: rl.reset };
    if (!isDeepStrictEqual(got, exp["rate_limit"])) fails.push(`${sid}: rate_limit ${JSON.stringify(got)} != ${JSON.stringify(exp["rate_limit"])}`);
  }
  if ("mailbox" in exp) {
    const want = (exp["mailbox"] as Record<string, Json> | null)?.["token"] ?? null;
    if (mailbox === null || mailbox.token !== want) fails.push(`${sid}: mailbox token not updated`);
    if (mailbox !== null) {
      const shown = `${inspect(mailbox)} ${JSON.stringify(mailbox)} ${String(mailbox)}`;
      if (shown.includes("conformance-token")) fails.push(`${sid}: token in inspect/JSON/String`);
    }
  }
  return fails;
}
