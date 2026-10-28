// Two-way sync against the real simulator: failures, duplicates, reordering, echoes, volunteer edits.
import mongoose from "mongoose";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { col } from "../src/db";
import { cancelOccurrence, moveOccurrence } from "../src/domain/occurrences";
import { cancelSignup, keepAfterCalendarRemoval } from "../src/domain/signups";
import { SyncWorker } from "../src/sync/engine";
import { TidewaterClient } from "../src/sync/tidewater";
import { audit, connectTestDb, quiescent, seedDb, startStack, until } from "./harness";

let stack: Awaited<ReturnType<typeof startStack>>;

beforeEach(async () => {
  await connectTestDb("sync");
  await seedDb();
});
afterEach(async () => stack?.stop());
afterAll(() => mongoose.disconnect());

const allLinks = () => col.links().find({}).toArray();

describe("first sync", () => {
  it("adopts preloaded events by app_ref, fixes the stale one without touching its title, leaves the foreign one alone", async () => {
    stack = await startStack();
    stack.worker.start();
    await quiescent();
    expect(audit(stack.sim, await allLinks())).toEqual([]);
    const v12 = stack.sim.store.list("tw_v12").find((e) => e.app_ref === "hl:signup:su_0141")!;
    expect(v12.start).toBe("2026-12-02T16:00:00-06:00");
    expect(v12.title).toContain("bring apron");
    expect(stack.sim.store.list("tw_v02").some((e) => e.app_ref === "legacy-import-0417")).toBe(true);
    expect(stack.sim.store.list("tw_v04").filter((e) => e.app_ref === "hl:signup:su_0088")).toHaveLength(1);
    expect(await col.report().findOne({ code: "calendar_orphan" })).not.toBeNull();
  });
});

describe("move under pressure", () => {
  it("with 40% failures, duplicates and reordering, every link ends synced and matches the calendar", async () => {
    stack = await startStack();
    stack.worker.start();
    await quiescent();
    stack.sim.setConfig({ failRate: 0.4, duplicateRate: 0.5, reorderRate: 0.5, reorderHoldMs: 300 });

    await moveOccurrence("A:2026-12-08", { date: "2026-12-08", localStart: "17:00", localEnd: "19:00" });
    // While failing, nothing may claim "synced" with the old time.
    await new Promise((r) => setTimeout(r, 300));
    const mid = await col.links().find({ occurrenceId: "A:2026-12-08" }).toArray();
    for (const l of mid) {
      const ev = stack.sim.store.list(l.accountId).find((e) => e.app_ref === l.appRef);
      if (l.syncStatus === "synced") expect(Date.parse(ev!.start)).toBe(Date.parse(l.desired.start!));
    }

    await quiescent();
    stack.sim.setConfig({ failRate: 0 });
    await new Promise((r) => setTimeout(r, 2500)); // let held/duplicate webhooks land
    await quiescent();
    expect(audit(stack.sim, await allLinks())).toEqual([]);
    // Our own writes' echoes, duplicated and reordered, must not be mistaken for volunteer changes.
    expect(await col.signups().countDocuments({ status: "uncertain" })).toBe(0);
    expect(await col.links().countDocuments({ syncStatus: { $in: ["drift", "failed"] } })).toBe(0);
  });
});

