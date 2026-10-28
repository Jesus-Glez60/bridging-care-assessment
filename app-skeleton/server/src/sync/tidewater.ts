// Tidewater API client with one process-wide limiter. The provider's budget is a single token bucket
// shared by every account and verb, and 503s still spend tokens, so we pace all calls through one gate:
// at most MAX_IN_FLIGHT concurrent requests, MIN_SPACING_MS between starts, and a global pause on 429.
import type { TwEventPayload } from "../types";

export type CallResult<T> =
  | { kind: "ok"; status: number; body: T }
  | { kind: "not_found" }
  | { kind: "retryable"; status: number | null; reason: string; retryAfterMs?: number } // 429, 503, network: nothing changed, retry
  | { kind: "ambiguous"; reason: string } // timeout after the request was sent: it may have been applied
  | { kind: "rejected"; status: number; reason: string }; // other 4xx: retrying won't help

const MAX_IN_FLIGHT = 3;
const MIN_SPACING_MS = 125; // ≈ 8/s, under the provider's 10/s
const TIMEOUT_MS = 10_000;

export class Limiter {
  private inFlight = 0;
  private nextStart = 0;
  private pausedUntil = 0;
  private waiters: (() => void)[] = [];
  stats = { calls: 0, throttled: 0, failed: 0 };

  pause(ms: number) {
    this.pausedUntil = Math.max(this.pausedUntil, Date.now() + ms);
  }

  async acquire() {
    for (;;) {
      const t = Date.now();
      const wait = Math.max(this.pausedUntil - t, this.nextStart - t);
      if (this.inFlight < MAX_IN_FLIGHT && wait <= 0) {
        this.inFlight++;
        this.nextStart = t + MIN_SPACING_MS;
        return;
      }
      if (this.inFlight >= MAX_IN_FLIGHT) await new Promise<void>((r) => this.waiters.push(r));
      else await new Promise((r) => setTimeout(r, wait));
    }
  }

  release() {
    this.inFlight--;
    this.waiters.shift()?.();
  }
}

export class TidewaterClient {
  readonly limiter = new Limiter();
  constructor(
    private baseUrl: string,
    private fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<CallResult<T>> {
    await this.limiter.acquire();
    this.limiter.stats.calls++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: body ? { "content-type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      if (res.status === 429) {
        const retryAfterMs = (Number(res.headers.get("retry-after")) || 1) * 1000;
        this.limiter.pause(retryAfterMs + Math.random() * 250);
        this.limiter.stats.throttled++;
        return { kind: "retryable", status: 429, reason: "rate limited", retryAfterMs };
      }
      if (res.status === 503) {
        this.limiter.stats.failed++;
        return { kind: "retryable", status: 503, reason: "provider unavailable (503)" };
      }
      if (res.status === 404) return { kind: "not_found" };
      if (res.status >= 400) return { kind: "rejected", status: res.status, reason: `${res.status} ${(await res.text()).slice(0, 200)}` };
      const text = await res.text();
      return { kind: "ok", status: res.status, body: (text ? JSON.parse(text) : null) as T };
    } catch (e) {
      const err = e as Error;
      // Connection refused etc. happen before the provider sees the request; an abort after sending does not.
      if (err.name === "AbortError") return { kind: "ambiguous", reason: `timed out after ${TIMEOUT_MS}ms` };
      return { kind: "retryable", status: null, reason: `network: ${err.message}` };
    } finally {
      clearTimeout(timer);
      this.limiter.release();
    }
  }

  list(accountId: string) {
    return this.call<{ events: TwEventPayload[] }>("GET", `/v1/accounts/${encodeURIComponent(accountId)}/events`);
  }
  create(accountId: string, body: { title: string; start: string; end: string; app_ref: string }) {
    return this.call<TwEventPayload>("POST", `/v1/accounts/${encodeURIComponent(accountId)}/events`, body);
  }
  patch(accountId: string, id: string, body: { start: string; end: string }) {
    return this.call<TwEventPayload>("PATCH", `/v1/accounts/${encodeURIComponent(accountId)}/events/${encodeURIComponent(id)}`, body);
  }
  remove(accountId: string, id: string) {
    return this.call<null>("DELETE", `/v1/accounts/${encodeURIComponent(accountId)}/events/${encodeURIComponent(id)}`);
  }
}
