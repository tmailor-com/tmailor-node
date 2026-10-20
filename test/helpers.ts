import { Client, type ClientOptions, type FetchInitLike, type FetchLike } from "../src/index.js";
import { FakeClock } from "./conformance-runner.js";

export const KEY = "tmk_live_abcdefabcdef_SUPERSECRETvalue000000000000000000000000";
export const TOKEN = "eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.SECRET-ADDRESS-TOKEN.sig";

export interface Sent {
  url: string;
  init: FetchInitLike;
}

export type Step = Response | Error | ((url: string, init: FetchInitLike) => Response | Promise<Response>);

/** A fetch that answers with `steps` in order and records every request. */
export function recordingFetch(steps: Step[]): { fetch: FetchLike; sent: Sent[] } {
  const sent: Sent[] = [];
  const queue = [...steps];
  const fetch: FetchLike = async (url, init) => {
    sent.push({ url, init });
    const step = queue.shift();
    if (step === undefined) throw new Error(`unexpected request ${init.method} ${url}`);
    if (step instanceof Error) throw step;
    if (typeof step === "function") return step(url, init);
    return step;
  };
  return { fetch, sent };
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

export function testClient(steps: Step[], options: ClientOptions = {}): { client: Client; sent: Sent[]; clock: FakeClock } {
  const { fetch, sent } = recordingFetch(steps);
  const clock = new FakeClock(1760342400 * 1000);
  const client = new Client({
    apiKey: KEY,
    baseUrl: "https://x.test",
    allowUntrustedBaseUrl: true,
    fetch,
    clock,
    ...options,
  });
  return { client, sent, clock };
}

export function mailboxBody(token: string | null, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: "a@b.example",
    domain: "b.example",
    is_user_domain: false,
    custom_name: false,
    created_at: 1760342400,
    token,
    web:
      token === null
        ? null
        : { accesstoken: token, transfertoken: "eyJ.SECRET-TRANSFER.sig", reuse_url: "https://tmailor.com/r#accesstoken/" + token },
    ...extra,
  };
}

export const ME_OK = {
  user_id: 12,
  key: { key_id: 3, prefix: "abcdefabcdef" },
  client_ip: "192.0.2.10",
  limits: {
    quota_total: 100,
    quota_used: 1,
    quota_remaining: 99,
    mailbox_count: 1,
    rate_per_min: 60,
    daily_req_cap: 10000,
    max_ip: 1,
  },
  ip_allowlist: ["192.0.2.10"],
  ip_allowlist_enforced: true,
  subscriptions: [{ plan: "free", expires_at: 0, period_end: 1760400000, quota: 100, used: 1 }],
};

/** Run `fn` with environment variables temporarily set (undefined = removed). */
export async function withEnv<R>(vars: Record<string, string | undefined>, fn: () => R | Promise<R>): Promise<R> {
  const old: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    old[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
