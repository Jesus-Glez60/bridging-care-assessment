// Two-way sync engine.
//
// Outbound: a worker claims calendar_links that are pending/retrying (lease + token), derives the call
// from desired vs observed (POST / PATCH / DELETE / nothing), and records the result fenced on its lease.
// Inbound: webhooks and the periodic reconcile both feed applyObservation(), which decides whether a
// change is stale, an echo of our own write, or a real change the volunteer made on their device.
import { randomUUID } from "node:crypto";
import { now } from "../clock";
import { col, tx, type Session } from "../db";
import { markUncertain } from "../domain/signups";
import { addReportEntry } from "../import/normalize";
import type { CalendarLink, EventShape, TwEventPayload } from "../types";
import { ABSENT, APP_REF_PREFIX, converged, refreshLinks, PRIORITY } from "./links";
import type { CallResult, TidewaterClient } from "./tidewater";

const LEASE_MS = 30_000; // > client timeout (10s) + limiter wait, so a lease never expires mid-call in practice
const MAX_BACKOFF_MS = 60_000;
const RING = 5;

export type ObservationType = "event.created" | "event.updated" | "event.deleted";

const shapeOf = (type: ObservationType, e: TwEventPayload): EventShape =>
  type === "event.deleted" ? ABSENT : { present: true, start: e.start, end: e.end, title: e.title };

const realNow = () => new Date();

/**
 * Applies one observed provider state to a link. Idempotent: replays and out-of-order deliveries are
 * dropped by the per-event version guard. Must run inside a transaction.
 * Returns a short outcome string for the delivery log.
 */
export async function applyObservation(appRef: string, type: ObservationType, event: TwEventPayload, session: Session): Promise<string> {
  if (!appRef.startsWith(APP_REF_PREFIX)) return "foreign_app_ref";
  const link = await col.links().findOne({ appRef }, { session });
  if (!link) return "unknown_link";
  if (link.retiredEventIds.includes(event.id)) {
    await col.links().updateOne({ _id: link._id }, { $max: { [`seen.${event.id}`]: event.version } }, { session });
    return "retired_event";
  }

  // Version guard: only the first delivery of a newer version gets past this.
  const guarded = await col.links().findOneAndUpdate(
    { _id: link._id, $or: [{ [`seen.${event.id}`]: { $exists: false } }, { [`seen.${event.id}`]: { $lt: event.version } }] },
    { $set: { [`seen.${event.id}`]: event.version, updatedAt: realNow() } },
    { session, returnDocument: "after" },
  );
  if (!guarded) return "stale_version";

  if (guarded.eventId && guarded.eventId !== event.id && type !== "event.deleted") {
    await col.links().updateOne({ _id: link._id }, { $addToSet: { strays: event.id }, $set: { syncStatus: "pending", nextAttemptAt: realNow() } }, { session });
    return "duplicate_event";
  }

  // A write of ours is in flight: we can't tell our echo from a volunteer edit until it returns.
  if (guarded.leaseUntil > realNow()) {
    if (!guarded.parked || guarded.parked.event.version < event.version) {
      await col.links().updateOne({ _id: link._id }, { $set: { parked: { type, event } } }, { session });
    }
    return "parked_in_flight";
  }
  return decide(guarded, type, event, session);
}

