/**
 * Live tests against the real API. Opt-in: `npm run test:live` (never part of `npm test`), and skipped unless
 * TMAILOR_API_KEY is set.
 *
 *   TMAILOR_API_KEY          an API key whose allowlist contains this machine's public IP
 *   TMAILOR_BASE_URL         optional, default https://open-api.tmailor.com
 *   TMAILOR_LIVE_SEND_CMD    optional command that delivers ONE email to an address; `{to}` is replaced by the
 *                            address. Without it the receive part is skipped.
 *   TMAILOR_LIVE_EXPECT_OTP  optional code that the sent email contains (checked with message.otp).
 *
 * Each run creates one address (1 unit of mailbox quota) and deletes it at the end (quota is not returned).
 */
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { inspect } from "node:util";

import { Client, MailboxNotFoundError, type Mailbox } from "../src/index.js";

const enabled = Boolean(process.env["TMAILOR_API_KEY"]);

function send(to: string): void {
  const cmd = (process.env["TMAILOR_LIVE_SEND_CMD"] ?? "").replaceAll("{to}", `'${to.replace(/'/g, "'\\''")}'`);
  execFileSync("/bin/sh", ["-c", cmd], { stdio: "ignore", timeout: 60_000 });
}

test("live: account, create, read, delete", { skip: enabled ? false : "TMAILOR_API_KEY is not set" }, async () => {
  const client = new Client({ maxRetries: 3 });
  const me = await client.me();
  assert.ok(me.userId > 0);
  assert.ok(client.lastRateLimit?.limit);
  const doms = await client.domains();
  assert.equal(typeof doms.sharedDomainsAvailable, "boolean");
  assert.equal((await client.health()).status, "ok");
  assert.ok((await client.usage()).timezone);

  const box: Mailbox = await client.mailboxes.create();
  try {
    assert.ok(box.email && box.token && box.web);
    assert.ok(!inspect(box).includes(box.token));
    const same = await client.mailbox(box.token).info();
    assert.equal(same.email, box.email);
    assert.equal(same.messageCount, 0);

    let listed: Mailbox | undefined;
    for await (const m of client.mailboxes.list({ limit: 200 })) {
      if (m.email === box.email) listed = m;
    }
    assert.equal(listed?.token, box.token);

    const msgs = [];
    for await (const m of box.messages()) msgs.push(m);
    assert.deepEqual(msgs, []);

    if (process.env["TMAILOR_LIVE_SEND_CMD"]) {
      // The email is triggered BEFORE waiting: pass since (server time of the address creation, minus 1 s).
      send(box.email ?? "");
      const msg = await box.waitForMessage({ timeout: 120_000, since: (box.createdAt ?? 0) - 1 });
      assert.equal(msg.seen, true);
      assert.ok(msg.hasBody);
      const want = process.env["TMAILOR_LIVE_EXPECT_OTP"];
      if (want) assert.equal(msg.otp, want);
      await box.deleteMessage(msg);
      assert.equal(await box.clear(), 0);
    }
  } finally {
    await box.delete();
  }
  await assert.rejects(box.info(), MailboxNotFoundError);
});
