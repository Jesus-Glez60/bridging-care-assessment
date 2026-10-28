# Harbor Light Shift Coordination
### Senior Full-Stack Developer Take-Home — Bridging Care

**Time allotted:** 24 hours from receipt
**Compensation:** Unpaid work sample
**Format:** Repo + runnable or deployed prototype + mockups + diagram + retro

All organizations, people, products, and APIs in this packet are fictitious. Harbor Light Community Kitchen does not exist. "Tidewater Calendar" is an invented API built for this exercise. This exercise exists solely to assess your approach, judgment, and technical fit. It does not produce anything we or any organization we work with will use, and your submission will not be used for any purpose beyond this hiring decision. Do not connect real Google, Microsoft, or Slack accounts, and do not use real personal or organizational data anywhere in your work.

## The Product Vision

Harbor Light Community Kitchen is a small nonprofit in Grand Harbor, a city in the US Central time zone. It runs recurring volunteer shifts — meal prep, dinner service, delivery driving — for about 140 active volunteers, coordinated by two staff members using a spreadsheet and group texts. You are building the **shift-coordination module** of a broader nonprofit-management platform: the piece that lets coordinators run a season of shifts and lets volunteers commit to them, with every commitment landing on the volunteer's own calendar.

We don't have a spec. We have what the volunteer coordinator told us in discovery:

> "Tuesday dinner prep is every week, 4 to 6, through the end of the year. We're dark Thanksgiving week, all shifts. And the first week of December we're prepping on Wednesday instead, because the kitchen's being inspected Tuesday."

> "Spots fill in minutes when I post them. Twice last month two people both thought they had the last spot. One of them drove in for nothing."

> "People want it on their calendar. But then they delete it off their phone and think that counts as cancelling. I find out when they don't show."

> "When somebody drops, the next person on the list should get the spot. But if I just hand it to them automatically at 11 at night, they're not going to see it, and now I've got a spot filled by somebody who doesn't know they're filling it."

> "Our kitchen's in Central, but a lot of our delivery drivers live just across the line in Eastern. The time confusion is constant."

> "I need to see at a glance who's confirmed, who's waitlisted, and who's a question mark."

> "If I move a shift, everybody who signed up needs to know, and it needs to move on their calendar too. Last time I moved one and three people showed up at the old time."

Where this is ambiguous, make a product call and write down why. We're assessing your taste as much as your code.

**For this exercise, "now" is Wednesday, October 21, 2026, 9:00 AM in Grand Harbor.** The seed data is built around that moment and carries it as `org.simulatedNow`. Treat it as the current time wherever your app needs one.

## Core Functional Flows (must work end-to-end in the live demo)

1. **Coordinator runs a season.** Create a recurring shift series with capacity. Cancel one occurrence. Move one occurrence to a different day or time without disturbing the rest of the series or the people already signed up. See a roster per occurrence that distinguishes confirmed, waitlisted, and uncertain.
2. **Volunteer commits.** Browse upcoming shifts in a way that makes the time unambiguous. Sign up, cancel, join a waitlist. When a spot opens, something deliberate happens to the waitlist — you decide what, and defend it.
3. **Calendar sync, both directions.** Connect a Tidewater Calendar. Confirmed shifts appear there; moves and cancellations propagate. When a volunteer removes an event from their own calendar, the system responds in a deliberate way that the coordinator can see.
4. **Move under pressure.** Move an occurrence that has many signed-up volunteers with connected calendars, with the simulator's failure injection turned on. The system should end in an honest state: every affected volunteer's sync status is known, and nothing is silently stale.

## What's provided

The starter repo contains:

- **`simulator/`** — a runnable Tidewater Calendar service. It stores events per account, exposes a small REST API, and sends webhooks to your app. It behaves like a real provider: deliveries are at-least-once, ordering is not guaranteed, it emits webhooks for changes your own app makes, it rate-limits, and it fails transiently. There is a dev panel and admin endpoints to simulate a volunteer editing or deleting an event on their device, to adjust failure rates, and to replay deliveries.
- **`seed/`** — the organization and its two coordinators, the season's shift schedule with exceptions already applied, 140 volunteers, 147 existing signups, and a few events already on volunteers' calendars. The seed reflects a spreadsheet import. Treat it the way you would treat real imported data.
- **`app-skeleton/`** — an optional MEAN starter: an Express + Mongoose server, an Angular + Tailwind client with a user switcher, and MongoDB via Docker. It has no domain logic. Use it, change it, or delete it.
- **`BRIEF.md`** — this document. **`README.md`** — setup, the Tidewater API contract, and the admin endpoints.

## The Vibe Coding Mandate

Use advanced AI tooling, and chain it. A typical strong workflow looks like: UI generator (v0, Lovable, Bolt) for layout and components → agentic IDE (Cursor, Windsurf, Claude Code, Codex) for data model, backend, and sync → diagramming or architecture tooling for the system diagram. MCP integrations are welcome. We are not grading your prompts.

What we *are* grading is whether you caught what the tools got wrong. Generic output has a signature: happy-path-only flows, a toast on every action, time displayed in whatever zone the browser happens to be in, "real-time" claims with no mechanism behind them, and a data model that works until two people click at once. A submission that reads as unedited generator output will not pass regardless of polish. A submission with a correct core and clearly labeled rough edges will.

**This is intentionally more than fits comfortably in a day.** What you build fully, what you stub, and how honestly you label the difference are all part of the evaluation.

## Required Deliverables

1. **Working prototype.** Deployed at a reachable URL, or runnable from a clean clone with one documented command. Seed loads automatically. Both roles available through a simple user switcher (no real auth). Any TypeScript stack: we work in MEAN (MongoDB, Express, Angular, Node), so it's preferred, but stack choice isn't graded. High-polish UI is expected because the tools make it cheap; it is not where the points are.
2. **Interactive mockups for secondary screens** you chose not to build. At minimum one of: volunteer notification preferences (including quiet hours), a season-level attendance overview, or coordinator settings for waitlist behavior. A v0/Lovable/Figma link or clickable prototype is fine. Label clearly what is mocked.
3. **System architecture diagram.** One page. The data model (series, occurrences, signups, external events), both sync directions, where capacity is enforced, and how this prototype becomes production: what changes at 50 nonprofits and 20,000 volunteers, where the queue goes, where the rate limiter lives, what gets observability. Mermaid, Excalidraw, or an image. **It must match what you actually built.**
4. **AI Orchestration & Architecture Retro.** One page or a short screen recording. Which tools for which phase, the handoff points between them, what moved from prototyping platform to production tooling and what you rebuilt. **At least three places you intervened as the architect:** what the AI produced, why it was wrong or insufficient, what you did instead. One AI output you rejected outright. What you would not delegate to AI on this system.

Plus a short **README** section: complete / stubbed / deferred / known-broken, and the product calls you made where the brief was ambiguous.

## Logistics

- 24 hours from receipt. Submit a repo link (plus deployed link if applicable).
- Don't spend money. If a tool you'd normally use would require us to pay to run your submission, use something else.
- No follow-up interview is scheduled automatically. If your submission raises a specific question, we may send you one. Otherwise you'll hear directly whether we're moving forward.