async function decide(link: CalendarLink, type: ObservationType, event: TwEventPayload, session: Session): Promise<string> {
  const observed = { ...shapeOf(type, event), version: event.version };
  const base = { observed, updatedAt: realNow(), parked: null };
  const eventId = type === "event.deleted" ? null : event.id;
  const retire = type === "event.deleted" ? { $addToSet: { retiredEventIds: event.id } } : {};

  if (converged(observed, link.desired)) {
    await col.links().updateOne(
      { _id: link._id },
      { $set: { ...base, eventId, syncStatus: "synced", drift: null, lastSyncedAt: realNow(), attempts: 0, lastError: null }, ...retire },
      { session },
    );
    return "converged";
  }

  if (type !== "event.deleted" && link.sentRing.some((s) => Date.parse(s.start) === Date.parse(event.start) && Date.parse(s.end) === Date.parse(event.end))) {
    // Echo of an older write of ours (a newer one is queued or done). Let the worker re-check.
    await col.links().updateOne({ _id: link._id }, { $set: { ...base, eventId, syncStatus: "pending", nextAttemptAt: realNow() } }, { session });
    return "stale_echo";
  }

  if (!link.desired.present) {
    // We want it gone and it isn't (yet): keep converging.
    await col.links().updateOne({ _id: link._id }, { $set: { ...base, eventId, syncStatus: "pending", nextAttemptAt: realNow() } }, { session });
    return "pending_removal";
  }

  if (type === "event.deleted") {
    // The volunteer removed it on their device. Don't cancel and don't silently re-add: ask them, flag it.
    await col.links().updateOne({ _id: link._id }, { $set: { ...base, eventId: null }, ...retire }, { session });
    await markUncertain(link.signupId, session);
    await refreshLinks([link.signupId], session, PRIORITY.volunteer);
    await col.links().updateOne({ _id: link._id }, { $set: { drift: { kind: "deleted", at: now(), observedStart: null } } }, { session });
    return "volunteer_deleted";
  }

  // The volunteer changed the time on their device. The shift didn't move; flag it for the coordinator.
  await col.links().updateOne(
    { _id: link._id },
    { $set: { ...base, eventId, syncStatus: "drift", drift: { kind: "time", at: now(), observedStart: event.start } } },
    { session },
  );
  return "volunteer_edited_time";
}

function backoff(attempts: number) {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts, 6));
  return base * (0.5 + Math.random() * 0.5);
}

export class SyncWorker {
  private running = false;
  private paused = false;
  private loops: Promise<void>[] = [];
  private reconcileTimer: NodeJS.Timeout | null = null;
  private expiryTimer: NodeJS.Timeout | null = null;
  private reconcileCursor = 0;
  /** Accounts we've listed since boot, to drive the first-sync lookup. */
  constructor(
    private client: TidewaterClient,
    private hooks: { onExpireOffers?: () => Promise<unknown> } = {},
    private opts = { lanes: 3, reconcileMs: 45_000, idleMs: 400 },
  ) {}

  start() {
    if (this.running) return;
    this.running = true;
    for (let i = 0; i < this.opts.lanes; i++) this.loops.push(this.lane());
    this.reconcileTimer = setInterval(() => void this.reconcileNext().catch((e) => console.error("[reconcile]", e)), this.opts.reconcileMs);
    this.expiryTimer = setInterval(() => void this.hooks.onExpireOffers?.().catch((e) => console.error("[offers]", e)), 5_000);
  }

  async stop() {
    this.running = false;
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    await Promise.all(this.loops);
    this.loops = [];
  }

  pause() {
    this.paused = true;
  }
  resume() {
    this.paused = false;
  }

