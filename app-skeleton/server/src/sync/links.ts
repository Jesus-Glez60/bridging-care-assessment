// Calendar links: one per signup, holding what the volunteer's Tidewater event *should* look like
// (desired), what we last saw (observed), and the sync job state. Domain code never calls Tidewater;
// it updates `desired` inside its own transaction and the worker converges the calendar afterwards.
import { col, type Session } from "../db";
import { now } from "../clock";
import { isoInZone } from "../time";
import type { CalendarLink, EventShape, Occurrence, Signup, Volunteer } from "../types";

export const TITLE_PREFIX = "Harbor Light: ";
export const APP_REF_PREFIX = "hl:signup:";

export const PRIORITY = { backfill: 0, volunteer: 5, coordinator: 10 } as const;

export const ABSENT: EventShape = { present: false, start: null, end: null, title: null };

export function desiredShape(signup: Signup, occ: Occurrence, volunteer: Volunteer): EventShape {
  const present = volunteer.calendarConnected && signup.status === "confirmed" && occ.status === "scheduled";
  if (!present) return ABSENT;
  return { present, start: isoInZone(occ.start, occ.tz), end: isoInZone(occ.end, occ.tz), title: TITLE_PREFIX + occ.title };
}

/** Same instants and presence. Title is not compared: volunteers may rename their own events. */
export function converged(a: EventShape, b: EventShape) {
  if (a.present !== b.present) return false;
  if (!a.present) return true;
  return Date.parse(a.start!) === Date.parse(b.start!) && Date.parse(a.end!) === Date.parse(b.end!);
}

/**
 * Recomputes desired state for the given signups' links and marks them for the worker. Creates links on
 * demand for connected volunteers. Must run inside the transaction that changed the signup/occurrence.
 */
export async function refreshLinks(signupIds: string[], session: Session, priority: number) {
  const at = new Date();
  for (const signupId of signupIds) {
    const signup = await col.signups().findOne({ _id: signupId }, { session });
    if (!signup) continue;
    const occ = await col.occurrences().findOne({ _id: signup.occurrenceId }, { session });
    const volunteer = await col.volunteers().findOne({ _id: signup.volunteerId }, { session });
    if (!occ || !volunteer) continue;
    if (occ.end.getTime() < now().getTime()) continue; // never rewrite history on people's calendars
    const desired = desiredShape(signup, occ, volunteer);
    const link = await col.links().findOne({ _id: signupId }, { session });

    if (!link) {
      if (!desired.present || !volunteer.tidewaterAccountId) continue;
      const fresh: CalendarLink = {
        _id: signupId,
        signupId,
        volunteerId: volunteer._id,
        occurrenceId: occ._id,
        accountId: volunteer.tidewaterAccountId,
        appRef: APP_REF_PREFIX + signupId,
        desired,
        observed: { ...ABSENT, version: 0 },
        eventId: null,
        retiredEventIds: [],
        strays: [],
        seen: {},
        sentRing: [],
        needsLookup: true,
        syncStatus: "pending",
        drift: null,
        parked: null,
        priority,
        nextAttemptAt: at,
        leaseUntil: new Date(0),
        leaseToken: null,
        attempts: 0,
        lastError: null,
        lastSyncedAt: null,
        updatedAt: at,
      };
      await col.links().insertOne(fresh, { session });
      continue;
    }

    const done = converged(link.observed, desired);
    const status = done ? (volunteer.calendarConnected ? "synced" : "not_connected") : "pending";
    await col.links().updateOne(
      { _id: signupId },
      {
        $set: {
          desired,
          syncStatus: status,
          drift: null, // a deliberate change by us supersedes any earlier volunteer edit
          priority: done ? link.priority : link.syncStatus === "pending" ? Math.max(priority, link.priority) : priority,
          nextAttemptAt: at,
          attempts: done ? link.attempts : 0,
          lastError: done ? link.lastError : null,
          updatedAt: at,
        },
      },
      { session },
    );
  }
}
