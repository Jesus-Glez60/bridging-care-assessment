// Domain types. Instants are stored as Date (UTC); every occurrence also carries the IANA zone it is
// scheduled in, because "4 PM" only means something together with "in America/Chicago".

export type Weekday = "MO" | "TU" | "WE" | "TH" | "FR" | "SA" | "SU";

export interface Org {
  _id: string;
  name: string;
  city: string;
  tz: string;
  simulatedNow: string;
  coordinators: { id: string; name: string; email: string }[];
}

export interface Series {
  _id: string;
  title: string;
  recurrence: "weekly" | "once";
  weekday: Weekday | null;
  localStart: string; // "HH:mm" in tz
  localEnd: string;
  rangeStart: string; // ISO date, inclusive
  rangeEnd: string;
  capacity: number;
  tz: string;
  source: "import" | "coordinator";
  flags: string[];
}

export type OccurrenceStatus = "scheduled" | "cancelled";

export interface Occurrence {
  _id: string; // `${seriesId}:${originalDate}` — identity never changes when the occurrence moves
  seriesId: string;
  originalDate: string;
  title: string;
  status: OccurrenceStatus;
  start: Date;
  end: Date;
  tz: string;
  capacity: number;
  /** confirmed + offered + uncertain. Maintained only inside transactions with conditional updates. */
  occupied: number;
  /** Bumped on every move/cancel; signups acknowledge a move by recording the version they saw. */
  version: number;
  movedFrom: { start: Date; end: Date } | null;
  note: string | null;
}

export type SignupStatus = "confirmed" | "waitlisted" | "offered" | "uncertain" | "cancelled" | "cancelled_by_org";
export const ACTIVE_STATUSES: SignupStatus[] = ["confirmed", "waitlisted", "offered", "uncertain"];
/** Statuses that hold a seat. */
export const SEATED_STATUSES: SignupStatus[] = ["confirmed", "offered", "uncertain"];

export interface Signup {
  _id: string;
  occurrenceId: string;
  volunteerId: string;
  status: SignupStatus;
  /** Waitlist order. Imported rows use the spreadsheet's createdAt. */
  rank: Date;
  createdAt: Date;
  updatedAt: Date;
  offeredAt: Date | null;
  offerExpiresAt: Date | null;
  uncertainSince: Date | null;
  cancelReason: string | null;
  /** Occurrence version the volunteer has acknowledged (for "did everyone see the move?"). */
  ackVersion: number;
  source: "import" | "app";
}

export interface Volunteer {
  _id: string;
  name: string;
  email: string;
  tz: string;
  tzSource: "seed" | "normalized" | "defaulted";
  calendarConnected: boolean;
  tidewaterAccountId: string | null;
}

export interface EventShape {
  present: boolean;
  start: string | null; // ISO with offset, as sent to / received from Tidewater
  end: string | null;
  title: string | null;
}

export type SyncStatus = "synced" | "pending" | "retrying" | "failed" | "drift" | "not_connected";

export interface CalendarLink {
  _id: string; // = signupId, so app_ref `hl:signup:<id>` maps 1:1
  signupId: string;
  volunteerId: string;
  occurrenceId: string;
  accountId: string;
  appRef: string;
  desired: EventShape;
  observed: EventShape & { version: number };
  eventId: string | null;
  retiredEventIds: string[];
  /** Extra events carrying our app_ref (e.g. a POST that succeeded but whose response was lost). Deleted by the worker. */
  strays: string[];
  /** Highest version seen per Tidewater event id. Webhooks at or below it are stale. */
  seen: Record<string, number>;
  /** Last few shapes we wrote. A webhook matching one of these is an echo of our own write. */
  sentRing: { start: string; end: string }[];
  /** Set when we cannot be sure no event exists yet (first sync, or after an ambiguous timeout). */
  needsLookup: boolean;
  syncStatus: SyncStatus;
  drift: { kind: "deleted" | "time"; at: Date; observedStart: string | null } | null;
  /** A webhook that arrived while a write was in flight; decided after the write returns. */
  parked: { type: string; event: TwEventPayload } | null;
  priority: number;
  nextAttemptAt: Date;
  leaseUntil: Date;
  leaseToken: string | null;
  attempts: number;
  lastError: string | null;
  lastSyncedAt: Date | null;
  updatedAt: Date;
}

export interface TwEventPayload {
  id: string;
  version: number;
  title: string;
  start: string;
  end: string;
  app_ref: string | null;
}

export interface Notification {
  _id?: import("mongoose").mongo.ObjectId;
  volunteerId: string;
  kind: "moved" | "cancelled_by_org" | "offer" | "offer_expired" | "calendar_removed" | "confirmed" | "import";
  occurrenceId: string | null;
  signupId: string | null;
  message: string;
  createdAt: Date;
  readAt: Date | null;
}

export interface ReportEntry {
  _id?: import("mongoose").mongo.ObjectId;
  severity: "info" | "warning" | "error";
  code: string;
  subject: string;
  message: string;
  resolution: string;
  createdAt: Date;
}
