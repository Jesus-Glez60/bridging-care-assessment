// Signups, capacity and the waitlist. Capacity is enforced by a conditional $inc on occurrence.occupied
// inside the same transaction that writes the signup, so two people can never both get the last seat.
import { randomUUID } from "node:crypto";
import { now } from "../clock";
import { col, tx, type Session } from "../db";
import { notify } from "../notify";
import { PRIORITY, refreshLinks } from "../sync/links";
import { formatInstant, formatWindow, OFFER_CUTOFF_HOURS, offerExpiry } from "../time";
import { ACTIVE_STATUSES, SEATED_STATUSES, type Occurrence, type Signup, type SignupStatus } from "../types";

export class DomainError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type Actor = { role: "volunteer" | "coordinator"; id: string };

const MIN_OFFER_WINDOW_MS = 30 * 60_000;

async function takeSeat(occId: string, session: Session) {
  const res = await col.occurrences().findOneAndUpdate(
    { _id: occId, status: "scheduled", $expr: { $lt: ["$occupied", "$capacity"] } },
    { $inc: { occupied: 1 } },
    { session },
  );
  return res !== null;
}

async function releaseSeat(occId: string, session: Session) {
  await col.occurrences().updateOne({ _id: occId, occupied: { $gt: 0 } }, { $inc: { occupied: -1 } }, { session });
}

/** Moves a signup between statuses only if it is still in one of `from`. Returns the previous doc. */
async function transition(signupId: string, from: SignupStatus[], set: Partial<Signup>, session: Session) {
  return col.signups().findOneAndUpdate({ _id: signupId, status: { $in: from } }, { $set: { ...set, updatedAt: now() } }, { session });
}

/**
 * Offers open seats to the waitlist in rank order. The offer holds the seat; the hold pauses during the
 * volunteer's quiet hours and never runs past OFFER_CUTOFF_HOURS before the shift. If there is not enough
 * time left for a meaningful offer, the seat stays open for whoever signs up first.
 */
export async function fillOpenSeats(occId: string, session: Session) {
  for (;;) {
    const occ = await col.occurrences().findOne({ _id: occId }, { session });
    if (!occ || occ.status !== "scheduled" || occ.occupied >= occ.capacity) return;
    const next = await col.signups().findOne({ occurrenceId: occId, status: "waitlisted" }, { session, sort: { rank: 1, _id: 1 } });
    if (!next) return;
    const volunteer = await col.volunteers().findOne({ _id: next.volunteerId }, { session });
    const at = now();
    const cutoff = new Date(occ.start.getTime() - OFFER_CUTOFF_HOURS * 3600_000);
    let expires = offerExpiry(at, volunteer?.tz ?? occ.tz);
    if (expires > cutoff) expires = cutoff;
    if (expires.getTime() - at.getTime() < MIN_OFFER_WINDOW_MS) return;
    if (!(await takeSeat(occId, session))) return;
    await transition(next._id, ["waitlisted"], { status: "offered", offeredAt: at, offerExpiresAt: expires }, session);
    await notify(session, {
      volunteerId: next.volunteerId,
      kind: "offer",
      occurrenceId: occId,
      signupId: next._id,
      message: `A spot opened for ${occ.title} (${formatWindow(occ.start, occ.end, occ.tz)}). It's held for you until ${formatInstant(expires, volunteer?.tz ?? occ.tz)} — accept or pass.`,
    });
  }
}

async function assertNoOverlap(volunteerId: string, occ: Occurrence, session: Session, excludeSignupId?: string) {
  const mine = await col.signups()
    .find({ volunteerId, status: { $in: SEATED_STATUSES }, _id: { $ne: excludeSignupId ?? "" } }, { session })
    .toArray();
  if (!mine.length) return;
  const clash = await col.occurrences().findOne(
    { _id: { $in: mine.map((s) => s.occurrenceId), $ne: occ._id }, status: "scheduled", start: { $lt: occ.end }, end: { $gt: occ.start } },
    { session },
  );
  if (clash) throw new DomainError(409, "overlap", `You're already signed up for ${clash.title} at an overlapping time (${formatWindow(clash.start, clash.end, clash.tz)}).`);
}

export async function signUp(volunteerId: string, occurrenceId: string) {
  return tx(async (session) => {
    const occ = await col.occurrences().findOne({ _id: occurrenceId }, { session });
    if (!occ) throw new DomainError(404, "not_found", "No such shift.");
    if (occ.status !== "scheduled") throw new DomainError(409, "cancelled", "This shift was cancelled.");
    if (occ.start <= now()) throw new DomainError(409, "started", "This shift has already started.");
    const existing = await col.signups().findOne({ occurrenceId, volunteerId, status: { $in: ACTIVE_STATUSES } }, { session });
    if (existing) throw new DomainError(409, "already_signed_up", `You're already ${existing.status} for this shift.`);
    await assertNoOverlap(volunteerId, occ, session);

    const seated = await takeSeat(occurrenceId, session);
    const at = now();
    const signup: Signup = {
      _id: `su_${randomUUID().slice(0, 8)}`,
      occurrenceId,
      volunteerId,
      status: seated ? "confirmed" : "waitlisted",
      rank: at,
      createdAt: at,
      updatedAt: at,
      offeredAt: null,
      offerExpiresAt: null,
      uncertainSince: null,
      cancelReason: null,
      ackVersion: occ.version,
      source: "app",
    };
    await col.signups().insertOne(signup, { session });
    if (seated) await refreshLinks([signup._id], session, PRIORITY.volunteer);
    const position = seated ? null : await col.signups().countDocuments({ occurrenceId, status: "waitlisted", rank: { $lte: at } }, { session });
    return { signup, waitlistPosition: position };
  });
}

