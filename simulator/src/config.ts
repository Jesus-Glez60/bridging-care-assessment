// Runtime configuration for the Tidewater simulator.
// Every key can be set by environment variable (TIDEWATER_ + the key in SCREAMING_SNAKE_CASE,
// e.g. failRate -> TIDEWATER_FAIL_RATE) or changed at runtime via POST /__sim/config.

export interface SimConfig {
  webhookUrl: string | null; // where webhooks are POSTed; null = record but don't send
  secret: string; // HMAC-SHA256 key for X-Tidewater-Signature
  latencyMinMs: number; // added to every /v1 response
  latencyMaxMs: number;
  failRate: number; // 0..1 fraction of /v1 calls that return 503 (nothing is changed)
  rateLimitPerSec: number; // token bucket for all /v1 calls; 0 disables
  webhookDelayMinMs: number; // wait before first delivery attempt
  webhookDelayMaxMs: number;
  duplicateRate: number; // 0..1 fraction of deliveries sent a second time, same delivery_id
  duplicateDelayMinMs: number; // gap before the duplicate copy
  duplicateDelayMaxMs: number;
  reorderRate: number; // 0..1 chance a delivery is held so the next one for the same event overtakes it
  reorderHoldMs: number; // a held delivery is released after this long if nothing overtakes it
  webhookMaxAttempts: number; // retries when your endpoint returns non-2xx or is unreachable
}

export const DEFAULTS: SimConfig = {
  webhookUrl: null,
  secret: "tidewater-dev",
  latencyMinMs: 50,
  latencyMaxMs: 250,
  failRate: 0,
  rateLimitPerSec: 10,
  webhookDelayMinMs: 0,
  webhookDelayMaxMs: 1500,
  duplicateRate: 0.1,
  duplicateDelayMinMs: 1000,
  duplicateDelayMaxMs: 4000,
  reorderRate: 0.1,
  reorderHoldMs: 3000,
  webhookMaxAttempts: 3,
};

const envName = (key: string) => "TIDEWATER_" + key.replace(/[A-Z]/g, (c) => "_" + c).toUpperCase();

/** Validates a partial config and returns the merged result. Throws on bad input. */
export function mergeConfig(base: SimConfig, patch: Record<string, unknown>): SimConfig {
  const next: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown config key: ${key}`);
    const expected = typeof DEFAULTS[key as keyof SimConfig];
    if (key === "webhookUrl") {
      if (value !== null && typeof value !== "string") throw new Error("webhookUrl must be a string or null");
      next[key] = value === "" ? null : value;
    } else if (expected === "number") {
      const n = typeof value === "string" ? Number(value) : value;
      if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`${key} must be a non-negative number`);
      if (key.endsWith("Rate") && n > 1) throw new Error(`${key} must be between 0 and 1`);
      next[key] = n;
    } else {
      if (typeof value !== "string" || !value) throw new Error(`${key} must be a non-empty string`);
      next[key] = value;
    }
  }
  const cfg = next as unknown as SimConfig;
  if (cfg.latencyMaxMs < cfg.latencyMinMs) cfg.latencyMaxMs = cfg.latencyMinMs;
  if (cfg.webhookDelayMaxMs < cfg.webhookDelayMinMs) cfg.webhookDelayMaxMs = cfg.webhookDelayMinMs;
  if (cfg.duplicateDelayMaxMs < cfg.duplicateDelayMinMs) cfg.duplicateDelayMaxMs = cfg.duplicateDelayMinMs;
  return cfg;
}

export function configFromEnv(env: NodeJS.ProcessEnv): SimConfig {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULTS)) {
    const raw = env[envName(key)];
    if (raw !== undefined) patch[key] = raw;
  }
  return mergeConfig(DEFAULTS, patch);
}
