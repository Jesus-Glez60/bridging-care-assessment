# Harbor Light: shift coordination with two-way calendar sync

A working prototype for the Bridging Care take-home: coordinators run a season of shifts, volunteers commit to them, and every commitment lands on the volunteer's (simulated) Tidewater calendar and stays honest when the calendar or the network misbehaves.

- **Live demo:** https://harbor.agentops.dedyn.io (until Nov 10, 2026). The simulator panel at `/__sim/panel` is behind basic auth; the credentials are in the submission email.
- **Run locally:** `docker compose up --build`, then open http://localhost:3000. The simulator panel is at http://localhost:4010/__sim/panel. The seed loads automatically on first start.
- **Docs:** [architecture diagram](docs/ARCHITECTURE.md) · [AI orchestration retro](docs/RETRO.md) · [mockups](mockups/index.html) (served at `/mockups/`) · [original starter README](docs/STARTER-README.md)

Use the switcher in the header to pick a coordinator (Rosa, Malik) or any volunteer. Deep link: `/coordinator?as=C01`, `/volunteer?as=V04`. V04 (Lena, Eastern, calendar connected) is the default.

---

## Status

### Complete (works end-to-end, covered by tests)
| Flow | Where |
|---|---|
| Seed import that treats the spreadsheet as untrusted: raw rows kept in `raw_*`, a cleaning pass, and an **Import report** listing every judgement call (20 entries) | `server/src/import/normalize.ts`, Coordinator → Import report |
| Recurring series expanded in the kitchen's zone, stable across the Nov 1 DST change; exceptions (cancelled, moved) applied | `server/src/time.ts`, `domain/occurrences.ts` |
| Create a series (weekly or one-off) · cancel one occurrence · move one occurrence without touching the series or its signups | Coordinator → New series / Move… / Cancel shift… |
| Roster per occurrence: confirmed / waitlisted (with position) / offered (with hold expiry) / ❓ uncertain (with "follow up" after 24 h) / move acknowledged / calendar status per person | Coordinator → Shifts & rosters |
| Capacity that holds under concurrency: a conditional `$inc` inside a transaction (test: 25 parallel signups for 1 seat → exactly 1 confirmed) | `domain/signups.ts` |
| Waitlist: a freed seat is **held** for #1, with a hold that pauses overnight in *their* zone; decline/expiry passes it on | `domain/signups.ts`, `time.ts#offerExpiry` |
| Calendar sync out: create / move / delete, adoption of pre-existing events by `app_ref`, 429/503/timeout handling, priority for coordinator actions over backfill | `server/src/sync/engine.ts`, `sync/tidewater.ts` |
| Calendar sync in: signed webhooks, dedupe by `delivery_id` in the same transaction as the effect, per-event version guard (reordering), echo detection, volunteer delete → ❓, volunteer time edit → "calendar edited" flag | `sync/webhook.ts`, `sync/engine.ts#applyObservation` |
| Reconcile loop that catches deletes whose webhooks were lost | `SyncWorker.reconcileAccount` |
| **Sync audit**: compares the app's desired state with the simulator's real state and counts "dishonest" links (the app says synced, but the calendar disagrees) | Coordinator → Calendar sync → Run check |
| Times shown as kitchen time first, plus the volunteer's own time when it differs. The browser's zone is never used. | everywhere |

### Stubbed
- **Auth:** none, by design. The client sends `X-User-Id` from the switcher and the server trusts it.
- **"Connect calendar"** for a volunteer with no Tidewater account invents `tw_<id>`. The simulator accepts any account id.
- **Notifications** are in-app only. Email and SMS are not sent and not logged.
- **Demo controls** in the header: "+6 h / +1 day" advance the business clock, and "Reset demo data" reseeds and restores the simulator. They are unauthenticated and rate-limited to one reset per minute.

