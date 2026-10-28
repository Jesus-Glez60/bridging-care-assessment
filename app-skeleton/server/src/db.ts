// Thin typed access to collections through Mongoose's connection. Domain writes go through the native
// driver so multi-document transactions and conditional updates stay explicit.
import mongoose, { type mongo } from "mongoose";
import type { CalendarLink, Notification, Occurrence, Org, ReportEntry, Series, Signup, Volunteer } from "./types";

export type Session = mongo.ClientSession;

const db = () => mongoose.connection.db!;

export const col = {
  org: () => db().collection<Org>("org"),
  series: () => db().collection<Series>("series"),
  occurrences: () => db().collection<Occurrence>("occurrences"),
  signups: () => db().collection<Signup>("signups"),
  volunteers: () => db().collection<Volunteer>("volunteers"),
  links: () => db().collection<CalendarLink>("calendar_links"),
  notifications: () => db().collection<Notification>("notifications"),
  report: () => db().collection<ReportEntry>("import_report"),
  deliveries: () => db().collection<{ _id: string; receivedAt: Date; outcome: string; type: string; eventId: string }>("webhook_deliveries"),
  settings: () => db().collection<{ _id: string; [k: string]: unknown }>("settings"),
  raw: (name: string) => db().collection(name),
};

/** Runs fn in a transaction; the driver retries on TransientTransactionError / UnknownCommitResult. */
export async function tx<T>(fn: (session: Session) => Promise<T>): Promise<T> {
  const session = mongoose.connection.getClient().startSession();
  try {
    return await session.withTransaction(() => fn(session));
  } finally {
    await session.endSession();
  }
}

export async function ensureIndexes() {
  await col.signups().createIndex(
    { occurrenceId: 1, volunteerId: 1 },
    { unique: true, partialFilterExpression: { status: { $in: ["confirmed", "waitlisted", "offered", "uncertain"] } }, name: "one_active_signup" },
  );
  await col.signups().createIndex({ occurrenceId: 1, status: 1, rank: 1 });
  await col.signups().createIndex({ volunteerId: 1, status: 1 });
  await col.signups().createIndex({ status: 1, offerExpiresAt: 1 });
  await col.occurrences().createIndex({ seriesId: 1, start: 1 });
  await col.links().createIndex({ syncStatus: 1, priority: -1, nextAttemptAt: 1 });
  await col.links().createIndex({ accountId: 1 });
  await col.links().createIndex({ appRef: 1 }, { unique: true });
  await col.notifications().createIndex({ volunteerId: 1, createdAt: -1 });
}
