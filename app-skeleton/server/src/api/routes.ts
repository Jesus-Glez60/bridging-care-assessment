// JSON API for the Angular client. "Auth" is the user switcher: the client sends X-User-Id and we trust
// it (the brief asks for no real auth). Role is derived from the id: coordinators come from org.coordinators.
import express, { type NextFunction, type Request, type Response } from "express";
import { DateTime } from "luxon";
import { advance, now } from "../clock";
import { col, tx } from "../db";
import { cancelOccurrence, createSeries, moveOccurrence } from "../domain/occurrences";
import { acceptOffer, acknowledgeMove, cancelSignup, declineOffer, DomainError, keepAfterCalendarRemoval, signUp, type Actor } from "../domain/signups";
import { PRIORITY, refreshLinks } from "../sync/links";
import { dualTime, formatInstant, formatWindow, zoneLabel } from "../time";
import { ACTIVE_STATUSES, type Occurrence, type Volunteer } from "../types";

type Req = Request & { actor?: Actor & { name: string; tz: string } };

const CHASE_AFTER_MS = 24 * 3600_000;

export interface ApiDeps {
  tidewaterBaseUrl: string;
  resetDemo: () => Promise<unknown>;
}

const wrap = (fn: (req: Req, res: Response) => Promise<unknown>) => (req: Req, res: Response, next: NextFunction) => fn(req, res).catch(next);

