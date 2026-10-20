/**
 * Polling schedule of `waitForMessage` (same rules as `_wait.py`). Milliseconds.
 *
 * - Without `pollInterval` the delay starts at 1 s and grows by 1.5x up to 10 s.
 * - With `pollInterval` the delay is fixed (at least 0.5 s).
 * - Rate limits: when `X-RateLimit-Remaining` is at or below 2 the poll waits for `X-RateLimit-Reset` (+0.5 s, at
 *   most 61 s); when it is low it spreads the remaining requests until the reset.
 * - Never sleeps past the deadline; the last poll starts at least 1 s before it.
 *
 * @internal
 */

import { MIN_RETRY_AFTER, checkDuration, type RateLimitInfo } from "./core.js";

export const FIRST_POLL = 1_000;
export const GROWTH = 1.5;
export const MAX_POLL = 10_000;
export const MIN_POLL = 500;
/** Keep this many requests of the current minute for the rest of your program. */
export const RESERVE = 2;
/** The last poll starts at least this long before the deadline. */
export const LAST_POLL_RESERVE = 1_000;
const MAX_RATE_WAIT = 61_000;

export class WaitPlan {
  readonly deadline: number;
  readonly fixed: boolean;
  interval: number;

  constructor(timeout: number, pollInterval: number | null | undefined, now: number) {
    // Review 20b NODE-04: finite milliseconds only (Infinity would never time out or would hit setTimeout's 1 ms fallback).
    checkDuration("timeout", timeout);
    if (pollInterval !== undefined && pollInterval !== null) checkDuration("pollInterval", pollInterval, true);
    this.deadline = now + timeout;
    this.fixed = pollInterval !== undefined && pollInterval !== null;
    this.interval = this.fixed ? Math.max(MIN_POLL, pollInterval as number) : FIRST_POLL;
  }

  remaining(now: number): number {
    return this.deadline - now;
  }

  /** Milliseconds to sleep before the next poll, or null when less than LAST_POLL_RESERVE is left. */
  nextDelay(now: number, wallNow: number, rl: RateLimitInfo | null): number | null {
    const left = this.deadline - now - LAST_POLL_RESERVE;
    if (left <= 0) return null;
    let delay = this.interval;
    if (!this.fixed) this.interval = Math.min(this.interval * GROWTH, MAX_POLL);
    if (rl !== null && rl.remaining !== null && rl.reset !== null) {
      const untilReset = Math.max(0, rl.reset * 1000 - wallNow) + 500;
      if (rl.remaining <= RESERVE) {
        delay = Math.max(delay, Math.min(untilReset, MAX_RATE_WAIT));
      } else if (rl.limit && rl.remaining < Math.max(5, Math.floor(rl.limit / 5))) {
        delay = Math.max(delay, Math.min(untilReset / Math.max(1, rl.remaining - RESERVE), MAX_RATE_WAIT));
      }
    }
    return Math.min(delay, left);
  }

  /** Sleep after a 429 inside the wait loop, or null when it does not fit before the deadline. */
  rateLimitDelay(now: number, retryAfterSeconds: number | null): number | null {
    const left = this.deadline - now - LAST_POLL_RESERVE;
    const wait = retryAfterSeconds !== null ? Math.max(retryAfterSeconds * 1000, MIN_RETRY_AFTER) : this.interval;
    if (wait > left) return null;
    return wait;
  }
}
