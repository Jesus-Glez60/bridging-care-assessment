// Time zone logic: schedule expansion, quiet-hour-aware offer holds, and display strings.
// Everything goes through Luxon with an explicit zone; nothing relies on the server's or browser's zone.
import { DateTime, IANAZone } from "luxon";
import type { Weekday } from "./types";

const WEEKDAY_NUM: Record<Weekday, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

/** Common non-IANA abbreviations found in spreadsheets. Mapping is lossy (CST vs CDT), so it is flagged. */
const ABBREVIATIONS: Record<string, string> = {
  CST: "America/Chicago",
  CDT: "America/Chicago",
  CT: "America/Chicago",
  EST: "America/New_York",
  EDT: "America/New_York",
  ET: "America/New_York",
  MST: "America/Denver",
  PST: "America/Los_Angeles",
  PT: "America/Los_Angeles",
};

export function normalizeZone(raw: unknown, fallback: string): { tz: string; source: "seed" | "normalized" | "defaulted" } {
  if (typeof raw === "string" && IANAZone.isValidZone(raw) && raw.includes("/")) return { tz: raw, source: "seed" };
  if (typeof raw === "string" && ABBREVIATIONS[raw.trim().toUpperCase()]) return { tz: ABBREVIATIONS[raw.trim().toUpperCase()], source: "normalized" };
  return { tz: fallback, source: "defaulted" };
}

/** Wall-clock date + time in a zone → instant. Throws on times that don't exist (spring-forward gap). */
export function zonedInstant(date: string, time: string, tz: string): DateTime {
  const dt = DateTime.fromISO(`${date}T${time}`, { zone: tz });
  if (!dt.isValid) throw new Error(`Invalid local time ${date} ${time} in ${tz}: ${dt.invalidExplanation}`);
  // Luxon shifts nonexistent times forward; detect that instead of silently scheduling an hour off.
  if (dt.toFormat("HH:mm") !== time) throw new Error(`${date} ${time} does not exist in ${tz} (DST gap)`);
  return dt;
}

export function occurrenceWindow(date: string, localStart: string, localEnd: string, tz: string) {
  const start = zonedInstant(date, localStart, tz);
  let end = zonedInstant(date, localEnd, tz);
  if (end <= start) end = end.plus({ days: 1 }); // overnight shift
  return { start: start.toUTC().toJSDate(), end: end.toUTC().toJSDate() };
}

/** Dates (yyyy-MM-dd) of a weekly series between rangeStart and rangeEnd inclusive. */
export function weeklyDates(weekday: Weekday, rangeStart: string, rangeEnd: string): string[] {
  let d = DateTime.fromISO(rangeStart, { zone: "UTC" });
  const last = DateTime.fromISO(rangeEnd, { zone: "UTC" });
  while (d.weekday !== WEEKDAY_NUM[weekday]) d = d.plus({ days: 1 });
  const out: string[] = [];
  for (; d <= last; d = d.plus({ weeks: 1 })) out.push(d.toISODate()!);
  return out;
}

export function weekdayOf(date: string): Weekday {
  const n = DateTime.fromISO(date, { zone: "UTC" }).weekday;
  return (Object.keys(WEEKDAY_NUM) as Weekday[]).find((k) => WEEKDAY_NUM[k] === n)!;
}

/** ISO string with the zone's offset, the form Tidewater requires (naive timestamps are rejected). */
export function isoInZone(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toISO({ suppressMilliseconds: true })!;
}

export const QUIET_START_HOUR = 21; // 9 PM
export const QUIET_END_HOUR = 8; // 8 AM
export const OFFER_HOLD_HOURS = 12;
export const OFFER_CUTOFF_HOURS = 2; // no offers that would expire within 2h of the shift

/**
 * When an offer made at `from` expires: OFFER_HOLD_HOURS of the volunteer's waking time, with the clock
 * paused 9 PM–8 AM in their own zone. An offer at 11 PM therefore starts counting at 8 AM.
 */
export function offerExpiry(from: Date, tz: string, holdHours = OFFER_HOLD_HOURS): Date {
  let cursor = DateTime.fromJSDate(from, { zone: tz });
  let remainingMs = holdHours * 3600_000;
  for (let guard = 0; guard < 30; guard++) {
    if (cursor.hour >= QUIET_START_HOUR) cursor = cursor.plus({ days: 1 }).set({ hour: QUIET_END_HOUR, minute: 0, second: 0, millisecond: 0 });
    else if (cursor.hour < QUIET_END_HOUR) cursor = cursor.set({ hour: QUIET_END_HOUR, minute: 0, second: 0, millisecond: 0 });
    const quietStart = cursor.set({ hour: QUIET_START_HOUR, minute: 0, second: 0, millisecond: 0 });
    const available = quietStart.toMillis() - cursor.toMillis();
    if (remainingMs <= available) return cursor.plus({ milliseconds: remainingMs }).toUTC().toJSDate();
    remainingMs -= available;
    cursor = quietStart;
  }
  throw new Error("offerExpiry did not converge");
}

const ZONE_SHORT: Record<string, string> = {
  "America/Chicago": "CT",
  "America/New_York": "ET",
  "America/Indiana/Indianapolis": "ET",
  "America/Denver": "MT",
  "America/Phoenix": "MST",
  "America/Los_Angeles": "PT",
};

export function zoneLabel(tz: string) {
  return ZONE_SHORT[tz] ?? tz;
}

/** "Tue, Nov 3 · 4:00–6:00 PM CT" */
export function formatWindow(start: Date, end: Date, tz: string) {
  const s = DateTime.fromJSDate(start, { zone: tz });
  const e = DateTime.fromJSDate(end, { zone: tz });
  const sameMeridiem = s.toFormat("a") === e.toFormat("a");
  const startFmt = s.minute === 0 ? (sameMeridiem ? "h" : "h a") : sameMeridiem ? "h:mm" : "h:mm a";
  const endFmt = e.minute === 0 ? "h a" : "h:mm a";
  return `${s.toFormat("ccc, LLL d")} · ${s.toFormat(startFmt)}–${e.toFormat(endFmt)} ${zoneLabel(tz)}`;
}

/** "Thu, Oct 22 · 9:00 AM CT" */
export function formatInstant(d: Date, tz: string) {
  return `${DateTime.fromJSDate(d, { zone: tz }).toFormat("ccc, LLL d · h:mm a")} ${zoneLabel(tz)}`;
}

/** Same instant shown in two zones; second part omitted when the wall clock is identical. */
export function dualTime(start: Date, end: Date, kitchenTz: string, viewerTz: string) {
  const kitchen = formatWindow(start, end, kitchenTz);
  const sameWall =
    DateTime.fromJSDate(start, { zone: kitchenTz }).toFormat("yyyy-MM-dd HH:mm") ===
    DateTime.fromJSDate(start, { zone: viewerTz }).toFormat("yyyy-MM-dd HH:mm");
  return { kitchen, viewer: sameWall ? null : formatWindow(start, end, viewerTz) };
}