export function apiRouter(deps: ApiDeps) {
  const r = express.Router();

  r.get(
    "/users",
    wrap(async (_req, res) => {
      const org = await col.org().findOne({});
      if (!org) return void res.status(409).json({ error: "not_seeded", message: "Seed is still loading." });
      const volunteers = await col.volunteers().find({}, { projection: { name: 1, tz: 1, calendarConnected: 1 } }).toArray();
      volunteers.sort((a, b) => Number(a._id.slice(1)) - Number(b._id.slice(1)));
      res.json({ coordinators: org.coordinators.map((c) => ({ id: c.id, name: c.name })), volunteers: volunteers.map((v) => ({ id: v._id, name: v.name, tz: v.tz })) });
    }),
  );

  // Identify the acting user.
  r.use((req: Req, _res: Response, next: NextFunction) => {
    const id = req.header("x-user-id");
    if (!id) return next();
    (async () => {
      const org = await col.org().findOne({});
      const c = org?.coordinators.find((x) => x.id === id);
      if (c) req.actor = { role: "coordinator", id, name: c.name, tz: org!.tz };
      else {
        const v = await col.volunteers().findOne({ _id: id });
        if (v) req.actor = { role: "volunteer", id, name: v.name, tz: v.tz };
      }
    })().then(() => next(), next);
  });

  const need = (role?: "volunteer" | "coordinator") => (req: Req) => {
    if (!req.actor) throw new DomainError(401, "no_user", "Pick a user in the switcher.");
    if (role && req.actor.role !== role) throw new DomainError(403, "forbidden", `Only ${role}s can do that.`);
    return req.actor;
  };

  r.get(
    "/clock",
    wrap(async (_req, res) => {
      const org = await col.org().findOne({});
      const n = now();
      res.json({ now: n.toISOString(), kitchen: DateTime.fromJSDate(n, { zone: org!.tz }).toFormat("cccc, LLL d · h:mm a") + " " + zoneLabel(org!.tz), tz: org!.tz });
    }),
  );

  r.get(
    "/me",
    wrap(async (req, res) => {
      const actor = need()(req);
      const org = await col.org().findOne({});
      if (actor.role === "coordinator") return void res.json({ ...actor, kitchenTz: org!.tz });
      const v = await col.volunteers().findOne({ _id: actor.id });
      res.json({ ...actor, kitchenTz: org!.tz, tzSource: v!.tzSource, calendarConnected: v!.calendarConnected, tidewaterAccountId: v!.tidewaterAccountId, zoneLabel: zoneLabel(v!.tz) });
    }),
  );

  // ---------- volunteer ----------

  r.get(
    "/shifts",
    wrap(async (req, res) => {
      const actor = need()(req);
      const n = now();
      const occs = await col.occurrences().find({ end: { $gt: n } }).sort({ start: 1 }).toArray();
      const mine = actor.role === "volunteer" ? await col.signups().find({ volunteerId: actor.id, occurrenceId: { $in: occs.map((o) => o._id) } }).toArray() : [];
      const waitCounts = await col.signups().aggregate<{ _id: string; n: number }>([{ $match: { status: "waitlisted", occurrenceId: { $in: occs.map((o) => o._id) } } }, { $group: { _id: "$occurrenceId", n: { $sum: 1 } } }]).toArray();
      const waitBy = new Map(waitCounts.map((w) => [w._id, w.n]));
      const links = actor.role === "volunteer" ? await col.links().find({ volunteerId: actor.id }).toArray() : [];
      const out = [];
      for (const o of occs) {
        const signups = mine.filter((s) => s.occurrenceId === o._id).sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        const active = signups.find((s) => ACTIVE_STATUSES.includes(s.status)) ?? null;
        const latest = active ?? signups[0] ?? null;
        let waitlistPosition: number | null = null;
        if (active?.status === "waitlisted") waitlistPosition = await col.signups().countDocuments({ occurrenceId: o._id, status: "waitlisted", rank: { $lte: active.rank } });
        const link = latest ? links.find((l) => l._id === latest._id) : null;
        out.push({
          ...shiftView(o, actor.tz),
          spotsLeft: Math.max(0, o.capacity - o.occupied),
          waitlisted: waitBy.get(o._id) ?? 0,
          mine: latest && {
            signupId: latest._id,
            status: latest.status,
            cancelReason: latest.cancelReason,
            offerExpiresAt: latest.offerExpiresAt,
            offerExpiresLabel: latest.offerExpiresAt ? DateTime.fromJSDate(latest.offerExpiresAt, { zone: actor.tz }).toFormat("ccc h:mm a") + " " + zoneLabel(actor.tz) : null,
            waitlistPosition,
            moveUnacknowledged: !!active && o.movedFrom !== null && active.ackVersion < o.version,
            calendar: link ? { status: link.syncStatus, lastError: link.lastError } : null,
          },
        });
      }
      res.json({ shifts: out });
    }),
  );

  r.post(
    "/occurrences/:id/signup",
    wrap(async (req, res) => {
      const actor = need("volunteer")(req);
      const result = await signUp(actor.id, String(req.params.id));
      res.status(201).json({ status: result.signup.status, signupId: result.signup._id, waitlistPosition: result.waitlistPosition });
    }),
  );

  for (const [path, fn] of [
    ["cancel", (id: string, a: Actor) => cancelSignup(id, a)],
    ["accept", acceptOffer],
    ["decline", declineOffer],
    ["keep", keepAfterCalendarRemoval],
    ["ack-move", acknowledgeMove],
  ] as const) {
    r.post(
      `/signups/:id/${path}`,
      wrap(async (req, res) => {
        const actor = need()(req);
        res.json((await fn(String(req.params.id), actor)) ?? { ok: true });
      }),
    );
  }

  r.get(
    "/notifications",
    wrap(async (req, res) => {
      const actor = need("volunteer")(req);
      const items = await col.notifications().find({ volunteerId: actor.id }).sort({ createdAt: -1 }).limit(50).toArray();
      res.json({ notifications: items.map((n) => ({ ...n, id: String(n._id) })) });
    }),
  );

  r.post(
    "/notifications/read",
    wrap(async (req, res) => {
      const actor = need("volunteer")(req);
      await col.notifications().updateMany({ volunteerId: actor.id, readAt: null }, { $set: { readAt: now() } });
      res.json({ ok: true });
    }),
  );

  for (const action of ["connect", "disconnect"] as const) r.post(
    `/calendar/${action}`,
    wrap(async (req, res) => {
      const actor = need("volunteer")(req);
      const connect = action === "connect";
      await tx(async (session) => {
        const v = await col.volunteers().findOne({ _id: actor.id }, { session });
        const accountId = v!.tidewaterAccountId ?? `tw_${actor.id.toLowerCase()}`; // demo: any account id is valid in the simulator
        await col.volunteers().updateOne({ _id: actor.id }, { $set: { calendarConnected: connect, tidewaterAccountId: accountId } }, { session });
        const signups = await col.signups().find({ volunteerId: actor.id, status: "confirmed" }, { session }).toArray();
        // Disconnect removes our events from their calendar (desired.present=false) before we stop syncing.
        await refreshLinks(signups.map((s) => s._id), session, PRIORITY.volunteer);
      });
      res.json({ ok: true, connected: connect });
    }),
  );

  // ---------- coordinator ----------

  r.get(
    "/series",
    wrap(async (req, res) => {
      need("coordinator")(req);
      res.json({ series: await col.series().find({}).sort({ _id: 1 }).toArray() });
    }),
  );

  r.post(
    "/series",
    wrap(async (req, res) => {
      need("coordinator")(req);
      const org = await col.org().findOne({});
      res.status(201).json(await createSeries(req.body, org!.tz));
    }),
  );

  r.get(
    "/season",
    wrap(async (req, res) => {
      const actor = need("coordinator")(req);
      const occs = await col.occurrences().find({}).sort({ start: 1 }).toArray();
      const counts = await col.signups().aggregate<{ _id: { o: string; s: string }; n: number }>([{ $group: { _id: { o: "$occurrenceId", s: "$status" }, n: { $sum: 1 } } }]).toArray();
      const linkIssues = await col.links().aggregate<{ _id: { o: string; s: string }; n: number }>([{ $match: { syncStatus: { $ne: "synced" } } }, { $group: { _id: { o: "$occurrenceId", s: "$syncStatus" }, n: { $sum: 1 } } }]).toArray();
      const n = now();
      res.json({
        occurrences: occs.map((o) => {
          const c = (s: string) => counts.find((x) => x._id.o === o._id && x._id.s === s)?.n ?? 0;
          const sync: Record<string, number> = {};
          for (const li of linkIssues.filter((x) => x._id.o === o._id)) sync[li._id.s] = li.n;
          return { ...shiftView(o, actor.tz), past: o.end <= n, confirmed: c("confirmed"), waitlisted: c("waitlisted"), offered: c("offered"), uncertain: c("uncertain"), sync };
        }),
      });
    }),
  );

  r.get(
    "/occurrences/:id/roster",
    wrap(async (req, res) => {
      const actor = need("coordinator")(req);
      const occ = await col.occurrences().findOne({ _id: String(req.params.id) });
      if (!occ) throw new DomainError(404, "not_found", "No such shift.");
      const signups = await col.signups().find({ occurrenceId: occ._id }).sort({ rank: 1 }).toArray();
      const vols = new Map((await col.volunteers().find({ _id: { $in: signups.map((s) => s.volunteerId) } }).toArray()).map((v) => [v._id, v]));
      const links = new Map((await col.links().find({ occurrenceId: occ._id }).toArray()).map((l) => [l._id, l]));
      const n = now();
      let waitPos = 0;
      res.json({
        shift: { ...shiftView(occ, actor.tz), capacity: occ.capacity, occupied: occ.occupied },
        roster: signups.map((s) => {
          const v = vols.get(s.volunteerId) as Volunteer;
          const l = links.get(s._id);
          return {
            signupId: s._id,
            volunteerId: s.volunteerId,
            name: v.name,
            tz: v.tz,
            tzSource: v.tzSource,
            localTime: dualTime(occ.start, occ.end, occ.tz, v.tz).viewer,
            status: s.status,
            cancelReason: s.cancelReason,
            waitlistPosition: s.status === "waitlisted" ? ++waitPos : null,
            offerExpiresAt: s.offerExpiresAt,
            offerExpiresLabel: s.offerExpiresAt ? formatInstant(s.offerExpiresAt, occ.tz) : null,
            uncertainSince: s.uncertainSince,
            chase: s.status === "uncertain" && !!s.uncertainSince && n.getTime() - s.uncertainSince.getTime() > CHASE_AFTER_MS,
            moveAcknowledged: occ.movedFrom ? s.ackVersion >= occ.version : null,
            calendar: !v.calendarConnected && !l ? { status: "not_connected" } : l ? { status: l.syncStatus, attempts: l.attempts, lastError: l.lastError, drift: l.drift, nextAttemptAt: l.nextAttemptAt, eventId: l.eventId } : { status: "none" },
            source: s.source,
          };
        }),
      });
    }),
  );

  r.post(
    "/occurrences/:id/cancel",
    wrap(async (req, res) => {
      need("coordinator")(req);
      res.json(await cancelOccurrence(String(req.params.id), req.body?.note ? String(req.body.note).slice(0, 200) : null));
    }),
  );

  r.post(
    "/occurrences/:id/move",
    wrap(async (req, res) => {
      need("coordinator")(req);
      res.json(await moveOccurrence(String(req.params.id), req.body ?? {}));
    }),
  );

  r.post(
    "/links/:id/retry",
    wrap(async (req, res) => {
      need("coordinator")(req);
      // Manual retry for failed links, and "re-push" for drifted ones (calendar shows a time the volunteer edited).
      const ok = await col.links().updateOne(
        { _id: String(req.params.id), syncStatus: { $in: ["failed", "drift", "retrying"] } },
        { $set: { syncStatus: "pending", drift: null, nextAttemptAt: new Date(), attempts: 0, priority: PRIORITY.coordinator } },
      );
      res.json({ ok: ok.modifiedCount === 1 });
    }),
  );

  r.get(
    "/sync/summary",
    wrap(async (req, res) => {
      need("coordinator")(req);
      const byStatus = await col.links().aggregate<{ _id: string; n: number }>([{ $group: { _id: "$syncStatus", n: { $sum: 1 } } }]).toArray();
      const recent = await col.deliveries().find({}).sort({ receivedAt: -1 }).limit(15).toArray();
      res.json({ byStatus: Object.fromEntries(byStatus.map((b) => [b._id, b.n])), recentDeliveries: recent });
    }),
  );

  // Independent check: compare what we believe should be on each calendar with what Tidewater actually has.
  r.get(
    "/sync/audit",
    wrap(async (req, res) => {
      need("coordinator")(req);
      const state = (await (await fetch(`${deps.tidewaterBaseUrl}/__sim/state`)).json()) as { accounts: Record<string, { id: string; start: string; end: string; app_ref: string | null; title: string }[]> };
      const links = await col.links().find({}).toArray();
      const vols = new Map((await col.volunteers().find({}).toArray()).map((v) => [v._id, v]));
      const occs = new Map((await col.occurrences().find({}).toArray()).map((o) => [o._id, o]));
      const rows = links.map((l) => {
        const actual = (state.accounts[l.accountId] ?? []).filter((e) => e.app_ref === l.appRef);
        const want = l.desired;
        let verdict: string;
        if (!want.present) verdict = actual.length === 0 ? "ok" : "should_be_absent";
        else if (actual.length === 0) verdict = "missing";
        else if (actual.length > 1) verdict = "duplicate";
        else verdict = Date.parse(actual[0].start) === Date.parse(want.start!) && Date.parse(actual[0].end) === Date.parse(want.end!) ? "ok" : "wrong_time";
        const o = occs.get(l.occurrenceId)!;
        return {
          signupId: l._id,
          volunteer: vols.get(l.volunteerId)?.name,
          shift: `${o.title} · ${formatWindow(o.start, o.end, o.tz)}`,
          desired: want.present ? want.start : "(absent)",
          actual: actual.map((a) => a.start),
          appStatus: l.syncStatus,
          verdict,
          // Honest = the app does not claim "synced" while the calendar disagrees.
          honest: verdict === "ok" || l.syncStatus !== "synced",
        };
      });
      res.json({ checkedAt: new Date().toISOString(), mismatches: rows.filter((r) => r.verdict !== "ok").length, dishonest: rows.filter((r) => !r.honest).length, rows });
    }),
  );

  r.get(
    "/import-report",
    wrap(async (req, res) => {
      need("coordinator")(req);
      res.json({ entries: await col.report().find({}).sort({ severity: 1, code: 1, subject: 1 }).toArray() });
    }),
  );

  // ---------- dev controls (demo only) ----------

  r.post(
    "/dev/advance",
    wrap(async (req, res) => {
      const hours = Number(req.body?.hours);
      if (!Number.isFinite(hours) || hours <= 0 || hours > 24 * 14) throw new DomainError(400, "invalid", "hours must be between 0 and 336");
      res.json({ now: (await advance(hours * 3600_000)).toISOString() });
    }),
  );

  let lastReset = 0;
  r.post(
    "/dev/reset",
    wrap(async (_req, res) => {
      if (Date.now() - lastReset < 60_000) throw new DomainError(429, "cooldown", "Reset was used less than a minute ago.");
      lastReset = Date.now();
      res.json(await deps.resetDemo());
    }),
  );

  r.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof DomainError) return void res.status(err.status).json({ error: err.code, message: err.message });
    const e = err as { code?: number; message?: string };
    if (e.code === 11000) return void res.status(409).json({ error: "conflict", message: "That was just done by another request. Refresh to see the latest." });
    console.error(err);
    res.status(500).json({ error: "internal", message: "Something went wrong." });
  });

  return r;
}

function shiftView(o: Occurrence, viewerTz: string) {
  const t = dualTime(o.start, o.end, o.tz, viewerTz);
  return {
    id: o._id,
    seriesId: o.seriesId,
    title: o.title,
    status: o.status,
    start: o.start,
    end: o.end,
    tz: o.tz,
    kitchenTime: t.kitchen,
    yourTime: t.viewer,
    localDate: DateTime.fromJSDate(o.start, { zone: o.tz }).toISODate(),
    localStart: DateTime.fromJSDate(o.start, { zone: o.tz }).toFormat("HH:mm"),
    localEnd: DateTime.fromJSDate(o.end, { zone: o.tz }).toFormat("HH:mm"),
    movedFrom: o.movedFrom ? formatWindow(o.movedFrom.start, o.movedFrom.end, o.tz) : null,
    note: o.note,
    capacity: o.capacity,
  };
}
