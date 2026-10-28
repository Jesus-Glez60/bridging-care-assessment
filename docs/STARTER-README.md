# Harbor Light Shift Coordination — Starter Repo

You're building the shift-coordination module for a fictional community kitchen, with two-way sync to a fictional calendar provider called Tidewater. This repo gives you the provider (as a local simulator), the seed data, and an optional MEAN skeleton. **Read [BRIEF.md](./BRIEF.md) first.** It's the actual assignment.

> All organizations, people, products, and APIs in this packet are fictitious. Harbor Light Community Kitchen does not exist. "Tidewater Calendar" is an invented API built for this exercise. This exercise exists solely to assess your approach, judgment, and technical fit. It does not produce anything we or any organization we work with will use, and your submission will not be used for any purpose beyond this hiring decision. Do not connect real Google, Microsoft, or Slack accounts, and do not use real personal or organizational data anywhere in your work.

## Prerequisites

- Node.js 22 or later (`.nvmrc` pins 22) and npm 10+
- Docker, only if you use the optional skeleton's MongoDB

```bash
npm install          # installs the simulator and the skeleton server (npm workspaces)
npm run sim:test     # optional: proves the simulator behaves as documented below
```

The Angular client in `app-skeleton/client` installs separately (see [Optional skeleton](#optional-skeleton)) so you don't pay for it if you don't use it.

## Run the simulator

```bash
export TIDEWATER_WEBHOOK_URL=http://localhost:3000/webhooks/tidewater   # your app's webhook endpoint
npm run sim
# dev panel: http://localhost:4010/__sim/panel
```

It starts on port 4010, preloads the events in `seed/tidewater-preload.json`, and sends webhooks to `TIDEWATER_WEBHOOK_URL`. You can also set or change the webhook URL at runtime with `POST /__sim/config`. State is in memory; restart or `POST /__sim/reset` to go back to the preload.

## Point your app at it

| Variable | Default | Used by |
|---|---|---|
| `TIDEWATER_BASE_URL` | `http://localhost:4010` | your app, to call the API |
| `TIDEWATER_SECRET` | `tidewater-dev` | both sides: the simulator signs webhooks with it, your app verifies |
| `TIDEWATER_WEBHOOK_URL` | unset | the simulator: where to POST webhooks |

Each connected volunteer in the seed has a `tidewaterAccountId`. API paths are scoped to it.

## The Tidewater API

All under `/v1/accounts/:accountId`. Timestamps are ISO-8601 **with an offset** (`2026-11-03T16:00:00-06:00` or `...Z`). Naive timestamps are rejected with `400`.

| Method | Path | Body | Response |
|---|---|---|---|
| `GET` | `/events` | | `200 { events: Event[] }` |
| `POST` | `/events` | `{ title, start, end, app_ref? }` | `201 Event` (version 1) |
| `PATCH` | `/events/:id` | `{ title?, start?, end? }` | `200 Event` (version + 1) |
| `DELETE` | `/events/:id` | | `204` |

`Event` is `{ id, version, title, start, end, app_ref }`. `app_ref` is a free-text field (≤ 256 chars) you set at creation; Tidewater stores it and echoes it back. It can't be changed later. Unknown event ids return `404`.

## Webhook contract

On every change to any event, Tidewater POSTs this to `TIDEWATER_WEBHOOK_URL`:

```json
{
  "delivery_id": "dlv_01M5Z7ZZ239Z7W6449HR2XHKNY",
  "type": "event.created | event.updated | event.deleted",
  "occurred_at": "2026-10-21T14:02:11.384Z",
  "event": { "id": "evt_…", "version": 3, "title": "…", "start": "…", "end": "…", "app_ref": "…" }
}
```

Header `X-Tidewater-Signature` is the hex HMAC-SHA256 of the **raw request body** using `TIDEWATER_SECRET`. Verify against the raw bytes, not re-serialized JSON:

```ts
import { createHmac, timingSafeEqual } from "node:crypto";

export function verifyTidewaterSignature(raw: Buffer, header: string | undefined, secret: string) {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}
```

For `event.deleted`, `event` is the event's final state with the version incremented for the delete.

## Rules of the contract

These are the realistic parts. Plan for all of them.

1. **Delivery is at-least-once.** The same `delivery_id` can arrive more than once.
2. **Order is not guaranteed.** A delivery for version 3 can arrive before the one for version 2.
3. **Tidewater emits webhooks for every change, including changes your own app made through the API.** Nothing in the payload says who made the change.
4. **Volunteers edit and delete events directly in their own calendar app.** Those changes arrive as webhooks like any other.
5. **The API fails transiently.** Any call can return `503`. A `503` means nothing was changed.
6. **The API is rate-limited.** Over budget, calls return `429` with `Retry-After: 1`. A `429` means nothing was changed.
7. **Failed deliveries are retried.** If your endpoint returns non-2xx or is unreachable, Tidewater retries a few times with backoff.

## Admin endpoints (simulator only)

Never throttled or failure-injected. The dev panel at `/__sim/panel` drives all of these.

| Method | Path | What it does |
|---|---|---|
| `GET` | `/__sim/config` | Current jitter and failure settings |
| `POST` | `/__sim/config` | Change settings, e.g. `{ "failRate": 0.3 }` (see [simulator/README.md](./simulator/README.md)) |
| `POST` | `/__sim/reset` | Reload the preload, clear the delivery log |
| `GET` | `/__sim/state` | Every event on every account |
| `POST` | `/__sim/accounts/:accountId/events/:id/user-delete` | Volunteer deletes the event on their device |
| `POST` | `/__sim/accounts/:accountId/events/:id/user-edit` | Volunteer edits it: `{ start?, end?, title? }` |
| `GET` | `/__sim/deliveries?event_id=&limit=` | Webhook log, newest first, with raw bodies and every attempt's status |
| `POST` | `/__sim/replay/:deliveryId` | Re-send a delivery with the identical body and `delivery_id` |

## Seed

`seed/data.json` contains `org` (including `coordinators` and `simulatedNow`), `series`, `exceptions`, `volunteers`, and `signups`. Signups reference an occurrence by `(seriesId, originalDate)`, the date the occurrence was originally scheduled. Occurrence instants are not precomputed; expanding the schedule is yours to do.

`seed/tidewater-preload.json` is what's already on volunteers' Tidewater calendars when the simulator starts.

The seed reflects a spreadsheet import. Treat it the way you would treat real imported data.

## What's provided vs. what you build

| Provided | You build |
|---|---|
| Tidewater simulator, its contract, and a dev panel | Your app's data model, API, and UI |
| Seed data and calendar preload | Loading, validating, and expanding the seed |
| Optional skeleton: health check, raw seed import, user list, signature-verified webhook route that only logs | Everything the brief asks for: scheduling, signups, waitlist, sync in both directions, roster |

## What to submit

Everything in BRIEF.md's **Required Deliverables**: the working prototype (deployed or one-command local), mockups for at least one secondary screen, a one-page architecture diagram that matches your code, and the AI Orchestration & Architecture Retro. Plus a README section listing what's complete, stubbed, deferred, and known-broken, and the product calls you made.

### Submission checklist

- [ ] Runs from a clean clone with one documented command, or is deployed at a link we can reach
- [ ] Seed loads automatically or with one documented command
- [ ] Coordinator and volunteer roles reachable through a user switcher
- [ ] Works against this simulator with its default settings, and with `failRate` raised
- [ ] Mockups linked, with what's mocked clearly labeled
- [ ] Architecture diagram included and consistent with the code
- [ ] Retro included, with at least three concrete interventions and one rejected AI output
- [ ] README: complete / stubbed / deferred / known-broken, and your product calls
- [ ] No real credentials, real personal data, or committed secrets

## Optional skeleton

`app-skeleton/` is a minimal MEAN starter. It has no domain logic and you may replace it wholesale.

```bash
npm run skeleton:db                        # MongoDB 7 as a single-node replica set (transactions available)
npm run skeleton:server                    # Express on :3000
curl -X POST localhost:3000/seed           # copies seed/data.json into Mongo as-is

cd app-skeleton/client && npm install && npm start   # Angular on :4200, proxies /api to :3000
```

See [app-skeleton/README.md](./app-skeleton/README.md) for what's in it.

## Troubleshooting

- **`npm error Cannot read properties of null (reading 'edgesOut')`** when adding packages: a known npm 10 bug triggered by vitest 4.1.x as a peer. Pin vitest 4.0.x or use npm 11+.
- **Webhooks show `network-error: ECONNREFUSED`** in the panel: your app isn't listening at `TIDEWATER_WEBHOOK_URL`, or the URL is wrong.
- **Lots of `429`s**: that's the rate limit working. See rule 6.
