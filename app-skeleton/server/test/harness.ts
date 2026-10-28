// Integration harness: real MongoDB (replica set, for transactions), the real simulator in-process,
// and our webhook route on a random port. Needs `npm run skeleton:db` (or the compose mongo) running.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import express from "express";
import mongoose from "mongoose";
import { createSimulator } from "../../../simulator/src/app";
import { DEFAULTS, mergeConfig } from "../../../simulator/src/config";
import { col, ensureIndexes } from "../src/db";
import { normalizeSeed } from "../src/import/normalize";
import { importSeed } from "../src/seed-import";
import { SyncWorker } from "../src/sync/engine";
import { TidewaterClient } from "../src/sync/tidewater";
import { webhookHandler } from "../src/sync/webhook";
import type { CalendarLink } from "../src/types";

export const SECRET = "test-secret";
const SEED = fileURLToPath(new URL("../../../seed/data.json", import.meta.url));
const PRELOAD = fileURLToPath(new URL("../../../seed/tidewater-preload.json", import.meta.url));

async function listen(server: Server) {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

export async function connectTestDb(name: string) {
  const base = process.env.MONGO_TEST_URL ?? "mongodb://localhost:27017";
  if (mongoose.connection.readyState !== 1) await mongoose.connect(`${base}/hl_test_${name}?directConnection=true`, { maxPoolSize: 20 });
  await mongoose.connection.db!.dropDatabase();
  await ensureIndexes();
}

export async function seedDb() {
  await importSeed(mongoose.connection.db!, SEED);
  return normalizeSeed();
}

export async function startStack(simOverrides: Record<string, unknown> = {}) {
  const sim = createSimulator({
    config: mergeConfig(DEFAULTS, { secret: SECRET, latencyMinMs: 0, latencyMaxMs: 20, webhookDelayMinMs: 0, webhookDelayMaxMs: 50, ...simOverrides }),
    preloadPath: PRELOAD,
    quiet: true,
  });
  const simServer = createServer(sim.app);
  const simUrl = await listen(simServer);

  const app = express();
  app.post("/webhooks/tidewater", express.raw({ type: "application/json" }), webhookHandler(SECRET));
  const appServer = createServer(app);
  const appUrl = await listen(appServer);
  sim.setConfig({ webhookUrl: `${appUrl}/webhooks/tidewater` });

  const client = new TidewaterClient(simUrl);
  const worker = new SyncWorker(client, {}, { lanes: 3, reconcileMs: 3_600_000, idleMs: 50 });

  return {
    sim,
    simUrl,
    client,
    worker,
    async stop() {
      await worker.stop();
      sim.stop();
      await new Promise((r) => simServer.close(r));
      await new Promise((r) => appServer.close(r));
    },
  };
}

/** Polls until fn returns truthy or times out. */
export async function until<T>(fn: () => Promise<T>, timeoutMs = 20_000, everyMs = 100): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export async function quiescent(timeoutMs = 60_000) {
  try {
    await until(async () => (await col.links().countDocuments({ syncStatus: { $in: ["pending", "retrying"] } })) === 0, timeoutMs);
  } catch (e) {
    const stuck = await col.links().find({ syncStatus: { $in: ["pending", "retrying"] } }).toArray();
    console.error("stuck links", stuck.map((l) => ({ id: l._id, s: l.syncStatus, a: l.attempts, err: l.lastError, next: l.nextAttemptAt, lease: l.leaseUntil, ev: l.eventId, obs: l.observed, des: l.desired, strays: l.strays, needsLookup: l.needsLookup })));
    throw e;
  }
}

/** Diff of desired vs the simulator's actual state, keyed by app_ref. */
export function audit(sim: ReturnType<typeof createSimulator>, links: CalendarLink[]) {
  const all = sim.store.all();
  return links
    .map((l) => {
      const actual = all.filter((e) => e.app_ref === l.appRef);
      if (!l.desired.present) return actual.length ? `${l.appRef}: should be absent` : null;
      if (actual.length !== 1) return `${l.appRef}: ${actual.length} events`;
      return Date.parse(actual[0].start) === Date.parse(l.desired.start!) ? null : `${l.appRef}: wrong time`;
    })
    .filter(Boolean);
}