describe("volunteer changes on their device", () => {
  it("delete → uncertain (seat kept, not cancelled); keep → re-added as a new event", async () => {
    stack = await startStack();
    stack.worker.start();
    await quiescent();
    const link = (await col.links().findOne({ occurrenceId: "A:2026-12-08", eventId: { $ne: null } }))!;
    const ev = stack.sim.store.get(link.accountId, link.eventId!)!;
    stack.sim.store.remove(link.accountId, ev.id);
    stack.sim.dispatcher.emit("event.deleted", { ...ev, version: ev.version + 1 });

    await until(async () => (await col.signups().findOne({ _id: link.signupId }))?.status === "uncertain");
    expect((await col.occurrences().findOne({ _id: "A:2026-12-08" }))!.occupied).toBe(8);
    expect(await col.notifications().countDocuments({ signupId: link.signupId, kind: "calendar_removed" })).toBe(1);

    await keepAfterCalendarRemoval(link.signupId, { role: "volunteer", id: link.volunteerId });
    await quiescent();
    const after = (await col.links().findOne({ _id: link._id }))!;
    expect(after.eventId).not.toBe(ev.id);
    expect(audit(stack.sim, await allLinks())).toEqual([]);

    // A late replay of the old delete must not flip it back to uncertain.
    const old = stack.sim.dispatcher.log.find((d) => d.event_id === ev.id && d.type === "event.deleted")!;
    await stack.sim.dispatcher.replay(old.delivery_id);
    await new Promise((r) => setTimeout(r, 300));
    expect((await col.signups().findOne({ _id: link.signupId }))?.status).toBe("confirmed");
  });

  it("time edit on device → drift flagged, shift not moved", async () => {
    stack = await startStack();
    stack.worker.start();
    await quiescent();
    const link = (await col.links().findOne({ occurrenceId: "C:2026-10-29", eventId: { $ne: null } }))!;
    const ev = stack.sim.store.update(link.accountId, link.eventId!, { start: "2026-10-29T19:00:00-05:00", end: "2026-10-29T21:00:00-05:00" })!;
    stack.sim.dispatcher.emit("event.updated", ev);
    await until(async () => (await col.links().findOne({ _id: link._id }))?.syncStatus === "drift");
    const occ = (await col.occurrences().findOne({ _id: "C:2026-10-29" }))!;
    expect(occ.movedFrom).toBeNull();
  });

  it("our own cancellations are not mistaken for volunteer deletes", async () => {
    stack = await startStack({ webhookDelayMaxMs: 0 }); // echoes race our API responses
    stack.worker.start();
    await quiescent();
    const link = (await col.links().findOne({ occurrenceId: "B:2026-11-07", eventId: { $ne: null } }))!;
    await cancelSignup(link.signupId, { role: "volunteer", id: link.volunteerId });
    await cancelOccurrence("C:2026-11-12", "Power outage");
    await quiescent();
    await new Promise((r) => setTimeout(r, 500));
    expect(await col.signups().countDocuments({ status: "uncertain" })).toBe(0);
    expect(await col.notifications().countDocuments({ kind: "calendar_removed" })).toBe(0);
    expect(audit(stack.sim, await allLinks())).toEqual([]);
  });

  it("a delete we never heard about is caught by reconcile", async () => {
    stack = await startStack();
    stack.worker.start();
    await quiescent();
    const link = (await col.links().findOne({ occurrenceId: "C:2026-11-05", eventId: { $ne: null } }))!;
    stack.sim.store.remove(link.accountId, link.eventId!); // no webhook at all
    await stack.worker.reconcileAccount(link.accountId);
    expect((await col.signups().findOne({ _id: link.signupId }))?.status).toBe("uncertain");
  });
});

describe("ambiguous POST timeout (fake transport; the simulator can't produce this fault)", () => {
  it("a POST whose response is lost is looked up by app_ref, not repeated", async () => {
    stack = await startStack();
    let dropped = 0;
    const lossyFetch: typeof fetch = async (input, init) => {
      const res = await fetch(input, init);
      if (init?.method === "POST" && dropped < 3) {
        dropped++;
        const e = new Error("aborted");
        e.name = "AbortError";
        throw e; // request applied, response lost
      }
      return res;
    };
    await stack.worker.stop();
    const worker = new SyncWorker(new TidewaterClient(stack.simUrl, lossyFetch), {}, { lanes: 1, reconcileMs: 3_600_000, idleMs: 50 });
    worker.start();
    await quiescent();
    await worker.stop();
    expect(dropped).toBe(3);
    expect(audit(stack.sim, await allLinks())).toEqual([]); // exactly one event per app_ref
  });
});
