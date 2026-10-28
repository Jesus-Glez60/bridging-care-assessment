// Stage 2 of the import: raw spreadsheet rows → validated domain data, with every judgement call written
// to import_report so a coordinator can see what was changed, assumed, or needs a human.
import { DateTime } from "luxon";
import { initClock, now } from "../clock";
import { col } from "../db";
import { buildOccurrences } from "../domain/occurrences";
import { PRIORITY, refreshLinks } from "../sync/links";
import { tx } from "../db";
import { formatWindow, normalizeZone, occurrenceWindow, weekdayOf } from "../time";
import type { Occurrence, Org, ReportEntry, Series, Signup, SignupStatus, Volunteer, Weekday } from "../types";

type Raw = Record<string, any>;

const DEFAULT_DURATION_HOURS = 2;

export async function normalizeSeed() {
  const report: Omit<ReportEntry, "createdAt">[] = [];
  const add = (severity: ReportEntry["severity"], code: string, subject: string, message: string, resolution: string) =>
    report.push({ severity, code, subject, message, resolution });

  for (const c of ["org", "series", "occurrences", "signups", "volunteers", "calendar_links", "notifications", "import_report", "webhook_deliveries"]) {
    await col.raw(c).deleteMany({});
  }

  // ---- org & clock ----
  const rawOrg = (await col.raw("raw_org").findOne({})) as Raw;
  const org: Org = { _id: rawOrg.id, name: rawOrg.name, city: rawOrg.city, tz: rawOrg.tz, simulatedNow: rawOrg.simulatedNow, coordinators: rawOrg.coordinators };
  await col.org().insertOne(org);
  await initClock(org.simulatedNow, true);
  const nowAt = now();

  // ---- volunteers ----
  const rawVolunteers = (await col.raw("raw_volunteers").find({}).toArray()) as Raw[];
  const byEmail = new Map<string, string>();
  const volunteers: Volunteer[] = [];
  for (const v of rawVolunteers) {
    const zone = normalizeZone(v.tz, org.tz);
    if (zone.source === "normalized") add("warning", "tz_abbreviation", v.id, `Time zone "${v.tz}" is an abbreviation, not a zone.`, `Interpreted as ${zone.tz}. Confirm with the volunteer.`);
    if (zone.source === "defaulted") add("warning", "tz_missing", v.id, `Time zone is ${JSON.stringify(v.tz)}.`, `Using the kitchen's zone (${org.tz}); times are shown in kitchen time only.`);
    const email = String(v.email ?? "").trim().toLowerCase();
    if (byEmail.has(email)) {
      add("warning", "duplicate_email", v.id, `Same email as ${byEmail.get(email)} (${email}), different name "${v.name}".`, "Kept both records; not merged. A coordinator should confirm whether this is one person.");
    } else byEmail.set(email, v.id);
    const connected = v.calendarConnected === true && typeof v.tidewaterAccountId === "string";
    if (v.calendarConnected && !connected) add("warning", "calendar_inconsistent", v.id, "Marked connected without an account id.", "Treated as not connected.");
    volunteers.push({ _id: v.id, name: String(v.name).trim(), email, tz: zone.tz, tzSource: zone.source, calendarConnected: connected, tidewaterAccountId: connected ? v.tidewaterAccountId : null });
  }
  await col.volunteers().insertMany(volunteers);
  const volunteerById = new Map(volunteers.map((v) => [v._id, v]));

  // ---- series ----
  const rawSeries = (await col.raw("raw_series").find({}).toArray()) as Raw[];
  const seriesList: Series[] = [];
  for (const s of rawSeries) {
    const flags: string[] = [];
    let tz = s.tz;
    if (!tz) {
      tz = org.tz;
      flags.push("tz_assumed");
      add("warning", "series_tz_missing", `series ${s.id}`, `"${s.title}" has no time zone.`, `Assumed the kitchen's zone (${org.tz}).`);
    }
    let { localStart, localEnd, rangeStart, rangeEnd, weekday } = s;
    if (!localStart && typeof s.start === "string") {
      // e.g. "2026-11-14 10:00": naive local timestamp, no end time.
      const parsed = DateTime.fromFormat(s.start, "yyyy-MM-dd HH:mm", { zone: tz });
      if (!parsed.isValid) {
        add("error", "series_unparseable", `series ${s.id}`, `Start "${s.start}" can't be read.`, "Series skipped.");
        continue;
      }
      rangeStart = rangeEnd = parsed.toISODate();
      localStart = parsed.toFormat("HH:mm");
      localEnd = parsed.plus({ hours: DEFAULT_DURATION_HOURS }).toFormat("HH:mm");
      weekday = weekdayOf(rangeStart);
      flags.push("end_assumed", "needs_review");
      add("warning", "series_naive_start", `series ${s.id}`, `"${s.title}" has a naive start "${s.start}" and no end.`, `Read as ${localStart} ${tz}; assumed ${DEFAULT_DURATION_HOURS}h (ends ${localEnd}). Needs review before relying on it.`);
    }
    if (s.recurrence === "weekly" && weekday && weekdayOf(rangeStart) !== weekday) {
      add("info", "range_not_on_weekday", `series ${s.id}`, `Range starts ${rangeStart}, which isn't a ${weekday}.`, "First occurrence is the next matching weekday.");
    }
    const capacity = Number(s.capacity);
    if (!Number.isInteger(capacity) || capacity < 1) {
      add("error", "series_capacity", `series ${s.id}`, `Capacity "${s.capacity}" is invalid.`, "Series skipped.");
      continue;
    }
    seriesList.push({
      _id: s.id,
      title: s.title,
      recurrence: s.recurrence === "weekly" ? "weekly" : "once",
      weekday: weekday as Weekday,
      localStart,
      localEnd,
      rangeStart,
      rangeEnd,
      capacity,
      tz,
      source: "import",
      flags,
    });
  }
  await col.series().insertMany(seriesList);

  // ---- occurrences + exceptions ----
  const occurrences = new Map<string, Occurrence>();
  for (const s of seriesList) for (const o of buildOccurrences(s)) occurrences.set(o._id, o);
  const rawExceptions = (await col.raw("raw_exceptions").find({}).toArray()) as Raw[];
  for (const e of rawExceptions) {
    const occ = occurrences.get(`${e.seriesId}:${e.originalDate}`);
    if (!occ) {
      add("error", "exception_unknown_occurrence", `${e.seriesId} ${e.originalDate}`, "Exception refers to a date the series doesn't have.", "Ignored.");
      continue;
    }
    occ.note = e.note ?? null;
    if (e.kind === "cancelled") {
      occ.status = "cancelled";
      occ.version += 1;
    } else if (e.kind === "moved") {
      const series = seriesList.find((s) => s._id === e.seriesId)!;
      const durationMin = (occ.end.getTime() - occ.start.getTime()) / 60000;
      const localStart = e.movedToLocalStart ?? series.localStart;
      const localEnd = DateTime.fromFormat(localStart, "HH:mm").plus({ minutes: durationMin }).toFormat("HH:mm");
      const window = occurrenceWindow(e.movedToDate, localStart, localEnd, occ.tz);
      occ.movedFrom = { start: occ.start, end: occ.end };
      occ.start = window.start;
      occ.end = window.end;
      occ.version += 1;
    }
  }

  // ---- signups ----
  const rawSignups = ((await col.raw("raw_signups").find({}).toArray()) as Raw[]).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  const signups: Signup[] = [];
  const activeKey = new Set<string>();
  for (const r of rawSignups) {
    const occId = `${r.seriesId}:${r.originalDate}`;
    const occ = occurrences.get(occId);
    const subject = `${r.id} (${r.volunteerId})`;
    if (!occ) {
      add("error", "signup_unknown_occurrence", subject, `No ${r.seriesId} shift on ${r.originalDate}.`, "Skipped.");
      continue;
    }
    if (!volunteerById.has(r.volunteerId)) {
      add("error", "signup_unknown_volunteer", subject, `Unknown volunteer ${r.volunteerId}.`, "Skipped.");
      continue;
    }
    if (r.status !== "confirmed" && r.status !== "waitlisted") {
      add("error", "signup_bad_status", subject, `Status "${r.status}".`, "Skipped.");
      continue;
    }
    const key = `${occId}|${r.volunteerId}`;
    if (activeKey.has(key)) {
      add("warning", "signup_duplicate", subject, "Same volunteer signed up twice for one shift.", "Kept the earliest row.");
      continue;
    }
    activeKey.add(key);
    let status: SignupStatus = r.status;
    let cancelReason: string | null = null;
    if (occ.status === "cancelled") {
      status = "cancelled_by_org";
      cancelReason = "occurrence_cancelled";
      add("warning", "signup_on_cancelled", subject, `${r.status} for ${occ.title} on ${r.originalDate}, which is cancelled (${occ.note ?? "no note"}).`, "Marked cancelled by org; volunteer notified.");
    }
    if (occ.movedFrom && status !== "cancelled_by_org") {
      add("info", "signup_follows_move", subject, `Signed up for ${r.originalDate}; that shift moved.`, `Kept on the moved shift: ${formatWindow(occ.start, occ.end, occ.tz)}.`);
    }
    if (occ.end <= nowAt && status !== "cancelled_by_org") {
      add("info", "signup_historical", subject, `${occ.title} on ${r.originalDate} is in the past.`, "Kept as history; never synced.");
    }
    const createdAt = new Date(r.createdAt);
    signups.push({
      _id: r.id,
      occurrenceId: occId,
      volunteerId: r.volunteerId,
      status,
      rank: createdAt,
      createdAt,
      updatedAt: createdAt,
      offeredAt: null,
      offerExpiresAt: null,
      uncertainSince: null,
      cancelReason,
      ackVersion: occ.version,
      source: "import",
    });
  }

  // Capacity from confirmed rows only; overflow (if any) is demoted to the waitlist rather than trusted.
  for (const occ of occurrences.values()) {
    if (occ.status !== "scheduled") continue;
    const confirmed = signups.filter((s) => s.occurrenceId === occ._id && s.status === "confirmed");
    confirmed.slice(occ.capacity).forEach((s) => {
      s.status = "waitlisted";
      add("warning", "over_capacity", `${s._id} (${s.volunteerId})`, `${occ.title} ${occ.originalDate} had more confirmed than capacity ${occ.capacity}.`, "Latest signups moved to the waitlist.");
    });
    occ.occupied = Math.min(confirmed.length, occ.capacity);
  }

  // Double-booking: confirmed signups whose shifts overlap for the same volunteer.
  const confirmedByVolunteer = new Map<string, Signup[]>();
  for (const s of signups) if (s.status === "confirmed") confirmedByVolunteer.set(s.volunteerId, [...(confirmedByVolunteer.get(s.volunteerId) ?? []), s]);
  for (const [volunteerId, list] of confirmedByVolunteer) {
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = occurrences.get(list[i].occurrenceId)!;
        const b = occurrences.get(list[j].occurrenceId)!;
        if (a.status === "scheduled" && b.status === "scheduled" && a.start < b.end && b.start < a.end) {
          add("warning", "double_booked", volunteerId, `Confirmed for both ${a.title} (${formatWindow(a.start, a.end, a.tz)}) and ${b.title} (${formatWindow(b.start, b.end, b.tz)}).`, "Both kept. Coordinator should check with the volunteer.");
        }
      }
  }
  for (const s of signups) {
    const series = seriesList.find((x) => `${x._id}` === s.occurrenceId.split(":")[0]);
    if (series?.flags.includes("needs_review") && s.status === "confirmed") {
      add("warning", "signup_on_unreviewed_series", `${s._id} (${s.volunteerId})`, `Confirmed for "${series.title}", whose time was assumed.`, "Kept; will sync with the assumed time. Review the series first.");
    }
  }

  await col.occurrences().insertMany([...occurrences.values()]);
  await col.signups().insertMany(signups);

  // Notify volunteers whose imported signup landed on a cancelled shift.
  await tx(async (session) => {
    for (const s of signups.filter((x) => x.status === "cancelled_by_org")) {
      const occ = occurrences.get(s.occurrenceId)!;
      await col.notifications().insertOne(
        { volunteerId: s.volunteerId, kind: "cancelled_by_org", occurrenceId: occ._id, signupId: s._id, message: `${occ.title} on ${formatWindow(occ.start, occ.end, occ.tz)} is cancelled (${occ.note ?? "no reason given"}). Your signup from the spreadsheet has been released.`, createdAt: nowAt, readAt: null },
        { session },
      );
    }
  });

  // Calendar links for every future confirmed signup of a connected volunteer. They start with
  // needsLookup=true, so the worker first checks what's already on the calendar (the preload) before creating.
  const toLink = signups.filter((s) => s.status === "confirmed" && volunteerById.get(s.volunteerId)!.calendarConnected && occurrences.get(s.occurrenceId)!.end > nowAt).map((s) => s._id);
  for (let i = 0; i < toLink.length; i += 50) await tx((session) => refreshLinks(toLink.slice(i, i + 50), session, PRIORITY.backfill));
  add("info", "calendar_backfill", "calendar", `${toLink.length} future confirmed signups belong to volunteers with a connected calendar.`, "Queued for sync; existing events are adopted by app_ref, not duplicated.");

  const createdAt = nowAt;
  await col.report().insertMany(report.map((r) => ({ ...r, createdAt })));
  return {
    volunteers: volunteers.length,
    series: seriesList.length,
    occurrences: occurrences.size,
    signups: signups.length,
    links: toLink.length,
    report: report.length,
  };
}

export async function addReportEntry(entry: Omit<ReportEntry, "createdAt">) {
  await col.report().updateOne({ code: entry.code, subject: entry.subject }, { $setOnInsert: { ...entry, createdAt: now() } }, { upsert: true });
}