### Deferred (mocked at `/mockups/`, clearly labelled)
- Volunteer notification preferences and per-person quiet hours. The built system uses a fixed 9 PM–8 AM window.
- Coordinator settings for waitlist behaviour, including the two rules I chose not to build: "first to accept wins" near the shift, and shorter holds within 24 h.
- Season attendance overview (needs check-in data the prototype doesn't collect).
- Editing capacity or series-wide changes, reminders, a volunteer-side prompt for a calendar *time* edit (today only the coordinator sees it).

### Known limitations / broken
- **Reconcile is slow by design.** One account every 45 s, so a full sweep of ~84 accounts takes about an hour. A webhook the simulator gives up on is caught eventually, not quickly.
- **The rate limiter is per process** (8 req/s, max 3 in flight, global pause on 429). Two app instances would together exceed the provider's budget. See the scale section of the architecture doc.
- **Recovery from a lost POST response** (look up by `app_ref` before re-creating) is tested only with a fake transport, because the simulator can't drop a response after committing.
- **Move validation checks only collisions with the same series.** A move that double-books a volunteer against another series isn't flagged. (Signup-time overlap *is* checked.)
- **Within 2 h of a shift, no offers are made.** A freed seat goes to whoever signs up first, so the waitlist can be bypassed in that window.
- **The business clock runs forward in real time** from `simulatedNow`. Advancing it is one-way until a reset.
- **Sync tests take about 2 minutes** and need MongoDB running (`npm run skeleton:db` or the compose mongo).

## Product calls (where the brief was ambiguous)

1. **When a spot opens, hold it for the next person and ask; don't auto-assign.** "If I just hand it to them automatically at 11 at night… they're not going to see it." The hold is 12 *waking* hours in the volunteer's own time zone: the clock pauses 9 PM–8 AM, and the hold never runs past 2 h before the shift. While the offer is out it holds the seat, so nobody can take it from under them.
2. **Deleting the event from your calendar doesn't cancel.** The signup becomes ❓ *uncertain*. The volunteer gets "Removing it there doesn't cancel. Are you still coming?" with **I'm still coming (re-add)** / **Cancel my spot**. The coordinator sees ❓ in the roster and a "follow up" flag after 24 h with no answer. We never auto-cancel and never silently re-add.
3. **The app owns the time; the volunteer owns the title.** Imported su_0141 had a user-edited title ("bring apron") on a stale date. Sync moved it to the right day and kept their title. If a volunteer edits the *time* on their device, the shift doesn't move. The coordinator sees "volunteer changed it to 19:00" and can re-push.
4. **Kitchen time is the primary time.** Every shift shows the kitchen's time (that's when the door opens) with the zone label, plus the volunteer's own time when it differs. Phoenix, Indianapolis and the null-zone volunteer were all handled from the seed.
5. **Only confirmed shifts go on calendars.** Waitlisted or offered volunteers get nothing on their calendar until they hold a seat.
6. **Disconnecting a calendar removes our events from it** before syncing stops.
7. **We only modify events we can prove we created** (`app_ref` starting `hl:signup:`). `legacy-import-0417` on V02's calendar is reported as an orphan and left alone.
8. **Seed data is never silently trusted.** Highlights from the import report:
   - **Series E:** a naive `2026-11-14 10:00` with no zone or end. Read as Central, 2 h assumed, flagged "needs review".
   - **Time zones:** `"CST"` mapped to Chicago and flagged; a null zone defaults to kitchen time.
   - **V07/V88:** the same email in different case. Flagged, not merged.
   - **su_0097:** a confirmed signup on a cancelled Thanksgiving shift becomes "cancelled by org", with a notification.
   - **V44:** double-booked on Nov 14 (Pantry and Saturday delivery overlap). Flagged.
   - **Waitlist order:** taken from `createdAt`.

## Demo runbook: move under pressure (Flow 4)

1. **Coordinator → Shifts & rosters → Tue Dec 8 Dinner Prep.** There are 8 confirmed; 6 have connected calendars and 2 don't.
2. **Raise failures.** Simulator panel, or `curl -X POST localhost:4010/__sim/config -H 'content-type: application/json' -d '{"failRate":0.4,"duplicateRate":0.5,"reorderRate":0.5}'`.
3. **Move the shift** to 5–7 PM. The roster refreshes every 2 s, and each person shows ✓ on calendar, retrying (attempt n: provider unavailable (503)), or no calendar. Nobody shows ✓ with the old time.
4. **Set `failRate` back to 0.** Within about a minute, every row is ✓. Calendar sync → Run check should show **0 mismatches, 0 dishonest**.
5. **Volunteer deletes the event.** In the simulator panel, delete one of those events ("user delete"). The roster shows ❓ for that person. Switch to them as a volunteer to see the prompt, then choose "I'm still coming" and the event is re-added.

Pass/fail: *converged* means the audit shows 0 mismatches within 60 s of restoring `failRate` to 0. *Honest* means the audit's "dishonest" count is 0 at **any** moment, including mid-failure.

## Development

```bash
npm install                                   # simulator + server (workspaces)
npm run skeleton:db                           # MongoDB 7 single-node replica set on :27017
TIDEWATER_WEBHOOK_URL=http://localhost:3000/webhooks/tidewater npm run sim
npm run skeleton:server                       # API + worker on :3000 (seeds itself on an empty DB)
cd app-skeleton/client && npm install && npm start   # Angular on :4200 (proxies /api)
npm test                                      # 21 tests: time/DST, capacity race, waitlist, sync vs the real simulator
```

The code lives in `app-skeleton/` because I extended the provided skeleton rather than replacing it (its signature check, raw seed staging, user switcher and proxy are all still in use).
