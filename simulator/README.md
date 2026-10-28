# Tidewater Calendar simulator

A fictional calendar provider for the Harbor Light assessment. In-memory, no external network calls. The API contract, webhook payload, signature scheme, and rules of the contract are in the [root README](../README.md#the-tidewater-api). This file covers running and tuning the simulator itself.

```bash
npm run sim          # from the repo root; or `npm start` in this folder
npm run sim:test     # Vitest: duplicates, reordering, 429, 503, user-delete, replay
```

Port 4010 by default (`TIDEWATER_PORT`). Dev panel at `/__sim/panel`.

## Settings

Every setting can be passed as an environment variable at startup or changed at runtime with `POST /__sim/config` and a partial JSON body. Runtime changes take effect immediately.

| Setting | Env var | Default | Effect |
|---|---|---|---|
| `webhookUrl` | `TIDEWATER_WEBHOOK_URL` | unset | Where webhooks go. Unset: deliveries are logged as `no-target` and not sent. |
| `secret` | `TIDEWATER_SECRET` | `tidewater-dev` | HMAC key for `X-Tidewater-Signature` |
| `latencyMinMs` / `latencyMaxMs` | `TIDEWATER_LATENCY_MIN_MS` / `_MAX_MS` | 50 / 250 | Random delay on every `/v1` response |
| `failRate` | `TIDEWATER_FAIL_RATE` | 0 | Fraction of `/v1` calls that return `503` without changing anything |
| `rateLimitPerSec` | `TIDEWATER_RATE_LIMIT_PER_SEC` | 10 | Token bucket across all `/v1` calls: holds 10, refills 10 per second. Over budget: `429`, `Retry-After: 1`. `0` disables. |
| `webhookDelayMinMs` / `webhookDelayMaxMs` | `TIDEWATER_WEBHOOK_DELAY_MIN_MS` / `_MAX_MS` | 0 / 1500 | Random wait before a delivery's first attempt |
| `duplicateRate` | `TIDEWATER_DUPLICATE_RATE` | 0.1 | Fraction of deliveries sent a second time with the same `delivery_id` and identical body |
| `duplicateDelayMinMs` / `duplicateDelayMaxMs` | `TIDEWATER_DUPLICATE_DELAY_MIN_MS` / `_MAX_MS` | 1000 / 4000 | Gap before the duplicate |
| `reorderRate` | `TIDEWATER_REORDER_RATE` | 0.1 | Chance a delivery is held back so the next delivery for the same event overtakes it |
| `reorderHoldMs` | `TIDEWATER_REORDER_HOLD_MS` | 3000 | A held delivery is released after this long if nothing overtakes it |
| `webhookMaxAttempts` | `TIDEWATER_WEBHOOK_MAX_ATTEMPTS` | 3 | Attempts per delivery when your endpoint returns non-2xx or is unreachable (backoff 1 s, 3 s) |

Other env vars: `TIDEWATER_PRELOAD` (path to the preload file; default `../seed/tidewater-preload.json`), `TIDEWATER_RANDOM_SEED` (makes jitter reproducible), `TIDEWATER_QUIET=1` (suppresses request and delivery logs).

Throttling and failure injection are decided when a request arrives, so a burst of parallel calls is throttled as a burst. Admin endpoints under `/__sim` are never throttled or failure-injected.

## Admin endpoints

| Method | Path | Notes |
|---|---|---|
| `GET` | `/__sim/config` | |
| `POST` | `/__sim/config` | Partial update; unknown keys and out-of-range values return `400` |
| `POST` | `/__sim/reset` | Reloads the preload, clears the delivery log and any pending deliveries |
| `GET` | `/__sim/state` | `{ accounts: { [accountId]: Event[] } }` |
| `POST` | `/__sim/accounts/:accountId/events/:id/user-delete` | Emits `event.deleted` |
| `POST` | `/__sim/accounts/:accountId/events/:id/user-edit` | Body `{ start?, end?, title? }`; emits `event.updated` |
| `GET` | `/__sim/deliveries` | `?event_id=` to filter, `?limit=` (default 200). Each entry has `raw` (the exact body sent) and `attempts` (`original`, `retry`, `duplicate`, `replay`, each with a status) |
| `POST` | `/__sim/replay/:deliveryId` | Sends the logged body again, same `delivery_id`, no retries |
| `GET` | `/__sim/panel` | Dev panel |

## Source layout

| File | Contents |
|---|---|
| `src/index.ts` | Startup and env wiring |
| `src/app.ts` | Express app: throttling, failure injection, `/v1`, `/__sim` |
| `src/store.ts` | In-memory events and validation |
| `src/webhooks.ts` | Delivery, signing, delay, duplication, reordering, retries, replay |
| `src/config.ts` | Settings and defaults |
| `src/panel.html` | Dev panel |
| `test/simulator.test.ts` | Behavior tests |
