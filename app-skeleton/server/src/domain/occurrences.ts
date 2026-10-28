// Coordinator operations on the season: create a series, cancel or move one occurrence.
// Occurrences are materialized documents keyed by (seriesId, originalDate), so moving one never touches
// the series or its siblings, and signups keep pointing at the same occurrence id.
import { DateTime } from "luxon";
import { now } from "../clock";
import { col, tx } from "../db";
import { notify } from "../notify";
import { PRIORITY, refreshLinks } from "../sync/links";
import { formatWindow, occurrenceWindow, weekdayOf, weeklyDates } from "../time";
import { ACTIVE_STATUSES, type Occurrence, type Series, type Weekday } from "../types";
import { DomainError } from "./signups";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function buildOccurrences(series: Series): Occurrence[] {
  const dates = series.recurrence === "weekly" && series.weekday ? weeklyDates(series.weekday, series.rangeStart, series.rangeEnd) : [series.rangeStart];
  return dates.map((date) => {
    const { start, end } = occurrenceWindow(date, series.localStart, series.localEnd, series.tz);
    return {
      _id: `${series._id}:${date}`,
      seriesId: series._id,
      originalDate: date,
      title: series.title,
      status: "scheduled",
      start,
      end,
      tz: series.tz,
      capacity: series.capacity,
      occupied: 0,
      version: 1,
      movedFrom: null,
      note: null,
    };
  });
}

export interface CreateSeriesInput {
  title: string;
  recurrence: "weekly" | "once";
  date?: string; // for "once"
  weekday?: Weekday;
  rangeStart?: string;
  rangeEnd?: string;
  localStart: string;
  localEnd: string;
  capacity: number;
}

export async function createSeries(input: CreateSeriesInput, orgTz: string) {
  const title = String(input.title ?? "").trim();
  if (!title) throw new DomainError(400, "invalid", "Title is required.");
  if (!HHMM.test(input.localStart) || !HHMM.test(input.localEnd)) throw new DomainError(400, "invalid", "Times must be HH:mm.");
  const capacity = Number(input.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) throw new DomainError(400, "invalid", "Capacity must be a whole number between 1 and 500.");
  const once = input.recurrence === "once";
  const rangeStart = once ? input.date : input.rangeStart;
  const rangeEnd = once ? input.date : input.rangeEnd;
  if (!rangeStart || !rangeEnd || !DATE.test(rangeStart) || !DATE.test(rangeEnd) || rangeEnd < rangeStart) throw new DomainError(400, "invalid", "Dates are missing or out of order.");
  const today = DateTime.fromJSDate(now(), { zone: orgTz }).toISODate()!;
  if (rangeEnd < today) throw new DomainError(400, "invalid", "The series ends in the past.");
  const weekday = once ? weekdayOf(rangeStart) : input.weekday;
  if (!weekday) throw new DomainError(400, "invalid", "Pick a weekday.");

  const count = await col.series().countDocuments();
  const series: Series = {
    _id: `S${count + 1}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}`,
    title,
    recurrence: once ? "once" : "weekly",
    weekday,
    localStart: input.localStart,
    localEnd: input.localEnd,
    rangeStart,
    rangeEnd,
    capacity,
    tz: orgTz,
    source: "coordinator",
    flags: [],
  };
  let occurrences: Occurrence[];
  try {
    occurrences = buildOccurrences(series).filter((o) => o.start > now());
  } catch (e) {
    throw new DomainError(400, "invalid", (e as Error).message);
  }
  if (!occurrences.length) throw new DomainError(400, "invalid", "That range contains no future dates on the chosen weekday.");
  await tx(async (session) => {
    await col.series().insertOne(series, { session });
    await col.occurrences().insertMany(occurrences, { session });
  });
  return { series, occurrences: occurrences.length };
}

