/**
 * Typed errors raised by the SDK.
 *
 * Every error the API returns has the JSON shape `{"error": {"code", "message", "description", "request_id", ...}}`.
 * The SDK maps `code` to a subclass of {@link TmailorError}. Branch on the class (or on `err.code`), never on the
 * message text.
 *
 * Network problems (DNS, TLS, connection reset, timeout) raise {@link APIConnectionError}, which has no HTTP
 * status. {@link WaitTimeoutError} is raised by `Mailbox.waitForMessage` when no matching message arrives in time.
 */

export interface TmailorErrorOptions {
  code?: string;
  status?: number | null;
  description?: string;
  requestId?: string | null;
  retryAfter?: number | null;
  body?: Record<string, unknown> | null;
  headers?: Record<string, string> | null;
}

/** Base class of every error raised by the SDK. */
export class TmailorError extends Error {
  /** API error code (for example `"QuotaExceeded"`), or an SDK code such as `"ConnectionError"` / `"WaitTimeout"`. */
  readonly code: string;
  /** HTTP status, or `null` when no HTTP response was received. */
  readonly status: number | null;
  /** Longer explanation from the API (may be empty). */
  readonly description: string;
  /** `request_id` of the failed request. Quote it when you contact support. */
  readonly requestId: string | null;
  /** Seconds to wait before retrying (as sent by the API in `Retry-After`), or `null`. */
  readonly retryAfter: number | null;
  /** The `error` object of the response only. It never contains an API key or an address token. */
  readonly body: Record<string, unknown>;
  /** Selected response headers (`retry-after`, `x-ratelimit-*`, `x-request-id`, `allow`). */
  readonly headers: Record<string, string>;

  constructor(message: string, options: TmailorErrorOptions = {}) {
    super(message);
    Object.defineProperty(this, "name", { value: new.target.name, enumerable: false, configurable: true, writable: true });
    this.code = options.code ?? "Error";
    this.status = options.status ?? null;
    this.description = options.description ?? "";
    this.requestId = options.requestId ?? null;
    this.retryAfter = options.retryAfter ?? null;
    this.body = { ...(options.body ?? {}) };
    this.headers = { ...(options.headers ?? {}) };
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      status: this.status,
      message: this.message,
      description: this.description,
      requestId: this.requestId,
      retryAfter: this.retryAfter,
    };
  }
}

/** An error response (HTTP status >= 400) from the API. */
export class APIError extends TmailorError {}

/**
 * The API answered 2xx with a body the SDK cannot trust: not JSON, a missing or mistyped field, or a pagination
 * cursor that was already used. `code` is `"InvalidResponse"`. The response body is never kept in the error.
 */
export class InvalidResponseError extends APIError {
  constructor(message: string, options: { status?: number | null; requestId?: string | null } = {}) {
    super(message, { code: "InvalidResponse", status: options.status ?? null, requestId: options.requestId ?? null });
  }
}

/** The request did not get an HTTP response (DNS, TLS, connection refused or reset, ...). */
export class APIConnectionError extends TmailorError {
  constructor(message = "Connection error", options: { code?: string } = {}) {
    super(message, { code: options.code ?? "ConnectionError" });
  }
}

/** The HTTP request timed out (`timeout` client option). */
export class APITimeoutError extends APIConnectionError {
  constructor(message = "Request timed out") {
    super(message, { code: "Timeout" });
  }
}

/** `waitForMessage` did not see a matching new message before its timeout. */
export class WaitTimeoutError extends TmailorError {
  constructor(message = "No matching message arrived before the timeout") {
    super(message, { code: "WaitTimeout" });
  }
}

// 400
/** HTTP 400 (or 413): the request is invalid. */
export class BadRequestError extends APIError {}
export class InvalidJsonError extends BadRequestError {}
export class InvalidFieldError extends BadRequestError {}
/** `domain` is not one of your usable domains (400 on create). */
export class InvalidDomainError extends BadRequestError {}
export class CustomNameNotAllowedError extends BadRequestError {}
/** The custom name breaks the naming rules. `reason` holds the detail when the API sends it. */
export class InvalidNameError extends BadRequestError {
  get reason(): string | null {
    const r = this.body["reason"];
    return typeof r === "string" ? r : null;
  }
}

// 401
/** HTTP 401: missing, invalid or revoked API key. */
export class AuthenticationError extends APIError {}
/**
 * HTTP 401 `MissingKey`, or raised by the SDK (`status` null) before sending anything when an operation that
 * needs a key is called without one (`health()` works without a key).
 */
