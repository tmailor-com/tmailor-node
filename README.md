# tmailor: Node.js SDK for the Tmailor Open API

[![CI](https://github.com/tmailor-com/tmailor-node/actions/workflows/ci.yml/badge.svg)](https://github.com/tmailor-com/tmailor-node/actions/workflows/ci.yml)
[![Node 18+](https://img.shields.io/badge/node-18%2B-blue.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](https://github.com/tmailor-com/tmailor-node/blob/main/LICENSE)

The official Node.js SDK for the Open API of [Tmailor](https://tmailor.com), the temporary email service.
Create receive-only temporary email addresses and read incoming messages from your backend or test runner. Use it
for end-to-end sign-up tests (Playwright, Cypress, Jest, Vitest), OTP and verification-message checks in QA
pipelines, and inbox automation.

- Node.js 18+, written in TypeScript (strict), types included. ESM and CommonJS builds.
- No runtime dependencies: it uses the built-in `fetch` and `AbortController`.
- Promise-based API; pagination with `for await`.
- Typed errors, idempotent address creation, automatic retries, and rate-limit-aware polling.
- Same behaviour as the [Python SDK](https://github.com/tmailor-com/tmailor-python): both pass the same shared
  conformance scenarios. Built for Open API spec 1.3.0.
- [API reference](https://platform.tmailor.com/docs)

## Install

```bash
npm install tmailor
```

```ts
import { Client } from "tmailor"; // ESM
const { Client } = require("tmailor"); // CommonJS
```

## Setup

1. Sign in to [Tmailor Platform](https://platform.tmailor.com), create an API key, and add the caller's public
   IP address to your allowlist.
2. Provide the key:

```bash
export TMAILOR_API_KEY="tmk_live_..."
```

You can also pass it explicitly: `new Client({ apiKey: "tmk_live_..." })`. A client without a key can call only
`health()`; any other call rejects with `MissingKeyError` (code `MissingKey`, no HTTP status) before sending a
request.

## Quickstart

```ts
import { Client } from "tmailor";

const client = new Client(); // reads TMAILOR_API_KEY
const box = await client.mailboxes.create(); // random address on a shared domain
console.log(box.email);

await signUpSomewhere(box.email); // your code triggers an email

// `since` is exclusive (receivedAt > since); "- 1" also accepts a message received in the creation second.
const msg = await box.waitForMessage({ timeout: 120_000, since: box.createdAt - 1 });
console.log(msg.subject, msg.otp, msg.links);
await box.delete();
```

**Units.** Durations you pass to the SDK (`timeout`, `maxRetryWait`, `pollInterval`, the wait `timeout`) are
**milliseconds**, like `setTimeout`. Values that come from the API stay as the API sends them: timestamps
(`createdAt`, `receivedAt`, `RateLimitInfo.reset`) are Unix **seconds**, and so are `since` (a number of seconds,
or a `Date`) and `err.retryAfter`.

## Server-side only

The API accepts requests only from the IP addresses in your account allowlist, and your API key gives full
access to your account. Use this SDK on servers, CI runners, or scripts you control. Never ship the API key or
address tokens to browsers or mobile apps, and never bundle the SDK into front-end code. In browser test tools,
keep the SDK in the Node process (see [Testing with Playwright and Cypress](#testing-with-playwright-and-cypress)).

## Client options

```ts
const client = new Client({ apiKey, baseUrl, timeout: 30_000, maxRetries: 2, maxRetryWait: 60_000 });
```

| Option | Default | Description |
|---|---|---|
| `apiKey` | `$TMAILOR_API_KEY` | `tmk_live_<prefix>_<secret>` |
| `baseUrl` | `$TMAILOR_BASE_URL` or `https://open-api.tmailor.com` | API endpoint (see below) |
| `timeout` | `30000` | milliseconds per HTTP request (connect, headers and body) |
| `maxRetries` | `2` | automatic retries (see [Retries](#retries)) |
| `maxRetryWait` | `60000` | longest `Retry-After`, in milliseconds, that is handled automatically |
| `allowUntrustedBaseUrl` | `false` | required for any host other than `open-api.tmailor.com` |
| `fetch` | global `fetch` | bring your own (proxy agent, instrumentation) |

**Base URL.** Every authenticated request sends your API key in the `Authorization` header. Address operations
also send the address token in the JSON body. The SDK therefore accepts only `https://` URLs without user
information (`user:pass@`), a query string, or a fragment. A host other than `open-api.tmailor.com` (staging,
your own proxy) throws `BaseURLError` unless you pass `allowUntrustedBaseUrl: true`, which states that you trust
that host with your credentials. This also applies to `TMAILOR_BASE_URL`. Plain `http://` is accepted only for a
loopback host (`127.0.0.1`, `::1`, `localhost`) during local development, and it also requires
`allowUntrustedBaseUrl: true`.

**Custom fetch.** The `fetch` option takes any function with the `fetch(url, init)` signature, for example to
route requests through a proxy with undici's `ProxyAgent`:

```ts
import { ProxyAgent, fetch as undiciFetch } from "undici";

const dispatcher = new ProxyAgent("http://proxy.internal:3128");
const client = new Client({ fetch: (url, init) => undiciFetch(url, { ...init, dispatcher }) });
```

The client holds no open resources, so there is nothing to close.

## Addresses

```ts
const box = await client.mailboxes.create(); // random name, shared domain
const own = await client.mailboxes.create({ domain: "mail.example.com", name: "signup" }); // your own verified domain

box.email, box.domain, box.createdAt, box.token, box.web;
```

- Creating an address uses 1 unit of your mailbox quota (`402 QuotaExceeded` when the quota is used up).
- Addresses never expire. They stay in your account until you delete them. Deleting an address does not return
  quota.
- Custom names are allowed only on your own domains (`client.domains()`). Add and verify domains on
  [Tmailor Platform](https://platform.tmailor.com). The system checks your domains' MX records automatically; to
  request an immediate check, select "Check now" on the platform. The API has no domain-check operation.
- A `name` that has already been used to create an address on the [tmailor.com](https://tmailor.com) website or
  mobile app cannot be used through the API. `create()` rejects with `MailboxExistsError` (409) in that case; pick
  another name.

**The token is the key to the address.** Every operation on an address sends `box.token` in the JSON body.
Store it if you need the address later:

```ts
const box = client.mailbox(savedToken); // no request is made
await box.info(); // loads email, messageCount, current tokens
```

Lost a token? `client.mailboxes.list()` returns every address your account still owns and its current token
when available. Listing addresses is also how you recover after a token was changed on Tmailor Platform:

```ts
for await (const box of client.mailboxes.list({ limit: 100 })) {
  // follows nextCursor, up to 100 addresses
  console.log(box.email, box.messageCount);
}

const page = await client.mailboxes.listPage({ pageSize: 100 }); // one page: .items, .nextCursor
```

A token and `box.web` may temporarily be `null`; an address operation without a token rejects with a
`TmailorError` with code `NoToken`.

Delete an address:

```ts
await box.delete(); // same as "Delete" on tmailor.com; all tokens stop working
```

The API does not rotate tokens. To replace an address's tokens, use Tmailor Platform. The old token then
produces `MailboxNotFoundError`, and `client.mailboxes.list()` returns the new token.

When it is available, `box.web` holds the tokens the tmailor.com website uses (`accessToken`, `transferToken`,
`reuseUrl`). Anyone holding them can read the inbox on tmailor.com or, with `transferToken`, take over the
address. Treat them like passwords. `util.inspect`, `console.log`, `JSON.stringify` and `String()` of a client,
mailbox or `WebAccess` never show complete tokens or API keys (they print `***`); a client may show the API key's
non-secret prefix. Read `box.token` explicitly when you need to store it.

## Messages

```ts
for await (const m of box.messages({ unread: true, from: "shop", subject: "confirm" })) {
  // newest first, all pages
  console.log(m.id, m.from.address, m.subject, m.receivedAt, m.seen);
}

const page = await box.messagesPage({ pageSize: 20 }); // .items, .nextCursor, .total; items have no body

const msg = await box.message(m.id); // fetches .text and sanitized .html; marks the message as read
await box.deleteMessage(msg);
const deleted = await box.clear(); // deletes all messages and returns the count
```

Calling `box.message()`, or receiving a message from `waitForMessage()`, marks that message as read. It then no
longer appears with `unread: true`. There is no separate "mark as read" call.

Filters run on the server: `unread`, `from` (text in the sender name or address), `subject` (text in the
subject), and `since` (Unix time in seconds, or a `Date`; **exclusive**: only messages with
`receivedAt > since`, in whole seconds). `limit` caps how many messages the iterator yields; `pageSize`
(1 to 100) sets the page size. Messages are kept for 24 hours. If the API ever returns a pagination cursor it
has already returned, the iterators stop with `InvalidResponseError` instead of looping.

### Waiting for a message

```ts
const msg = await box.waitForMessage({ timeout: 120_000, from: "no-reply@shop.example", subjectContains: "verify" });
```

`waitForMessage` returns, with its body, the first matching message that was **not in the inbox when the wait
started**. It first records the IDs of all current messages, without filters; `from` and `subjectContains` apply
only to the polls. If the message may arrive before polling starts (the usual case: you trigger the email, then
wait), pass `since` so that it can still match:

```ts
const box = await client.mailboxes.create();
await triggerEmail(box.email);
const msg = await box.waitForMessage({ since: box.createdAt - 1 }); // server time, no clock-skew issues
```

`since` is exclusive and counts whole seconds, so `since: box.createdAt` would miss a message received in the same
second the address was created. Subtract 1 as shown above.

The first poll is immediate. After an unsuccessful poll, the delay starts at 1 second and grows to 10 seconds.
`pollInterval` sets a fixed delay in milliseconds with a minimum of 500; a value of zero or less throws a
`RangeError`. When `X-RateLimit-Remaining` is low, the SDK spreads the remaining requests until the minute resets.
A `429 RateLimited` response during the wait is handled by sleeping for `Retry-After` (at least 1 second).

`timeout` (milliseconds, default 120000) is a hard deadline for the whole wait, HTTP requests included. No sleep or
retry goes past it, each request (polls and the final read of the message) is aborted when the time left runs out,
and a poll scheduled after a delay starts only if at least 1 second remains before the deadline. If nothing
arrives in time, or the deadline interrupts a request, it rejects with `WaitTimeoutError`; `timeout: 0` rejects
without sending a request.

### Codes and links

```ts
msg.otp; // "482913", or null when there is no confident answer
msg.codes; // ["482913"]: every code-like value, use it when otp is null or picks the wrong one
msg.links; // ["https://example.com/verify?t=..."]
```

These values are found by the API (fields `otp`, `codes` and `links` of `POST /v1/mailbox/message`, Open API
1.3.0), so every language and plain `curl` get the same answer. The SDK returns them as they are: an `otp` of
`null` from the API stays `null`. They are set on messages read with their body (`box.message(id)` and
`waitForMessage`). Message list items have no body, so their `otp` is `null` and `codes` and `links` are empty;
the same applies to a server older than 1.3.0. Always handle `null`.

## Account

```ts
const me = await client.me(); // userId, limits (quotaTotal, ratePerMin, dailyReqCap, ...), ipAllowlist, subscriptions
const doms = await client.domains(); // your own domains (iterable) + doms.sharedDomainsAvailable
const usage = await client.usage({ from: "2026-10-01", to: "2026-10-17" }); // daily counters
await client.health(); // public status: no key needed and none is sent
client.lastRateLimit; // RateLimitInfo { limit, remaining, reset } of the last response
```

Every model keeps the JSON object it was read from in a non-enumerable `raw` property, so a field added to the
API later is reachable before the SDK knows it.

## Errors

API, network, response-validation, and wait failures are subclasses of `TmailorError` with `code`, `status`,
`message`, `description`, `requestId`, and `retryAfter` (seconds). Invalid local arguments throw `TypeError` or
`RangeError` instead; `BaseURLError` is thrown by the constructor. Handle errors with `instanceof` or `code`, not by
message text. Include `requestId` when contacting support.

| HTTP | Class (code) |
|---|---|
| 400, 413 | `BadRequestError`: `InvalidJsonError`, `InvalidFieldError`, `InvalidDomainError`, `CustomNameNotAllowedError`, `InvalidNameError` (`.reason`) |
| 401 | `AuthenticationError`: `MissingKeyError`, `InvalidKeyError`, `KeyRevokedError` |
| 402 | `QuotaExceededError` |
| 403 | `PermissionDeniedError`: `AccountLockedError`, `IpNotAllowedError` |
| 404 | `NotFoundError`: `MailboxNotFoundError`, `MessageNotFoundError` |
| 405 | `MethodNotAllowedError` |
| 409 | `ConflictError`: `MailboxExistsError` (including a name created on the website or mobile app) |
| 429 | `RateLimitError`: `RateLimitedError`, `DailyCapReachedError` |
| 500, other 5xx | `InternalServerError`, unless a more specific error code applies |
| 503 | `ServiceUnavailableError`: `NoDomainAvailableError`, `IdempotencyUnavailableError`, `CacheUnavailableError` (`.secretChanged`); `InternalServerError` (`InternalError`, reason `cache_hold_failed`); a degraded `health()` (code `HTTP503`) |
| other 4xx | `APIError` |
| 2xx | `InvalidResponseError` (`InvalidResponse`): body not JSON, a field missing or of the wrong type, or a repeated pagination cursor. The body is never kept in the error |
| none | `MissingKeyError` (no API key configured), `APIConnectionError` (`ConnectionError`), `APITimeoutError` (`Timeout`): no HTTP response |
| none | `WaitTimeoutError` (`WaitTimeout`, from `waitForMessage`) |

```ts
import { Client, IpNotAllowedError, QuotaExceededError } from "tmailor";

try {
  const box = await client.mailboxes.create();
} catch (err) {
  if (err instanceof QuotaExceededError) {
    // buy more quota or delete nothing: deleting does not return quota
  } else if (err instanceof IpNotAllowedError) {
    console.error("Add this server's IP address on platform.tmailor.com", err.requestId);
  } else {
    throw err;
  }
}
```

`MailboxNotFoundError` is raised when a token is invalid, was rotated on the platform, belongs to a deleted
address or another account, or was issued by the tmailor.com website (only tokens from the API or the platform
work). `CacheUnavailableError` on `delete()` with `secretChanged === true` means the address was deleted, but old
tokens may still work on tmailor.com for up to 10 minutes.

Network errors never keep the original `fetch` error as `cause` (it can reference the request); the message names
the low-level code instead, for example `Connection failed (ECONNREFUSED)`.

## Retries

Automatic retries (up to `maxRetries`, default 2) happen only when repeating the request is safe:

- `429 RateLimited`: the API did not process the request, so any request is retried after `Retry-After`
  (at least 1 second, unless it is longer than `maxRetryWait`). `DailyCapReached` is never retried.
- `500/502/503/504` and network errors: retried only for reads (`GET`, `info`, `messages`, `message`) and for
  `mailboxes.create()`. A failed connection (nothing sent) is retried for any request.
- `503 CacheUnavailable` on `delete()` is never retried.
- `message()` marks the message as read. Doing that twice has the same effect, so it is retried like a read.

`mailboxes.create()` always sends an `Idempotency-Key` (a new UUID, or yours via `idempotencyKey`), and every
retry reuses it with the same body, so a retry can never create a second address or use quota twice. When there is
no `Retry-After`, exponential backoff uses full jitter: the upper bound starts at 0.5 seconds, doubles on each
retry, and is capped at 8 seconds; the actual delay is between half the upper bound and the upper bound.

## Testing with Playwright and Cypress

The SDK belongs in the Node side of your test runner. The API key and address tokens must never reach the page
under test.

**Playwright**: a fixture that gives every test its own address and deletes it afterwards
([examples/playwright/fixtures.ts](examples/playwright/fixtures.ts)):

```ts
import { test as base, expect } from "@playwright/test";
import { Client, type LoadedMailbox } from "tmailor";

const client = new Client();

export const test = base.extend<{ inbox: LoadedMailbox }>({
  inbox: async ({}, use) => {
    const box = await client.mailboxes.create();
    try {
      await use(box);
    } finally {
      await box.delete();
    }
  },
});

test("sign-up sends a verification code", async ({ page, inbox }) => {
  await page.goto("https://app.example.com/signup");
  await page.getByLabel("Email").fill(inbox.email);
  await page.getByRole("button", { name: "Create account" }).click();
  const msg = await inbox.waitForMessage({ timeout: 60_000, since: inbox.createdAt - 1, subjectContains: "verify" });
  expect(msg.otp).toMatch(/^\d{6}$/);
});
```

**Cypress**: Cypress specs run in the browser, so call the SDK from `setupNodeEvents` and reach it with `cy.task`.
Keep the tokens in the Node process and return only what the spec needs
([examples/cypress/cypress.config.ts](examples/cypress/cypress.config.ts)):

```ts
// cypress.config.ts
import { defineConfig } from "cypress";
import { Client, WaitTimeoutError } from "tmailor";

const client = new Client();
const boxes = new Map<string, { token: string; createdAt: number }>();

export default defineConfig({
  e2e: {
    setupNodeEvents(on) {
      on("task", {
        async "tmailor:create"() {
          const box = await client.mailboxes.create();
          boxes.set(box.email, { token: box.token!, createdAt: box.createdAt });
          return { email: box.email };
        },
        async "tmailor:wait"({ email, timeout = 60_000 }: { email: string; timeout?: number }) {
          const saved = boxes.get(email)!;
          try {
            const msg = await client.mailbox(saved.token).waitForMessage({ timeout, since: saved.createdAt - 1 });
            return { subject: msg.subject, otp: msg.otp, links: msg.links };
          } catch (err) {
            if (err instanceof WaitTimeoutError) return null; // a task must not resolve undefined
            throw err;
          }
        },
        async "tmailor:delete"(email: string) {
          const saved = boxes.get(email);
          if (saved) await client.mailbox(saved.token).delete();
          boxes.delete(email);
          return null;
        },
      });
    },
  },
});
```

```ts
// cypress/e2e/signup.cy.ts (give cy.task a timeout above the wait timeout)
it("sign-up sends a code", () => {
  cy.task("tmailor:create").then(({ email }: any) => {
    cy.visit("/signup");
    cy.get("input[name=email]").type(email);
    cy.contains("button", "Create account").click();
    cy.task("tmailor:wait", { email, timeout: 90_000 }, { timeout: 100_000 }).then((msg: any) => {
      cy.get("input[name=code]").type(msg.otp);
    });
    cy.task("tmailor:delete", email);
  });
});
```

## Links

- [Tmailor](https://tmailor.com): free temporary email service
- [Tmailor Platform](https://platform.tmailor.com): API keys, IP allowlist, domains, and plans
- [API documentation](https://platform.tmailor.com/docs)
- [Python SDK](https://github.com/tmailor-com/tmailor-python)
- [Issue tracker](https://github.com/tmailor-com/tmailor-node/issues)
- [Support](https://tmailor.com/contact-us)
- [Changelog](https://github.com/tmailor-com/tmailor-node/blob/main/CHANGELOG.md)

## Development

```bash
npm ci
npm run build              # dist/esm (ESM + .d.ts) and dist/cjs (CommonJS + .d.ts)
npm run typecheck
npm test                   # unit, local-transport and shared conformance scenarios (no network)
npm run test:conformance   # only the conformance scenarios
npm run test:live          # real API; needs TMAILOR_API_KEY from an allowlisted IP address
```

`test/conformance.test.ts` replays the language-neutral scenarios in `conformance/scenarios/` with a fake `fetch`
and a fake clock. Every Tmailor SDK must pass the same scenarios; `TMAILOR_CONFORMANCE_DIR` overrides the location,
and a missing or incomplete directory fails the run instead of skipping. The scenarios are written in seconds; the
runner converts them to the milliseconds of this SDK. `test/transport.test.ts` exercises the real `fetch` against a
local HTTP server on 127.0.0.1 (timeouts, refused and dropped connections).

## License

MIT. See [LICENSE](https://github.com/tmailor-com/tmailor-node/blob/main/LICENSE).
