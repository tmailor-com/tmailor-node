// The API key and address tokens never appear in util.inspect, JSON.stringify, String() or error output.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { inspect } from "node:util";

import { APIConnectionError, MailboxNotFoundError, MissingKeyError, TmailorError, type Mailbox } from "../src/index.js";
import { KEY, TOKEN, json, mailboxBody, testClient, withEnv } from "./helpers.js";

const SECRETS = ["SUPERSECRET", "SECRET-ADDRESS-TOKEN", "SECRET-TRANSFER"];

function render(x: unknown): string {
  return [inspect(x, { depth: 10, showHidden: false }), JSON.stringify(x), String(x)].join("\n");
}

function assertClean(text: string): void {
  for (const s of SECRETS) assert.ok(!text.includes(s), `secret ${s} leaked in: ${text.slice(0, 300)}`);
}

test("client, mailbox, web access and API errors never show secrets", async () => {
  const { client } = testClient([
    json(201, mailboxBody(TOKEN)),
    json(404, { error: { code: "MailboxNotFound", message: "Mailbox not found", description: "", request_id: "r" } }),
  ]);
  const box = await client.mailboxes.create();
  let err: unknown;
  try {
    await box.info();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof MailboxNotFoundError);
  const texts = [
    render(client),
    render(box),
    render(box.web),
    render([box]),
    render({ box }),
    render(err),
    (err as Error).stack ?? "",
    JSON.stringify((err as TmailorError).body),
    JSON.stringify((err as TmailorError).headers),
  ].join("\n");
  assertClean(texts);
  assert.ok(render(client).includes("tmk_live_abcdefabcdef_***"));
  assert.equal(JSON.parse(JSON.stringify(box)).token, "***");
  assert.deepEqual(JSON.parse(JSON.stringify(box.web)), { accessToken: "***", transferToken: "***", reuseUrl: "***" });
  // Still usable through the accessors.
  assert.equal(box.token, TOKEN);
  assert.equal(box.web?.accessToken, TOKEN);
  assert.ok(box.web?.transferToken.includes("SECRET-TRANSFER"));
  // Spreading or listing keys does not expose private fields either.
  assertClean(JSON.stringify({ ...box }) + Object.keys(box).join(","));
  assertClean(JSON.stringify({ ...client }) + Object.keys(client).join(","));
});

test("mailbox built from a token hides it", () => {
  const { client } = testClient([]);
  const box: Mailbox = client.mailbox(TOKEN);
  assertClean(render(box));
  assert.ok(String(box).includes("token: '***'"));
});

test("a network error does not keep the fetch error (it can reference request headers)", async () => {
  const leaky = new TypeError("fetch failed", {
    cause: Object.assign(new Error(`socket hang up Authorization: Bearer ${KEY} body {"token":"${TOKEN}"}`), {
      code: "ECONNRESET",
    }),
  });
  const { client } = testClient([leaky], { maxRetries: 0 });
  let err: unknown;
  try {
    await client.mailbox(TOKEN).delete();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof APIConnectionError);
  assert.equal((err as APIConnectionError).status, null);
  assert.equal((err as APIConnectionError).code, "ConnectionError");
  assert.equal((err as { cause?: unknown }).cause, undefined);
  assertClean(render(err) + ((err as Error).stack ?? ""));
});

test("a 2xx body that breaks the schema is not kept in the error", async () => {
  const { client } = testClient([json(200, mailboxBody(TOKEN, { created_at: "yesterday" }), { "X-Request-Id": "rid-x" })]);
  let err: unknown;
  try {
    await client.mailbox(TOKEN).info();
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof TmailorError);
  const e = err as TmailorError;
  assert.equal(e.code, "InvalidResponse");
  assert.equal(e.status, 200);
  assert.equal(e.requestId, "rid-x");
  assert.ok(e.message.includes("created_at"));
  assert.deepEqual(e.body, {});
  assertClean(render(e) + (e.stack ?? ""));
  assert.ok(!render(e).includes("yesterday"));
});

test("cut JSON on a 2xx response: InvalidResponse without the body", async () => {
  const { client } = testClient([new Response(`{"token":"${TOKEN}","email":"a@`, { status: 200 })]);
  await assert.rejects(client.mailbox(TOKEN).info(), (e: unknown) => {
    assert.ok(e instanceof TmailorError && e.code === "InvalidResponse");
    assertClean(render(e) + ((e as Error).stack ?? ""));
    return true;
  });
});

test("missing key: deferred to the first call that needs it, nothing is sent", async () => {
  await withEnv({ TMAILOR_API_KEY: undefined }, async () => {
    const { client, sent } = testClient([json(200, { status: "ok", time: 1, version: "1.3.0" })], { apiKey: undefined });
    await assert.rejects(client.me(), (e: unknown) => e instanceof MissingKeyError && e.code === "MissingKey" && e.status === null);
    assert.equal(sent.length, 0);
    const h = await client.health();
    assert.equal(h.status, "ok");
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.init.headers["Authorization"], undefined);
  });
});

test("health never sends the key, other calls send Bearer, User-Agent and Accept", async () => {
  const { client, sent } = testClient([json(200, { status: "ok", time: 1, version: "1.3.0" }), json(200, { status: "ok", time: 1, version: "v" })]);
  await client.health();
  await assert.rejects(client.me()); // a health body is not a Me (headers are still recorded)
  assert.equal(sent[0]?.init.headers["Authorization"], undefined);
  assert.equal(sent[1]?.init.headers["Authorization"], `Bearer ${KEY}`);
  assert.match(sent[1]?.init.headers["User-Agent"] ?? "", /^tmailor-node\/\d+\.\d+\.\d+ \(node /);
  assert.equal(sent[1]?.init.headers["Accept"], "application/json");
  assert.equal(sent[1]?.init.redirect, "manual");
});

test("tokens go in the JSON body only", async () => {
  const { client, sent } = testClient([json(200, { items: [], next_cursor: null, total: 0 })]);
  for await (const _ of client.mailbox(TOKEN).messages({ unread: true })) {
    /* empty */
  }
  const s = sent[0];
  assert.ok(s);
  assert.ok(!s.url.includes(TOKEN));
  assert.ok(!Object.values(s.init.headers).some((v) => v.includes(TOKEN)));
  assert.deepEqual(JSON.parse(String(s.init.body)), { token: TOKEN, unread: true, limit: 50 });
});
