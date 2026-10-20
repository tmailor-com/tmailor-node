// Strict schema readers: exact JSON types, no coercion, null only where the spec allows it.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { InvalidResponseError, Me, Message, type Mailbox } from "../src/index.js";
import { parseStrictJson } from "../src/json.js";
import { parseMailboxFields } from "../src/models.js";
import { SchemaError } from "../src/schema.js";
import { ME_OK, TOKEN, json, mailboxBody, testClient } from "./helpers.js";

const DROP = Symbol("drop");

function bad(base: unknown, path: string[], value: unknown): unknown {
  const out = structuredClone(base) as Record<string, unknown>;
  let cur: Record<string, unknown> = out;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  const last = path[path.length - 1] as string;
  if (value === DROP) delete cur[last];
  else cur[last] = value;
  return out;
}

test("Me parses a valid body (camelCase fields, raw hidden)", () => {
  const me = Me.fromApi(parseStrictJson(JSON.stringify({ ...ME_OK, extra_field: 1.5 })));
  assert.equal(me.userId, 12);
  assert.equal(me.limits.maxIp, 1);
  assert.equal(me.subscriptions[0]?.quota, 100);
  assert.equal(me.key.prefix, "abcdefabcdef");
  assert.equal(me.raw["extra_field"], 1.5); // unknown fields stay reachable (a float there is fine)
  assert.ok(!Object.keys(me).includes("raw"));
  assert.ok(!JSON.stringify(me).includes("extra_field"));
});

const REJECT: Array<[string[], unknown]> = [
  [["user_id"], "12"], // no "12" -> 12
  [["user_id"], true], // a boolean is not an integer
  [["user_id"], 12.5],
  [["user_id"], null], // not nullable
  [["key"], DROP], // required
  [["limits", "max_ip"], "x"],
  [["ip_allowlist"], null],
  [["ip_allowlist"], [1]],
  [["subscriptions"], [{ plan: "free" }]],
  [["subscriptions"], {}],
];

for (const [path, value] of REJECT) {
  test(`Me rejects ${path.join(".")} = ${typeof value === "symbol" ? "(missing)" : JSON.stringify(value)}`, () => {
    assert.throws(
      () => Me.fromApi(bad(ME_OK, path, value)),
      (e: unknown) => {
        assert.ok(e instanceof SchemaError);
        assert.ok(e.message.includes(path[path.length - 1] as string), e.message); // names the field
        if (typeof value === "string") assert.ok(!e.message.replace(path[path.length - 1] as string, "").includes(value));
        return true;
      },
    );
  });
}

test("an integer written as 1.0 or 1e0 is not an integer (same as the other SDKs)", () => {
  const text = JSON.stringify(ME_OK).replace('"user_id":12', '"user_id":12.0');
  assert.throws(() => Me.fromApi(parseStrictJson(text)), /user_id must be an integer/);
  const text2 = JSON.stringify(ME_OK).replace('"max_ip":1', '"max_ip":1e0');
  assert.throws(() => Me.fromApi(parseStrictJson(text2)), /max_ip must be an integer/);
  // A string that looks like a float is not touched, and plain integers parse as usual.
  const v = parseStrictJson('{"a":"1.0","b":[1,2.5],"c":3}') as Record<string, unknown>;
  assert.deepEqual(v, { a: "1.0", b: [1, 2.5], c: 3 });
  assert.throws(() => parseStrictJson("{bad"), SyntaxError);
});

test("Mailbox schema relations: token and web together, token equals web.accesstoken", () => {
  assert.equal(parseMailboxFields(mailboxBody(TOKEN)).token, TOKEN);
  assert.equal(parseMailboxFields(mailboxBody(null)).web, null);
  const bodies = [
    mailboxBody(TOKEN, { web: null }),
    mailboxBody(null, { web: { accesstoken: "a", transfertoken: "b", reuse_url: "c" } }),
    mailboxBody(TOKEN, { web: { accesstoken: "eyJ.OTHER.sig", transfertoken: "b", reuse_url: "c" } }),
    mailboxBody(TOKEN, { message_count: null }), // present but null
    mailboxBody(TOKEN, { is_user_domain: "false" }), // "false" is not false
    mailboxBody(TOKEN, { created_at: 1760342400.5 }),
  ];
  for (const b of bodies) assert.throws(() => parseMailboxFields(b), SchemaError);
});