  private async lane() {
    while (this.running) {
      try {
        const did = !this.paused && (await this.runOnce());
        if (!did) await new Promise((r) => setTimeout(r, this.opts.idleMs));
      } catch (e) {
        console.error("[sync] lane error", e);
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
  }

  /** Claims and processes one link. Returns false when there was nothing to do. */
  async runOnce(): Promise<boolean> {
    const token = randomUUID();
    const at = realNow();
    const link = await col.links().findOneAndUpdate(
      { syncStatus: { $in: ["pending", "retrying"] }, nextAttemptAt: { $lte: at }, leaseUntil: { $lt: at } },
      { $set: { leaseUntil: new Date(at.getTime() + LEASE_MS), leaseToken: token } },
      { sort: { priority: -1, nextAttemptAt: 1 }, returnDocument: "after" },
    );
    if (!link) return false;
    try {
      await this.process(link, token);
    } finally {
      await col.links().updateOne({ _id: link._id, leaseToken: token }, { $set: { leaseUntil: new Date(0), leaseToken: null } });
      await this.drainParked(link._id);
    }
    return true;
  }

  private async process(link: CalendarLink, token: string) {
    if (link.needsLookup) {
      const listed = await this.client.list(link.accountId);
      if (listed.kind !== "ok") return this.failed(link, token, listed, false);
      await this.adoptFromListing(link.accountId, listed.body.events);
      const fresh = await col.links().findOne({ _id: link._id, leaseToken: token });
      if (!fresh) return;
      link = fresh;
    }

    if (link.strays.length) {
      const stray = link.strays[0];
      const r = await this.client.remove(link.accountId, stray);
      if (r.kind === "ok" || r.kind === "not_found") {
        await col.links().updateOne({ _id: link._id, leaseToken: token }, { $pull: { strays: stray }, $addToSet: { retiredEventIds: stray }, $set: { nextAttemptAt: realNow() } });
        return;
      }
      return this.failed(link, token, r, false);
    }

    const { desired, observed, eventId } = link;
    if (desired.present && !eventId) {
      const r = await this.client.create(link.accountId, { title: desired.title!, start: desired.start!, end: desired.end!, app_ref: link.appRef });
      if (r.kind === "ok") return this.recordWrite(link, token, r.body, desired);
      // A POST that may or may not have landed: look before creating again, or we'd duplicate.
      return this.failed(link, token, r, r.kind === "ambiguous" || (r.kind === "retryable" && r.status === null));
    }
    if (desired.present && eventId && !converged(observed, desired)) {
      const r = await this.client.patch(link.accountId, eventId, { start: desired.start!, end: desired.end! });
      if (r.kind === "ok") return this.recordWrite(link, token, r.body, desired);
      if (r.kind === "not_found") {
        // Gone from their calendar before our update reached it: same as a volunteer delete.
        await tx(async (session) => {
          const current = await col.links().findOne({ _id: link._id }, { session });
          const v = Math.max(current?.seen[eventId] ?? 0, observed.version) + 1;
          await col.links().updateOne({ _id: link._id }, { $set: { leaseUntil: new Date(0), [`seen.${eventId}`]: v } }, { session });
          await decide({ ...current!, leaseUntil: new Date(0) }, "event.deleted", { id: eventId, version: v, title: "", start: "", end: "", app_ref: link.appRef }, session);
        });
        return;
      }
      return this.failed(link, token, r, false);
    }
    if (!desired.present && eventId) {
      const r = await this.client.remove(link.accountId, eventId);
      if (r.kind === "ok" || r.kind === "not_found") {
        await col.links().updateOne(
          { _id: link._id, leaseToken: token },
          { $set: { eventId: null, observed: { ...ABSENT, version: observed.version + 1 }, syncStatus: "synced", lastSyncedAt: realNow(), attempts: 0, lastError: null }, $addToSet: { retiredEventIds: eventId } },
        );
        return this.settle(link._id);
      }
      return this.failed(link, token, r, false);
    }
    await this.settle(link._id);
  }

  private async recordWrite(link: CalendarLink, token: string, ev: TwEventPayload, sent: EventShape) {
    const ring = [...link.sentRing, { start: sent.start!, end: sent.end! }].slice(-RING);
    await col.links().updateOne(
      { _id: link._id, leaseToken: token },
      {
        $set: { eventId: ev.id, observed: { present: true, start: ev.start, end: ev.end, title: ev.title, version: ev.version }, sentRing: ring, lastSyncedAt: realNow(), attempts: 0, lastError: null },
        $max: { [`seen.${ev.id}`]: ev.version },
      },
    );
    await this.settle(link._id);
  }

  /** After any write, compare against the *current* desired state (it may have changed mid-flight). */
  private async settle(linkId: string) {
    const link = await col.links().findOne({ _id: linkId });
    if (!link || link.syncStatus === "drift") return;
    const volunteer = await col.volunteers().findOne({ _id: link.volunteerId });
    const done = converged(link.observed, link.desired) && link.strays.length === 0;
    await col.links().updateOne(
      { _id: linkId },
      { $set: done ? { syncStatus: volunteer?.calendarConnected ? "synced" : "not_connected" } : { syncStatus: "pending", nextAttemptAt: realNow() } },
    );
  }

  private async failed(link: CalendarLink, token: string, r: CallResult<unknown>, lookUpFirst: boolean) {
    if (r.kind === "rejected") {
      await col.links().updateOne({ _id: link._id, leaseToken: token }, { $set: { syncStatus: "failed", lastError: r.reason } });
      return;
    }
    const reason = r.kind === "retryable" || r.kind === "ambiguous" ? r.reason : r.kind;
    const throttled = r.kind === "retryable" && r.status === 429;
    const attempts = throttled ? link.attempts : link.attempts + 1; // 429 isn't a failure of this job
    const delay = throttled ? (r.kind === "retryable" ? (r.retryAfterMs ?? 1000) : 1000) : backoff(attempts);
    await col.links().updateOne(
      { _id: link._id, leaseToken: token },
      { $set: { syncStatus: "retrying", attempts, lastError: reason, nextAttemptAt: new Date(Date.now() + delay), ...(lookUpFirst ? { needsLookup: true } : {}) } },
    );
  }

  /** First sync for an account: adopt events already on the calendar (preload, or lost responses). */
  private async adoptFromListing(accountId: string, events: TwEventPayload[]) {
    const links = await col.links().find({ accountId }).toArray();
    const byRef = new Map(links.map((l) => [l.appRef, l]));
    const groups = new Map<string, TwEventPayload[]>();
    for (const e of events) {
      if (!e.app_ref?.startsWith(APP_REF_PREFIX)) {
        await addReportEntry({
          severity: "warning",
          code: "calendar_orphan",
          subject: `${accountId} ${e.id}`,
          message: `Event "${e.title}" at ${e.start} has app_ref ${JSON.stringify(e.app_ref)}, which isn't ours.`,
          resolution: "Left alone: we only modify events we can prove we created. A coordinator may want to ask the volunteer about it.",
        });
        continue;
      }
      if (!byRef.has(e.app_ref)) continue; // ours, but for a signup that no longer needs a link (handled by reconcile if relevant)
      groups.set(e.app_ref, [...(groups.get(e.app_ref) ?? []), e]);
    }
    for (const l of links) {
      if (!l.needsLookup) continue;
      const found = (groups.get(l.appRef) ?? []).sort((a, b) => b.version - a.version);
      const [keep, ...extra] = found;
      const set: Partial<CalendarLink> = { needsLookup: false, nextAttemptAt: realNow() };
      if (keep && !l.eventId) {
        set.eventId = keep.id;
        set.observed = { present: true, start: keep.start, end: keep.end, title: keep.title, version: keep.version };
        set.syncStatus = converged(set.observed, l.desired) ? "synced" : "pending";
      }
      await col.links().updateOne(
        { _id: l._id },
        { $set: set, $max: Object.fromEntries(found.map((e) => [`seen.${e.id}`, e.version])), $addToSet: { strays: { $each: extra.map((e) => e.id).filter((id) => id !== l.eventId) } } },
      );
    }
  }

  private async drainParked(linkId: string) {
    const link = await col.links().findOne({ _id: linkId, parked: { $ne: null } });
    if (!link?.parked) return;
    await tx(async (session) => {
      const current = await col.links().findOneAndUpdate({ _id: linkId, parked: { $ne: null } }, { $set: { parked: null } }, { session, returnDocument: "before" });
      if (!current?.parked) return;
      const { type, event } = current.parked;
      // Our own write's echo carries a version we already recorded from the response.
      if (event.version <= (current.seen[event.id] ?? 0) && current.observed.version >= event.version) return;
      await decide({ ...current, parked: null }, type as ObservationType, event, session);
    });
  }

  /** Periodic safety net: webhooks can be lost after the provider's last retry. */
  async reconcileNext() {
    if (this.paused) return;
    const accounts: string[] = (await col.links().distinct("accountId")).sort();
    if (!accounts.length) return;
    const accountId = accounts[this.reconcileCursor++ % accounts.length];
    return this.reconcileAccount(accountId);
  }

  async reconcileAccount(accountId: string) {
    // Snapshot links *before* listing: anything written after the listing started is newer than it.
    const startedAt = realNow();
    const snapshot = await col.links().find({ accountId, needsLookup: false, eventId: { $ne: null } }).toArray();
    const listed = await this.client.list(accountId);
    if (listed.kind !== "ok") return { accountId, ok: false };
    const byId = new Map(listed.body.events.map((e) => [e.id, e]));
    let changes = 0;
    for (const before of snapshot) {
      const e = byId.get(before.eventId!);
      const outcome = await tx(async (session) => {
        const l = await col.links().findOne({ _id: before._id }, { session });
        if (!l || l.eventId !== before.eventId || l.leaseUntil > realNow() || (l.lastSyncedAt && l.lastSyncedAt > startedAt)) return "unchanged";
        if (e) return e.version > (l.seen[e.id] ?? 0) ? applyObservation(l.appRef, "event.updated", e, session) : "unchanged";
        // Missing from the listing: it was deleted and we never heard. Synthesize the delete.
        const v = (l.seen[l.eventId!] ?? l.observed.version) + 1;
        return applyObservation(l.appRef, "event.deleted", { id: l.eventId!, version: v, title: "", start: "", end: "", app_ref: l.appRef }, session);
      });
      if (outcome !== "unchanged" && outcome !== "stale_version") changes++;
    }
    return { accountId, ok: true, changes };
  }
}