export class MissingKeyError extends AuthenticationError {}
export class InvalidKeyError extends AuthenticationError {}
export class KeyRevokedError extends AuthenticationError {}

// 402
/** HTTP 402: the mailbox quota of all your plans is used up for this period. */
export class QuotaExceededError extends APIError {}

// 403
/** HTTP 403. */
export class PermissionDeniedError extends APIError {}
export class AccountLockedError extends PermissionDeniedError {}
/** The request IP is not in the allowlist of the account (set it on https://platform.tmailor.com). */
export class IpNotAllowedError extends PermissionDeniedError {}

// 404
/** HTTP 404. */
export class NotFoundError extends APIError {}
/**
 * The token is wrong, was rotated on https://platform.tmailor.com, belongs to another account, or the address was
 * deleted.
 */
export class MailboxNotFoundError extends NotFoundError {}
export class MessageNotFoundError extends NotFoundError {}

// 405 / 409
export class MethodNotAllowedError extends APIError {}
/** HTTP 409 (for example an Idempotency-Key reused with a different body, or still in progress). */
export class ConflictError extends APIError {}
/**
 * 409 on create: the address is already in use. Also raised for a `name` on your own domain that was created on
 * the tmailor.com website or mobile app: such an address cannot be used through the API, pick another name.
 */
export class MailboxExistsError extends ConflictError {}

// 429
/** HTTP 429. `retryAfter` tells how many seconds to wait. */
export class RateLimitError extends APIError {}
export class RateLimitedError extends RateLimitError {}
export class DailyCapReachedError extends RateLimitError {}

// 5xx
/** HTTP 500 or another 5xx without a more specific class. */
export class InternalServerError extends APIError {}
/** HTTP 503: temporarily unavailable. */
export class ServiceUnavailableError extends APIError {}
export class NoDomainAvailableError extends ServiceUnavailableError {}
/** The Idempotency-Key could not be checked, so nothing was created. Retry later with the same key. */
export class IdempotencyUnavailableError extends ServiceUnavailableError {}
/**
 * Address delete could not be confirmed. `secretChanged` is `false` when nothing changed (retry later) and `true`
 * when the address was deleted but old tokens may keep working on tmailor.com for up to 10 minutes.
 */
export class CacheUnavailableError extends ServiceUnavailableError {
  get secretChanged(): boolean | null {
    const v = this.body["secret_changed"];
    return typeof v === "boolean" ? v : null;
  }
}

type APIErrorClass = new (message: string, options?: TmailorErrorOptions) => APIError;

const ERROR_CODES: Record<string, APIErrorClass> = {
  InvalidJson: InvalidJsonError,
  InvalidField: InvalidFieldError,
  InvalidDomain: InvalidDomainError,
  CustomNameNotAllowed: CustomNameNotAllowedError,
  InvalidName: InvalidNameError,
  MissingKey: MissingKeyError,
  InvalidKey: InvalidKeyError,
  KeyRevoked: KeyRevokedError,
  QuotaExceeded: QuotaExceededError,
  AccountLocked: AccountLockedError,
  IpNotAllowed: IpNotAllowedError,
  NotFound: NotFoundError,
  MailboxNotFound: MailboxNotFoundError,
  MessageNotFound: MessageNotFoundError,
  MethodNotAllowed: MethodNotAllowedError,
  MailboxExists: MailboxExistsError,
  Conflict: ConflictError,
  RateLimited: RateLimitedError,
  DailyCapReached: DailyCapReachedError,
  InternalError: InternalServerError,
  NoDomainAvailable: NoDomainAvailableError,
  IdempotencyUnavailable: IdempotencyUnavailableError,
  CacheUnavailable: CacheUnavailableError,
};

const STATUS_CLASSES: Record<number, APIErrorClass> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: QuotaExceededError,
  403: PermissionDeniedError,
  404: NotFoundError,
  405: MethodNotAllowedError,
  409: ConflictError,
  413: BadRequestError,
  429: RateLimitError,
  500: InternalServerError,
  503: ServiceUnavailableError,
};

/** Pick the error class: known `code` first, then the HTTP status, then a generic class. */
export function errorClass(code: string | null, status: number): APIErrorClass {
  if (code && Object.prototype.hasOwnProperty.call(ERROR_CODES, code)) return ERROR_CODES[code] as APIErrorClass;
  const byStatus = STATUS_CLASSES[status];
  if (byStatus) return byStatus;
  if (status >= 500) return InternalServerError;
  return APIError;
}
