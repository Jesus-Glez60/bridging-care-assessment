// In-app notifications are the only delivery channel in this prototype. Email/SMS/push are deferred;
// the inbox is what a volunteer sees on next visit, and the roster shows who acknowledged a move.
import { now } from "./clock";
import { col, type Session } from "./db";
import type { Notification } from "./types";

export async function notify(session: Session, n: Omit<Notification, "createdAt" | "readAt">) {
  await col.notifications().insertOne({ ...n, createdAt: now(), readAt: null }, { session });
}