async function loadOwned(signupId: string, actor: Actor, session: Session) {
  const s = await col.signups().findOne({ _id: signupId }, { session });
  if (!s) throw new DomainError(404, "not_found", "No such signup.");
  if (actor.role === "volunteer" && s.volunteerId !== actor.id) throw new DomainError(403, "forbidden", "Not your signup.");
  return s;
}

export async function cancelSignup(signupId: string, actor: Actor, reason?: string) {
  return tx(async (session) => {
    const s = await loadOwned(signupId, actor, session);
    const prev = await transition(signupId, ACTIVE_STATUSES, { status: "cancelled", cancelReason: reason ?? `cancelled_by_${actor.role}`, offerExpiresAt: null }, session);
    if (!prev) throw new DomainError(409, "not_active", `This signup is already ${s.status}.`);
    if (SEATED_STATUSES.includes(prev.status)) {
      await releaseSeat(prev.occurrenceId, session);
      await fillOpenSeats(prev.occurrenceId, session);
    }
    await refreshLinks([signupId], session, actor.role === "coordinator" ? PRIORITY.coordinator : PRIORITY.volunteer);
    return { previousStatus: prev.status };
  });
}

export async function acceptOffer(signupId: string, actor: Actor) {
  return tx(async (session) => {
    const s = await loadOwned(signupId, actor, session);
    const occ = await col.occurrences().findOne({ _id: s.occurrenceId }, { session });
    if (!occ || occ.status !== "scheduled") throw new DomainError(409, "cancelled", "This shift was cancelled.");
    await assertNoOverlap(s.volunteerId, occ, session, signupId);
    const prev = await col.signups().findOneAndUpdate(
      { _id: signupId, status: "offered", offerExpiresAt: { $gt: now() } },
      { $set: { status: "confirmed", offerExpiresAt: null, updatedAt: now(), ackVersion: occ.version } },
      { session },
    );
    if (!prev) throw new DomainError(409, "offer_gone", "This offer has expired or was withdrawn.");
    await refreshLinks([signupId], session, PRIORITY.volunteer);
  });
}

export async function declineOffer(signupId: string, actor: Actor) {
  return tx(async (session) => {
    await loadOwned(signupId, actor, session);
    const prev = await transition(signupId, ["offered"], { status: "cancelled", cancelReason: "declined_offer", offerExpiresAt: null }, session);
    if (!prev) throw new DomainError(409, "offer_gone", "This offer has expired or was withdrawn.");
    await releaseSeat(prev.occurrenceId, session);
    await fillOpenSeats(prev.occurrenceId, session);
  });
}

/** Runs from the worker tick. Each expiry is its own transaction. */
export async function expireOffers() {
  const due = await col.signups().find({ status: "offered", offerExpiresAt: { $lte: now() } }).limit(50).toArray();
  for (const s of due) {
    await tx(async (session) => {
      const prev = await col.signups().findOneAndUpdate(
        { _id: s._id, status: "offered", offerExpiresAt: { $lte: now() } },
        { $set: { status: "cancelled", cancelReason: "offer_expired", updatedAt: now() } },
        { session },
      );
      if (!prev) return;
      await releaseSeat(prev.occurrenceId, session);
      await notify(session, {
        volunteerId: prev.volunteerId,
        kind: "offer_expired",
        occurrenceId: prev.occurrenceId,
        signupId: prev._id,
        message: "Your held spot expired and went to the next person on the waitlist. You can rejoin the waitlist from the shift list.",
      });
      await fillOpenSeats(prev.occurrenceId, session);
    });
  }
  return due.length;
}

/** Volunteer removed the event from their calendar. Keep the seat, flag it, ask them. Never auto-cancel. */
export async function markUncertain(signupId: string, session: Session) {
  const prev = await transition(signupId, ["confirmed"], { status: "uncertain", uncertainSince: now() }, session);
  if (!prev) return false;
  const occ = await col.occurrences().findOne({ _id: prev.occurrenceId }, { session });
  await notify(session, {
    volunteerId: prev.volunteerId,
    kind: "calendar_removed",
    occurrenceId: prev.occurrenceId,
    signupId,
    message: `You removed ${occ?.title ?? "a shift"} from your calendar. Removing it there doesn't cancel — are you still coming?`,
  });
  return true;
}

/** "I'm still coming": back to confirmed; the event is re-added to their calendar. */
export async function keepAfterCalendarRemoval(signupId: string, actor: Actor) {
  return tx(async (session) => {
    await loadOwned(signupId, actor, session);
    const prev = await transition(signupId, ["uncertain"], { status: "confirmed", uncertainSince: null }, session);
    if (!prev) throw new DomainError(409, "not_uncertain", "Nothing to confirm.");
    await refreshLinks([signupId], session, PRIORITY.volunteer);
  });
}

export async function acknowledgeMove(signupId: string, actor: Actor) {
  return tx(async (session) => {
    const s = await loadOwned(signupId, actor, session);
    const occ = await col.occurrences().findOne({ _id: s.occurrenceId }, { session });
    await col.signups().updateOne({ _id: signupId }, { $set: { ackVersion: occ?.version ?? 0 } }, { session });
  });
}
