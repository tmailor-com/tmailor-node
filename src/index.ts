/**
 * Node.js SDK for the Tmailor Open API (https://open-api.tmailor.com), for Open API spec 1.3.0.
 *
 * Create receive-only temporary email addresses and read the messages they receive. Server-side only: the API
 * accepts requests only from the IP addresses in your account allowlist, and the API key gives full access to it.
 */

export { Client, Mailbox, Mailboxes } from "./client.js";
export type {
  ClientOptions,
  FetchInitLike,
  FetchLike,
  FetchResponseLike,
  LoadedMailbox,
  MailboxPage,
  MessagesOptions,
  MessagesPageOptions,
  WaitOptions,
} from "./client.js";
export { BaseURLError, RateLimitInfo } from "./core.js";
export type { Clock } from "./core.js";
export type { DateLike, MessageFilters, TimeLike } from "./ops.js";
export { Domain, DomainList, Health, Me, Message, MessagePage, Usage, WebAccess } from "./models.js";
export type { KeyInfo, Limits, Sender, Subscription, UsageDay } from "./models.js";
export { VERSION } from "./version.js";
export {
  APIConnectionError,
  APIError,
  APITimeoutError,
  AccountLockedError,
  AuthenticationError,
  BadRequestError,
  CacheUnavailableError,
  ConflictError,
  CustomNameNotAllowedError,
  DailyCapReachedError,
  IdempotencyUnavailableError,
  InternalServerError,
  InvalidDomainError,
  InvalidFieldError,
  InvalidJsonError,
  InvalidKeyError,
  InvalidNameError,
  InvalidResponseError,
  IpNotAllowedError,
  KeyRevokedError,
  MailboxExistsError,
  MailboxNotFoundError,
  MessageNotFoundError,
  MethodNotAllowedError,
  MissingKeyError,
  NoDomainAvailableError,
  NotFoundError,
  PermissionDeniedError,
  QuotaExceededError,
  RateLimitError,
  RateLimitedError,
  ServiceUnavailableError,
  TmailorError,
  WaitTimeoutError,
} from "./errors.js";
export type { TmailorErrorOptions } from "./errors.js";
