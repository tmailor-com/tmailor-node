// Retry rules, backoff, wait plan, argument validation, pagination helpers.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  APIConnectionError,
  DailyCapReachedError,
  InternalServerError,
  RateLimitedError,
  TmailorError,
  VERSION,
  WaitTimeoutError,
  type Mailbox,
} from "../src/index.js";
import { CacheUnavailableError } from "../src/errors.js";
import { backoff, retryDelay, withinDeadline, requestTimeout, RateLimitInfo } from "../src/core.js";
import * as ops from "../src/ops.js";
import { WaitPlan } from "../src/wait.js";
import { TOKEN, json, mailboxBody, testClient } from "./helpers.js";

const GET = ops.me();
const UNSAFE = ops.mailboxDelete("t");

function e429(retryAfter: number | null, code = "RateLimited"): TmailorError {
  return new (code === "DailyCapReached" ? DailyCapReachedError : RateLimitedError)("x", { code, status: 429, retryAfter });
}

test("retryDelay rules", () => {
  const o = { maxRetries: 2, maxRetryWait: 60_000 };
  assert.equal(retryDelay(UNSAFE, 0, { ...o, error: e429(5) }), 5000);
  assert.equal(retryDelay(UNSAFE, 0, { ...o, error: e429(0) }), 1000); // never a busy retry
  assert.equal(retryDelay(UNSAFE, 0, { ...o, error: e429(61) }), null); // above maxRetryWait
  assert.equal(retryDelay(GET, 0, { ...o, error: e429(5, "DailyCapReached") }), null);
  const b = retryDelay(GET, 0, { ...o, error: e429(null) });
  assert.ok(b !== null && b >= 250 && b <= 500);
  const s500 = new InternalServerError("x", { code: "HTTP500", status: 500 });
  assert.ok((retryDelay(GET, 1, { ...o, error: s500 }) ?? 0) >= 500);
  assert.equal(retryDelay(UNSAFE, 0, { ...o, error: s500 }), null);
  const cache = new CacheUnavailableError("x", { code: "CacheUnavailable", status: 503 });
  assert.equal(retryDelay(GET, 0, { ...o, error: cache }), null);
  const net = new APIConnectionError("x");
  assert.equal(retryDelay(UNSAFE, 0, { ...o, error: net }), null);
  assert.ok(retryDelay(UNSAFE, 0, { ...o, error: net, connectFailed: true }) !== null);
  assert.equal(retryDelay(GET, 2, { ...o, error: s500 }), null); // retries used up
});

test("backoff bounds: [c/2, c], c = min(8 s, 0.5 s * 2^n)", () => {
  assert.equal(backoff(0, () => 0), 250);
  assert.equal(backoff(0, () => 1), 500);
  assert.equal(backoff(3, () => 1), 4000);
  assert.equal(backoff(10, () => 1), 8000);
  assert.equal(backoff(10, () => 0), 4000);
});

test("withinDeadline and requestTimeout", () => {
  assert.equal(withinDeadline(1000, 0, null), 1000);
  assert.equal(withinDeadline(1000, 0, 1000), null);
  assert.equal(withinDeadline(999, 0, 1000), 999);
  assert.deepEqual(requestTimeout(30_000, 0, null), { timeout: 30_000, deadlineBound: false });
  assert.deepEqual(requestTimeout(30_000, 0, 5000), { timeout: 5000, deadlineBound: true });
  assert.deepEqual(requestTimeout(5000, 0, 5000), { timeout: 5000, deadlineBound: true });
  assert.throws(() => requestTimeout(30_000, 5000, 5000), WaitTimeoutError);
});

test("WaitPlan: growth 1.5x to 10 s, fixed interval, deadline, rate limits", () => {
  const p = new WaitPlan(120_000, null, 0);
  const got = Array.from({ length: 8 }, () => p.nextDelay(0, 0, null));
  assert.deepEqual(got, [1000, 1500, 2250, 3375, 5062.5, 7593.75, 10000, 10000]);
  const f = new WaitPlan(120_000, 100, 0);
  assert.equal(f.nextDelay(0, 0, null), 500); // at least 0.5 s
  const d = new WaitPlan(3000, null, 0);
  assert.equal(d.nextDelay(1500, 0, null), 500); // capped so the next poll starts 1 s before the deadline
  assert.equal(d.nextDelay(2000, 0, null), null);
  const r = new WaitPlan(120_000, null, 0);
  assert.equal(r.nextDelay(0, 1_000_000, new RateLimitInfo(30, 1, 1020)), 20_500); // remaining <= 2: wait for reset
  const s = new WaitPlan(120_000, null, 0);
  assert.equal(s.nextDelay(0, 1_000_000, new RateLimitInfo(100, 12, 1050)), 5_050); // spread 50.5 s over 10 requests
  assert.throws(() => new WaitPlan(-1, null, 0), RangeError);
  assert.throws(() => new WaitPlan(1000, 0, 0), RangeError);
  assert.throws(() => new WaitPlan(1000, -5, 0), RangeError);
});

