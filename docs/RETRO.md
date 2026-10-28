# AI Orchestration & Architecture Retro

## Tools, by phase

| Phase | Tool | What it did | Handoff |
|---|---|---|---|
| Read the packet, profile the seed | **Claude Code** (Opus), plan mode | Read BRIEF/README/simulator source. Profiled `data.json` and the preload with throwaway scripts: zones, duplicate emails, signups on exceptions, past rows, preload `app_ref`s. | A written plan v1 (data model, sync design, seed traps, build order) |
| Plan review | **Claude Code subagents**: a five-persona "council" (Skeptic, Simplifier, Completeness-checker, Outsider, Opportunity-hunter) + chair, plus architecture, security and engineering-advisor reviewers | Each reviewed plan v1 independently against the actual simulator code. The chair resolved their disagreements explicitly. | Plan v2 with a "Council verdict" section. Most of the sync design changed here (see below). |
| Library docs | **AgentOps** docs index (MCP) | Compose multi-file docs; registered Mongoose, Luxon, Express, Angular docs. | Reference only |
| Backend, sync, tests | **Claude Code** | Wrote the server, the sync engine and the Vitest suites. Ran them against the real simulator in-process and a real Mongo replica set. | Green test suite + a live run of the "move under pressure" scenario before any UI existed |
| UI | **Claude Code** + headless Chrome screenshots | Angular 21 + Tailwind on the provided skeleton. Checked visually from screenshots. | Built client served by the API |
| Mockups | **Claude Code** | A static, clickable HTML page with a MOCKED banner | `/mockups/` |
| Diagram | Mermaid, written by hand against the code | | `docs/ARCHITECTURE.md` |
| Deploy | Docker Compose, nginx + certbot on my own server | | Live URL |

**Prototyping platform vs production tooling.** I did not use v0, Lovable or Bolt. The brief's risk is in the data model and sync, not layout. A generated UI would have needed its data layer rebuilt anyway, and the provided Angular skeleton was already enough of a shell. Everything here is production-shaped code in the target stack; nothing was prototyped elsewhere and ported.

## Where I intervened as the architect

**1. The echo-detection rule was wrong.**
- **AI output.** Plan v1 identified "our own write" by comparing the webhook's version with the version we wrote: "payload equals our desired state at our written version → echo".
- **Why it was wrong.** In the simulator, latency is applied *before* the handler and the webhook is emitted *inside* it, with delivery delay as low as 0 ms. So the webhook for our POST/PATCH routinely arrives before our HTTP response, when we don't know "our version" yet. DELETE returns 204 with no body, so there is never a version to compare. With v1's rule, every coordinator cancellation would have shown up as "volunteer deleted it" ❓.
- **What I did instead.**
  - A per-event version guard handles duplicates and reordering.
  - Echo detection compares *content* against desired state, not versions.
  - An observation that arrives while our call is in flight is **parked** and decided after the response returns.
  - A test (`our own cancellations are not mistaken for volunteer deletes`) runs with webhook delay 0 to force the race.

**2. Dedupe before processing would have lost changes.**
- **AI output.** "Insert `delivery_id`, then process."
- **Why it was wrong.** A crash or 500 between the two leaves the delivery marked as seen. The provider's retry gets a 200 no-op, and a volunteer's delete is lost for good.
- **What I did instead.** The delivery row and its effect are written in one transaction. Any failure returns 503 so the provider retries (`sync/webhook.ts`). I also added the reconcile loop, because the simulator gives up after three attempts no matter what.

**3. The plan cut a required flow first.**
- **AI output.** v1's "cut first if behind" list started with the create-series form.
- **Why it was wrong.** Flow 1 says "Create a recurring shift series with capacity" must work end to end.
- **What I did instead.** Made the form non-cuttable and moved the cuts to polish and secondary screens.

**4. A time-zone bug in generated UI code.**
- **AI output.** The roster formatted offer expiry with Angular's date pipe and a hard-coded `"-0600"` offset.
- **Why it was wrong.** That is wrong for every date before Nov 1, which is exactly the kind of "time displayed in whatever zone" bug the brief warns about.
- **What I did instead.** The server formats every human-facing time in the occurrence's own zone (`formatInstant`). The client never does zone math.

**5. A test that encoded the wrong product behaviour.**
- **AI output.** The first offer-hold test asserted that an offer made at 9 AM Central expires "8 AM next day".
- **Why it was wrong.** The implementation was right: 9 AM plus 12 waking hours is 9 PM the same day. It was the test that was wrong.
- **What I did instead.** I checked the arithmetic by hand before touching the code, fixed the test, and added the 10 AM case (spills into the next morning).

**6. A reconcile race.**
- **AI output.** The first reconcile listed an account's events, then read our links.
- **Why it was wrong.** A link written between those two reads (a POST that just landed) would look "missing from the calendar" and be marked as a volunteer delete.
- **What I did instead.** Snapshot the links *before* listing, and skip any link synced after the listing started.

## One AI output I rejected outright

The council's Simplifier proposed **dropping the client-side rate limiter**, because "the simulator already rate-limits." I rejected it:
- **The provider's bucket is shared.** It is one bucket across every account and verb (`simulator/src/app.ts`).
- **Failures cost budget.** 503s still consume tokens, so at a 40% failure rate retries alone burn the budget.
- **Retries would amplify.** Without a global pause on 429, every retrying job wakes on its own schedule and the 429s compound.

The same reviewer also proposed dropping quiet hours from the offer hold. I rejected that too, because "they won't see it at 11 at night" is the coordinator's most specific complaint about the waitlist.

## What I would not delegate to AI on this system

- **The rule for "who changed this event?"** (echo vs. volunteer change vs. stale), and the transaction boundaries around it. Every generated version looked plausible and had a race. I want a human to own it and a test to force each interleaving.
- **Product calls that change what volunteers experience:** auto-assign vs. hold, "deleting doesn't cancel", what a volunteer's calendar edit means. AI will happily pick one. The coordinator's quotes are what decide it.
- **Reading imported data.** AI is good at *finding* anomalies once pointed at them. Deciding that `"CST"` means Chicago, that a naive `10:00` gets a 2 h assumption, or that two records sharing an email should *not* be merged needs someone accountable for being wrong.
- **What "honest" means for sync status.** I defined it as "never say synced while the calendar disagrees" and built an audit that checks the provider's real state independently. I wouldn't let the same tool that wrote the sync also be the only thing grading it.
