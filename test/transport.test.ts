// The default transport (global fetch) against a local HTTP server on 127.0.0.1: headers, timeouts (also while the
// body is still arriving), refused connections, dropped connections, and the wait deadline on the real clock.
import { strict as assert } from "node:assert";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";

import { APIConnectionError, APITimeoutError, Client, WaitTimeoutError } from "../src/index.js";
import { realClock, type Clock } from "../src/core.js";
import { KEY, TOKEN } from "./helpers.js";

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

let server: Server;
let base = "";
let handler: Handler = (_req, res) => res.end();
let hits = 0;

before(async () => {
  server = createServer((req, res) => {
    hits += 1;
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString("utf8")));
    req.on("end", () => handler(req, res, body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function client(extra: { timeout?: number; maxRetries?: number; clock?: Clock; baseUrl?: string } = {}): Client {
  return new Client({ apiKey: KEY, baseUrl: base, allowUntrustedBaseUrl: true, ...extra });
}

function recordingSleepClock(sleeps: number[]): Clock {
  return { ...realClock, sleep: async (ms: number) => void sleeps.push(ms) };
}

test("real fetch: request line, headers and JSON body", async () => {
  hits = 0;
  let seen: { method?: string; url?: string; headers?: IncomingMessage["headers"]; body?: string } = {};
  handler = (req, res, body) => {
    seen = { method: req.method, url: req.url, headers: req.headers, body };
    res.writeHead(200, { "Content-Type": "application/json", "X-RateLimit-Limit": "60", "X-RateLimit-Remaining": "59", "X-RateLimit-Reset": "1760342460" });
    res.end(JSON.stringify({ items: [], next_cursor: null, total: 0 }));
  };
  const c = client();
  const page = await c.mailbox(TOKEN).messagesPage({ subject: "verify", pageSize: 10 });
  assert.equal(page.total, 0);
  assert.equal(seen.method, "POST");
  assert.equal(seen.url, "/v1/mailbox/messages");
  assert.equal(seen.headers?.["authorization"], `Bearer ${KEY}`);
  assert.match(String(seen.headers?.["user-agent"]), /^tmailor-node\/0\.1\.0 /);
  assert.match(String(seen.headers?.["content-type"]), /^application\/json/);
  assert.deepEqual(JSON.parse(seen.body ?? ""), { token: TOKEN, subject: "verify", limit: 10 });
  assert.deepEqual({ ...c.lastRateLimit }, { limit: 60, remaining: 59, reset: 1760342460 });
});

test("real fetch: no response before the timeout -> APITimeoutError (safe request retried first)", async () => {
  hits = 0;
  handler = () => {
    /* never answers */
  };
  const sleeps: number[] = [];
  const c = client({ timeout: 150, maxRetries: 1, clock: recordingSleepClock(sleeps) });
  await assert.rejects(c.me(), (e: unknown) => e instanceof APITimeoutError && e.code === "Timeout" && e.status === null);
  assert.equal(hits, 2);
  assert.equal(sleeps.length, 1);
});

test("real fetch: the timeout also covers a body that trickles in", async () => {
  handler = (_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write('{"status":"ok",');
    // the rest never comes
  };
  const c = client({ timeout: 200, maxRetries: 0 });
  const t0 = Date.now();
  await assert.rejects(c.health(), APITimeoutError);
  assert.ok(Date.now() - t0 < 2000);
});

test("real fetch: connection refused is a connect failure, retried even for an unsafe request", async () => {
  const tmp = createServer();
  await new Promise<void>((resolve) => tmp.listen(0, "127.0.0.1", resolve));
  const port = (tmp.address() as AddressInfo).port;
  await new Promise<void>((resolve) => tmp.close(() => resolve()));
  const sleeps: number[] = [];
  const c = client({ baseUrl: `http://127.0.0.1:${port}`, maxRetries: 1, clock: recordingSleepClock(sleeps) });
  await assert.rejects(c.mailbox(TOKEN).delete(), (e: unknown) => {
    assert.ok(e instanceof APIConnectionError && !(e instanceof APITimeoutError));
    assert.equal(e.code, "ConnectionError");
    assert.match(e.message, /^Connection failed \(ECONNREFUSED\)$/);
    return true;
  });
  assert.equal(sleeps.length, 1);
});

test("real fetch: connection dropped after sending is not retried for an unsafe request", async () => {
  hits = 0;
  handler = (req) => req.socket.destroy();
  const sleeps: number[] = [];
  const c = client({ maxRetries: 2, clock: recordingSleepClock(sleeps) });
  await assert.rejects(c.mailbox(TOKEN).delete(), (e: unknown) => e instanceof APIConnectionError && e.code === "ConnectionError");
  assert.equal(hits, 1);
  assert.equal(sleeps.length, 0);
});

test("real clock: a slow poll is cut at the wait deadline (WaitTimeoutError)", async () => {
  handler = (_req, res) => {
    setTimeout(() => {
      if (!res.destroyed) res.end(JSON.stringify({ items: [], next_cursor: null, total: 0 }));
    }, 3000).unref();
  };
  const c = client({ timeout: 30_000 });
  const t0 = Date.now();
  await assert.rejects(c.mailbox(TOKEN).waitForMessage({ timeout: 300, since: 1 }), WaitTimeoutError);
  const took = Date.now() - t0;
  assert.ok(took >= 250 && took < 1500, `took ${took} ms`);
});