test("argument validation and conversions", async () => {
  assert.throws(() => ops.mailboxesList(null, 0), RangeError);
  assert.throws(() => ops.mailboxesList(null, 101), RangeError);
  assert.throws(() => ops.mailboxesList(null, 2.5), RangeError);
  assert.throws(() => ops.mailboxesCreate(null, null, ""), RangeError);
  assert.throws(() => ops.mailboxesCreate(null, null, "has space"), RangeError);
  assert.throws(() => ops.mailboxesCreate(null, null, "x".repeat(129)), RangeError);
  assert.match(ops.mailboxesCreate().headers["Idempotency-Key"] ?? "", /^[0-9a-f-]{36}$/);
  assert.equal(ops.unixTime(new Date(1760342400_999)), 1760342400);
  assert.equal(ops.unixTime(1760342400.9), 1760342400);
  assert.equal(ops.unixTime(null), null);
  assert.throws(() => ops.unixTime(Number.NaN), RangeError);
  assert.throws(() => ops.unixTime("1" as unknown as number), TypeError);
  assert.equal(ops.dateParam(new Date(2026, 9, 5, 12), "from"), "2026-10-05");
  assert.equal(ops.dateParam("2026-10-01", "from"), "2026-10-01");
  assert.deepEqual(ops.usage("2026-10-01").query, { from: "2026-10-01" });
  assert.throws(() => ops.mailboxMessage("t", ""), TypeError);
  assert.throws(() => ops.mailboxInfo(null), (e: unknown) => e instanceof TmailorError && e.code === "NoToken");
  const { client, sent } = testClient([]);
  await assert.rejects(client.mailbox(TOKEN).waitForMessage({ timeout: -1 }), RangeError);
  await assert.rejects(client.mailbox(TOKEN).waitForMessage({ timeout: 0 }), WaitTimeoutError);
  assert.equal(sent.length, 0);
  assert.equal(VERSION, "0.1.0");
});

test("create retries with the same Idempotency-Key and byte-identical body", async () => {
  const { client, sent, clock } = testClient([
    json(429, { error: { code: "RateLimited", message: "slow down", retry_after: 2 } }),
    json(201, mailboxBody(TOKEN)),
  ]);
  const box = await client.mailboxes.create({ domain: "b.example" });
  assert.equal(box.email, "a@b.example");
  assert.equal(sent.length, 2);
  assert.equal(sent[0]?.init.headers["Idempotency-Key"], sent[1]?.init.headers["Idempotency-Key"]);
  assert.equal(sent[0]?.init.body, sent[1]?.init.body);
  assert.deepEqual(clock.sleeps, [2000]);
});

test("pagination: listPage, for await over client.mailboxes, limit stops early", async () => {
  const page1 = { items: [mailboxBody(TOKEN), mailboxBody(TOKEN)], next_cursor: "c2" };
  const page2 = { items: [mailboxBody(null)], next_cursor: null };
  const { client, sent } = testClient([json(200, page1), json(200, page2), json(200, page1)]);
  const all: Mailbox[] = [];
  for await (const b of client.mailboxes) all.push(b);
  assert.equal(all.length, 3);
  assert.equal(all[2]?.token, null);
  assert.equal(new URL(sent[1]?.url ?? "").searchParams.get("cursor"), "c2");
  const got: Mailbox[] = [];
  for await (const b of client.mailboxes.list({ limit: 1 })) got.push(b);
  assert.equal(got.length, 1);
  assert.equal(new URL(sent[2]?.url ?? "").searchParams.get("limit"), "1");
  assert.equal(sent.length, 3);
});

test("a 5xx on an unsafe request is not retried", async () => {
  const { client, sent } = testClient([json(502, { error: { code: "InternalError", message: "x" } })]);
  await assert.rejects(client.mailbox(TOKEN).clear(), InternalServerError);
  assert.equal(sent.length, 1);
});

test("a bug in a custom fetch is re-thrown, not turned into a network error", async () => {
  const { client } = testClient([new RangeError("bug in my fetch wrapper")]);
  await assert.rejects(client.me(), RangeError);
});