test("message_count is optional: absent keeps null, present updates", async () => {
  const { client } = testClient([json(201, mailboxBody(TOKEN)), json(200, mailboxBody(TOKEN, { message_count: 3 }))]);
  const box: Mailbox = await client.mailboxes.create();
  assert.equal(box.messageCount, null);
  await box.info();
  assert.equal(box.messageCount, 3);
});

const MSG = {
  id: "m1",
  from: { name: "Shop", address: "no-reply@shop.example" },
  to: "a@b.example",
  subject: "Your code",
  received_at: 1760342410,
  expires_at: 1760428810,
  seen: false,
};

test("a list item has no body and empty otp/codes/links", () => {
  const m = Message.fromApi(MSG);
  assert.equal(m.text, null);
  assert.equal(m.bodyAvailable, null);
  assert.equal(m.hasBody, false);
  assert.equal(m.otp, null);
  assert.deepEqual(m.codes, []);
  assert.deepEqual(m.links, []);
  assert.equal(m.from.address, "no-reply@shop.example");
  assert.equal(m.receivedAt, 1760342410);
});

test("a full message: body fields required, otp/codes/links read when present", () => {
  const full = { ...MSG, seen: true, text: "Code 123456", html: null, body_available: true };
  const old = Message.fromApiWithBody(full); // older server without otp/codes/links
  assert.equal(old.otp, null);
  assert.deepEqual(old.codes, []);
  assert.equal(old.hasBody, true);
  const m = Message.fromApiWithBody({ ...full, otp: "123456", codes: ["123456"], links: ["https://x.example/v"] });
  assert.equal(m.otp, "123456");
  assert.deepEqual(m.links, ["https://x.example/v"]);
  assert.throws(() => Message.fromApiWithBody({ ...full, seen: false }), /seen must be true/);
  assert.throws(() => Message.fromApiWithBody({ ...full, otp: 123456 }), /otp must be a string or null/);
  assert.throws(() => Message.fromApiWithBody({ ...full, codes: [1] }), /codes\[0\] must be a string/);
  const { text: _t, ...noText } = full;
  assert.throws(() => Message.fromApiWithBody(noText), /text is missing/);
});

test("client turns schema errors into InvalidResponseError (status kept)", async () => {
  const { client } = testClient([json(201, {})]);
  await assert.rejects(client.mailboxes.create(), (e: unknown) => e instanceof InvalidResponseError && e.status === 201);
});

// Review 20b NODE-01: ip_allowlist_enforced is required in spec 1.3.0 (boolean, never coerced).
test("Me.ipAllowlistEnforced is read strictly", () => {
  assert.equal(Me.fromApi(ME_OK).ipAllowlistEnforced, true);
  assert.equal(Me.fromApi({ ...ME_OK, ip_allowlist_enforced: false }).ipAllowlistEnforced, false);
  for (const v of [DROP, null, "true", 1, 0]) {
    assert.throws(() => Me.fromApi(bad(ME_OK, ["ip_allowlist_enforced"], v)), (e: unknown) => {
      assert.ok(e instanceof SchemaError && e.message.includes("ip_allowlist_enforced"), String(e));
      return true;
    });
  }
});

// Review 20b NODE-02: an integer outside the safe range was rounded by JSON.parse, so it is not trusted.
test("integers must be safe integers", () => {
  const max = JSON.stringify(ME_OK).replace('"user_id":12', `"user_id":${Number.MAX_SAFE_INTEGER}`);
  assert.equal(Me.fromApi(parseStrictJson(max)).userId, Number.MAX_SAFE_INTEGER);
  for (const big of ["9007199254740992", "9007199254740993", "-9007199254740993", "1e400"]) {
    const text = JSON.stringify(ME_OK).replace('"user_id":12', `"user_id":${big}`);
    assert.throws(() => Me.fromApi(parseStrictJson(text)), /user_id must be an integer/, big);
  }
  assert.throws(() => parseMailboxFields(mailboxBody(TOKEN, { created_at: 2 ** 60 })), /created_at must be an integer/);
});

test("client: an unsafe integer in a 2xx body is InvalidResponseError", async () => {
  const text = JSON.stringify(mailboxBody(TOKEN)).replace('"created_at":1760342400', '"created_at":17603424000000000000');
  const { client } = testClient([new Response(text, { status: 200, headers: { "Content-Type": "application/json" } })]);
  await assert.rejects(client.mailbox(TOKEN).info(), (e: unknown) => e instanceof InvalidResponseError && e.status === 200);
});
