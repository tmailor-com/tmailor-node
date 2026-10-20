// Base URL validation, API key / base URL from the environment, option validation.
import { strict as assert } from "node:assert";
import { test } from "node:test";

import { BaseURLError, Client } from "../src/index.js";
import { checkBaseUrl, maskKey } from "../src/core.js";
import { KEY, withEnv } from "./helpers.js";

const fakeFetch = async (): Promise<never> => {
  throw new Error("no request expected");
};

const CASES: Array<[string, boolean, string | null]> = [
  ["https://open-api.tmailor.com", false, "https://open-api.tmailor.com"],
  ["HTTPS://Open-API.tmailor.com:443/", false, "https://open-api.tmailor.com:443"],
  ["https://open-api.tmailor.com/v0/", false, "https://open-api.tmailor.com/v0"],
  ["  https://open-api.tmailor.com  ", false, "https://open-api.tmailor.com"],
  ["https://staging.example.com", true, "https://staging.example.com"],
  ["http://127.0.0.1:8080", true, "http://127.0.0.1:8080"],
  ["http://127.1.2.3", true, "http://127.1.2.3"],
  ["http://[::1]:8080/", true, "http://[::1]:8080"],
  ["http://[0:0:0:0:0:0:0:1]", true, "http://[0:0:0:0:0:0:0:1]"],
  ["http://localhost:9000", true, "http://localhost:9000"],
  ["https://staging.example.com", false, null],
  ["https://open-api.tmailor.com.evil.example", false, null],
  ["https://open-api.tmailor.com:8443", false, null],
  ["http://open-api.tmailor.com", false, null],
  ["http://open-api.tmailor.com", true, null],
  ["http://example.com", true, null],
  ["http://127.0.0.1:8080", false, null],
  ["http://128.0.0.1", true, null],
  ["http://127.0.0.01", true, null],
  ["http://[::2]", true, null],
  ["http://[::ffff:127.0.0.1]", true, null],
  ["https://user:pass@open-api.tmailor.com", true, null],
  ["https://open-api.tmailor.com@evil.example", true, null],
  ["https://open-api.tmailor.com/?x=1", true, null],
  ["https://open-api.tmailor.com/#frag", true, null],
  ["https://open-api.tmailor.com/a b", true, null],
  ["https://open-api.tmailor.com\r\nX: y", true, null],
  ["https://open-api.tmailor.com\u0085", true, null],
  ["ftp://open-api.tmailor.com", true, null],
  ["open-api.tmailor.com", true, null],
  ["https://", true, null],
  ["https:open-api.tmailor.com", true, null],
  ["https://h:99999", true, null],
  ["https://h:12ab", true, null],
  ["https://[::1", true, null],
  ["", true, null],
];

for (const [url, allow, expected] of CASES) {
  test(`checkBaseUrl(${JSON.stringify(url)}, allowUntrusted=${allow}) -> ${expected ?? "refused"}`, () => {
    if (expected === null) {
      assert.throws(() => checkBaseUrl(url, allow), BaseURLError);
    } else {
      assert.equal(checkBaseUrl(url, allow), expected);
    }
  });
}

test("Client refuses an untrusted base URL unless allowed, also from TMAILOR_BASE_URL", async () => {
  assert.throws(() => new Client({ apiKey: KEY, baseUrl: "https://evil.example", fetch: fakeFetch }), BaseURLError);
  const c = new Client({ apiKey: KEY, baseUrl: "https://evil.example", allowUntrustedBaseUrl: true, fetch: fakeFetch });
  assert.equal(c.baseUrl, "https://evil.example");
  await withEnv({ TMAILOR_BASE_URL: "https://evil.example" }, () => {
    assert.throws(() => new Client({ apiKey: KEY, fetch: fakeFetch }), BaseURLError);
    assert.equal(new Client({ apiKey: KEY, fetch: fakeFetch, allowUntrustedBaseUrl: true }).baseUrl, "https://evil.example");
  });
  await withEnv({ TMAILOR_BASE_URL: undefined }, () => {
    assert.equal(new Client({ apiKey: KEY, fetch: fakeFetch }).baseUrl, "https://open-api.tmailor.com");
  });
});

test("API key from TMAILOR_API_KEY; an explicit empty key means no key", async () => {
  await withEnv({ TMAILOR_API_KEY: `  ${KEY}  ` }, () => {
    const c = new Client({ fetch: fakeFetch });
    assert.ok(String(c).includes("tmk_live_abcdefabcdef_***"));
    const none = new Client({ apiKey: "", fetch: fakeFetch });
    assert.ok(String(none).includes("apiKey: null"));
  });
});

test("maskKey", () => {
  assert.equal(maskKey(KEY), "tmk_live_abcdefabcdef_***");
  assert.equal(maskKey("whatever"), "***");
  assert.equal(maskKey(null), null);
});

test("option validation", () => {
  const base = { apiKey: KEY, fetch: fakeFetch };
  assert.throws(() => new Client({ ...base, maxRetries: -1 }), RangeError);
  assert.throws(() => new Client({ ...base, maxRetries: 1.5 }), RangeError);
  assert.throws(() => new Client({ ...base, timeout: 0 }), RangeError);
  assert.throws(() => new Client({ ...base, maxRetryWait: -1 }), RangeError);
  const c = new Client(base);
  assert.equal(c.timeout, 30_000);
  assert.equal(c.maxRetries, 2);
  assert.equal(c.maxRetryWait, 60_000);
  assert.throws(() => c.mailbox("  "), TypeError);
});