export async function cancelOccurrence(occurrenceId: string, note: string | null) {
  return tx(async (session) => {
    const occ = await col.occurrences().findOneAndUpdate(
      { _id: occurrenceId, status: "scheduled" },
      { $set: { status: "cancelled", occupied: 0, note }, $inc: { version: 1 } },
      { session, returnDocument: "after" },
    );
    if (!occ) throw new DomainError(409, "not_scheduled", "Only scheduled shifts can be cancelled.");
    if (occ.end <= now()) throw new DomainError(409, "past", "This shift is already over.");
    const affected = await col.signups().find({ occurrenceId, status: { $in: ACTIVE_STATUSES } }, { session }).toArray();
    await col.signups().updateMany(
      { occurrenceId, status: { $in: ACTIVE_STATUSES } },
      { $set: { status: "cancelled_by_org", cancelReason: "occurrence_cancelled", offerExpiresAt: null, updatedAt: now() } },
      { session },
    );
    for (const s of affected) {
      await notify(session, {
        volunteerId: s.volunteerId,
        kind: "cancelled_by_org",
        occurrenceId,
        signupId: s._id,
        message: `${occ.title} on ${formatWindow(occ.start, occ.end, occ.tz)} is cancelled${note ? ` (${note})` : ""}. No need to come in.`,
      });
    }
    await refreshLinks(affected.map((s) => s._id), session, PRIORITY.coordinator);
    return { affected: affected.length };
  });
}

export interface MoveInput {
  date: string;
  localStart: string;
  localEnd: string;
}

export async function moveOccurrence(occurrenceId: string, input: MoveInput) {
  if (!DATE.test(input.date) || !HHMM.test(input.localStart) || !HHMM.test(input.localEnd)) throw new DomainError(400, "invalid", "Date must be YYYY-MM-DD and times HH:mm.");
  return tx(async (session) => {
    const occ = await col.occurrences().findOne({ _id: occurrenceId }, { session });
    if (!occ) throw new DomainError(404, "not_found", "No such shift.");
    if (occ.status !== "scheduled") throw new DomainError(409, "not_scheduled", "Cancelled shifts can't be moved.");
    if (occ.start <= now()) throw new DomainError(409, "started", "This shift has already started.");
    let window: { start: Date; end: Date };
    try {
      window = occurrenceWindow(input.date, input.localStart, input.localEnd, occ.tz);
    } catch (e) {
      throw new DomainError(400, "invalid", (e as Error).message);
    }
    if (window.start <= now()) throw new DomainError(400, "invalid", "The new time is in the past.");
    if (window.start.getTime() === occ.start.getTime() && window.end.getTime() === occ.end.getTime()) throw new DomainError(400, "invalid", "That's the current time.");
    const sibling = await col.occurrences().findOne(
      { seriesId: occ.seriesId, _id: { $ne: occ._id }, status: "scheduled", start: { $lt: window.end }, end: { $gt: window.start } },
      { session },
    );
    if (sibling) throw new DomainError(409, "collision", `That overlaps another ${occ.title} (${formatWindow(sibling.start, sibling.end, sibling.tz)}).`);

    const updated = await col.occurrences().findOneAndUpdate(
      { _id: occurrenceId, version: occ.version },
      { $set: { start: window.start, end: window.end, movedFrom: occ.movedFrom ?? { start: occ.start, end: occ.end } }, $inc: { version: 1 } },
      { session, returnDocument: "after" },
    );
    if (!updated) throw new DomainError(409, "conflict", "Someone else changed this shift. Reload and try again.");

    const affected = await col.signups().find({ occurrenceId, status: { $in: ACTIVE_STATUSES } }, { session }).toArray();
    const from = formatWindow(occ.start, occ.end, occ.tz);
    const to = formatWindow(updated.start, updated.end, updated.tz);
    for (const s of affected) {
      await notify(session, {
        volunteerId: s.volunteerId,
        kind: "moved",
        occurrenceId,
        signupId: s._id,
        message: `${occ.title} moved: was ${from}, now ${to}. Please confirm you've seen this.`,
      });
    }
    await refreshLinks(affected.map((s) => s._id), session, PRIORITY.coordinator);
    return { affected: affected.length, from, to };
  });
}
