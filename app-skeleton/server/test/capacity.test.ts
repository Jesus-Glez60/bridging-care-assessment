// Capacity, waitlist and import behaviour against a real MongoDB replica set.
import mongoose from "mongoose";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { advance } from "../src/clock";
import { col } from "../src/db";
import { cancelOccurrence, moveOccurrence } from "../src/domain/occurrences";
import { acceptOffer, cancelSignup, declineOffer, expireOffers, signUp } from "../src/domain/signups";
import { connectTestDb, seedDb } from "./harness";

const coord = { role: "coordinator" as const, id: "C01" };
const asVol = (id: string) => ({ role: "volunteer" as const, id });

beforeEach(async () => {
  await connectTestDb("capacity");
  await seedDb();
});
afterAll(() => mongoose.disconnect());

async function freeVolunteers(n: number, occId: string) {
  const busy = new Set((await col.signups().find({ occurrenceId: occId }).toArray()).map((s) => s.volunteerId));
  // Only volunteers with nothing else that day, so the overlap check doesn't interfere.
  const vols = await col.volunteers().find({}).toArray();
  const out: string[] = [];
  for (const v of vols) {
    if (busy.has(v._id)) continue;
    if (await col.signups().findOne({ volunteerId: v._id, status: { $in: ["confirmed", "offered", "uncertain"] }, occurrenceId: { $regex: "2026-11-1[0-9]" } })) continue;
    out.push(v._id);
    if (out.length === n) break;
  }
  return out;
}

describe("import", () => {
  it("records every judgement call in the report and counts only confirmed seats", async () => {
    const codes = (await col.report().find({}).toArray()).map((e) => `${e.code}:${e.subject}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        "tz_abbreviation:V19",
        "tz_missing:V33",
        "duplicate_email:V88",
        "series_naive_start:series E",
        "signup_on_cancelled:su_0097 (V94)",
        "double_booked:V44",
        "signup_follows_move:su_0141 (V12)",
      ]),
    );
    const thanksgiving = await col.signups().findOne({ _id: "su_0097" });
    expect(thanksgiving?.status).toBe("cancelled_by_org");
    const moved = await col.occurrences().findOne({ _id: "A:2026-12-01" });
    expect(moved?.start.toISOString()).toBe("2026-12-02T22:00:00.000Z"); // Wed 4 PM CST
    const full = await col.occurrences().findOne({ _id: "A:2026-12-08" });
    expect(full?.occupied).toBe(8);
  });
});

describe("capacity under concurrency", () => {
  it("25 people racing for the last seat: exactly one gets it", async () => {
    const occId = "A:2026-11-10"; // 8/8 confirmed after import
    await cancelSignup((await col.signups().findOne({ occurrenceId: occId, status: "confirmed" }))!._id, coord);
    // The freed seat was offered to the existing waitlist; withdraw that so the seat is genuinely open.
    const offered = await col.signups().findOne({ occurrenceId: occId, status: "offered" });
    if (offered) await declineOffer(offered._id, asVol(offered.volunteerId));
    expect((await col.occurrences().findOne({ _id: occId }))!.occupied).toBe(7);

    const racers = await freeVolunteers(25, occId);
    const results = await Promise.allSettled(racers.map((v) => signUp(v, occId)));
    const statuses = results.map((r) => (r.status === "fulfilled" ? r.value.signup.status : "error"));
    expect(statuses.filter((s) => s === "confirmed")).toHaveLength(1);
    expect(statuses.filter((s) => s === "waitlisted")).toHaveLength(24);
    const occ = await col.occurrences().findOne({ _id: occId });
    expect(occ?.occupied).toBe(8);
    expect(await col.signups().countDocuments({ occurrenceId: occId, status: "confirmed" })).toBe(8);
  });

  it("the same volunteer double-clicking gets one signup", async () => {
    const [v] = await freeVolunteers(1, "C:2026-11-12");
    const results = await Promise.allSettled([signUp(v, "C:2026-11-12"), signUp(v, "C:2026-11-12")]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await col.signups().countDocuments({ occurrenceId: "C:2026-11-12", volunteerId: v })).toBe(1);
  });
});

describe("waitlist", () => {
  it("a cancellation offers the seat to #1 by rank; decline passes it to #2; expiry passes it on", async () => {
    const occId = "A:2026-12-15"; // 8 confirmed, 3 waitlisted
    const waitlist = await col.signups().find({ occurrenceId: occId, status: "waitlisted" }).sort({ rank: 1 }).toArray();
    const someone = await col.signups().findOne({ occurrenceId: occId, status: "confirmed" });
    await cancelSignup(someone!._id, asVol(someone!.volunteerId));

    const first = await col.signups().findOne({ _id: waitlist[0]._id });
    expect(first?.status).toBe("offered");
    expect((await col.occurrences().findOne({ _id: occId }))!.occupied).toBe(8); // the offer holds the seat

    await declineOffer(first!._id, asVol(first!.volunteerId));
    expect((await col.signups().findOne({ _id: waitlist[1]._id }))?.status).toBe("offered");

    await advance(3 * 24 * 3600_000);
    await expireOffers();
    expect((await col.signups().findOne({ _id: waitlist[1]._id }))?.cancelReason).toBe("offer_expired");
    const third = await col.signups().findOne({ _id: waitlist[2]._id });
    expect(third?.status).toBe("offered");
    await acceptOffer(third!._id, asVol(third!.volunteerId));
    expect((await col.signups().findOne({ _id: third!._id }))?.status).toBe("confirmed");
    expect(await col.signups().countDocuments({ occurrenceId: occId, status: "confirmed" })).toBe(8);
  });

  it("accepting after the shift was cancelled fails cleanly", async () => {
    const occId = "B:2026-12-12";
    const someone = await col.signups().findOne({ occurrenceId: occId, status: "confirmed" });
    await cancelSignup(someone!._id, coord);
    const offered = await col.signups().findOne({ occurrenceId: occId, status: "offered" });
    await cancelOccurrence(occId, "Weather");
    await expect(acceptOffer(offered!._id, asVol(offered!.volunteerId))).rejects.toThrow(/cancelled/);
    expect(await col.signups().countDocuments({ occurrenceId: occId, status: { $in: ["confirmed", "waitlisted", "offered"] } })).toBe(0);
  });
});

describe("moving an occurrence", () => {
  it("moves one occurrence, keeps its signups, leaves siblings alone, and rejects collisions", async () => {
    const before = await col.signups().countDocuments({ occurrenceId: "C:2026-11-12", status: "confirmed" });
    await moveOccurrence("C:2026-11-12", { date: "2026-11-13", localStart: "17:30", localEnd: "19:30" });
    expect(await col.signups().countDocuments({ occurrenceId: "C:2026-11-12", status: "confirmed" })).toBe(before);
    expect((await col.occurrences().findOne({ _id: "C:2026-11-05" }))!.movedFrom).toBeNull();
    await expect(moveOccurrence("C:2026-11-12", { date: "2026-11-19", localStart: "17:00", localEnd: "18:00" })).rejects.toThrow(/overlaps/);
    expect(await col.notifications().countDocuments({ occurrenceId: "C:2026-11-12", kind: "moved" })).toBe(before);
  });
});
