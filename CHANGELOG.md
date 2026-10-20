# Changelog

## 0.1.0 (unreleased)

First version, for Open API spec 1.3.0. Port of the Python SDK 0.2.0 with the same object model and behaviour; it
passes all 83 shared conformance scenarios.

- `Client`: `health()` (public, sent without the key), `me()`, `domains()`, `usage({ from, to })`,
  `mailboxes.create/list/listPage`, `mailbox(token)` (no request), `lastRateLimit`.
- `Mailbox`: `info()`, `messages()` (`for await`, follows the cursor), `messagesPage()`, `message(id)` (marks the
  message as read), `deleteMessage(id)`, `clear()`, `delete()`, `waitForMessage({ timeout, from, subjectContains,
  pollInterval, since })`.
- `Message.otp`, `Message.codes` and `Message.links` are the values found by the API (fields `otp`, `codes`,
  `links` of `POST /v1/mailbox/message`); the SDK has no extractor of its own. `otp: null` stays `null`.
- Typed errors for every API error code (`TmailorError` and subclasses), network errors (`APIConnectionError`,
  `APITimeoutError`), invalid 2xx bodies (`InvalidResponseError`) and wait timeouts (`WaitTimeoutError`).
- Automatic retries for 429 / 5xx / network errors on safe requests, `Idempotency-Key` on create (reused by every
  retry), `Retry-After` (at least 1 s), full-jitter backoff, `maxRetryWait`.
- `waitForMessage` deadline bounds every sleep and every HTTP request (the request is aborted at the deadline).
- Strict validation of 2xx bodies: a missing field, a wrong JSON type (including `1.0` for an integer) or a repeated
  pagination cursor raises `InvalidResponseError` without the body.
- The base URL must be `https://` (or `http://` to a loopback host); another host than `open-api.tmailor.com` needs
  `allowUntrustedBaseUrl: true`.
- The API key and address tokens never appear in `util.inspect`, `JSON.stringify`, `String()` or error output.
- Durations are milliseconds (`timeout`, `maxRetryWait`, `pollInterval`); `since` and API timestamps are Unix seconds.
- Review 20b (before release): `Me.ipAllowlistEnforced` (required `ip_allowlist_enforced`, spec 1.3.0); only 2xx
  is success, a 3xx is an `APIError` with code `HTTP3xx` and is not retried (also for `delete()` and other calls
  without a result); integers outside the safe range (beyond 2^53 - 1) are an `InvalidResponseError`; `timeout`,
  `maxRetryWait`, `pollInterval` and the wait `timeout` must be finite, and timers longer than 2^31 - 1 ms are armed
  in steps (Node would otherwise fire them after 1 ms). Conformance scenarios synced with the Python SDK (83 files).
- ESM and CommonJS builds with type declarations; no runtime dependencies; Node.js 18 or later.
