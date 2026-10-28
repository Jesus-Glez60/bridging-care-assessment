// Harbor Light shift coordination server: API, Tidewater webhook receiver, sync worker, and (in Docker)
// the built Angular client and static mockups.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import mongoose from "mongoose";
import { apiRouter } from "./api/routes";
import { initClock } from "./clock";
import { col, ensureIndexes } from "./db";
import { expireOffers } from "./domain/signups";
import { normalizeSeed } from "./import/normalize";
import { importSeed } from "./seed-import";
import { SyncWorker } from "./sync/engine";
import { TidewaterClient } from "./sync/tidewater";
import { webhookHandler } from "./sync/webhook";

const PORT = Number(process.env.PORT ?? 3000);
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017/harborlight?directConnection=true";
const TIDEWATER_SECRET = process.env.TIDEWATER_SECRET ?? "tidewater-dev";
const TIDEWATER_BASE_URL = process.env.TIDEWATER_BASE_URL ?? "http://localhost:4010";
const SEED_PATH = process.env.SEED_PATH ?? fileURLToPath(new URL("../../../seed/data.json", import.meta.url));
const CLIENT_DIST = process.env.CLIENT_DIST ?? fileURLToPath(new URL("../../client/dist/client/browser", import.meta.url));
const MOCKUPS_DIR = process.env.MOCKUPS_DIR ?? fileURLToPath(new URL("../../../mockups", import.meta.url));

const client = new TidewaterClient(TIDEWATER_BASE_URL);
const worker = new SyncWorker(client, { onExpireOffers: expireOffers });
let simBaseline: Record<string, unknown> | null = null;

async function seedIfEmpty() {
  if (await col.org().findOne({})) return null;
  await importSeed(mongoose.connection.db!, SEED_PATH);
  return normalizeSeed();
}

async function resetDemo() {
  await worker.stop();
  try {
    await fetch(`${TIDEWATER_BASE_URL}/__sim/reset`, { method: "POST" });
    if (simBaseline) {
      const { webhookUrl: _ignored, ...settings } = simBaseline;
      await fetch(`${TIDEWATER_BASE_URL}/__sim/config`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(settings) });
    }
    await importSeed(mongoose.connection.db!, SEED_PATH);
    return await normalizeSeed();
  } finally {
    worker.start();
  }
}

const app = express();
app.disable("x-powered-by");

// Registered before express.json(): signature verification needs the exact raw bytes.
app.post("/webhooks/tidewater", express.raw({ type: "application/json", limit: "64kb" }), webhookHandler(TIDEWATER_SECRET));

app.use(express.json({ limit: "32kb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected", tidewater: client.limiter.stats });
});

app.use("/api", apiRouter({ tidewaterBaseUrl: TIDEWATER_BASE_URL, resetDemo }));

if (existsSync(MOCKUPS_DIR)) app.use("/mockups", express.static(MOCKUPS_DIR, { extensions: ["html"] }));
if (existsSync(CLIENT_DIST)) {
  app.use(express.static(CLIENT_DIST));
  app.get(/^\/(?!api|webhooks|health|mockups).*/, (_req, res) => res.sendFile(`${CLIENT_DIST}/index.html`));
}

await mongoose.connect(MONGO_URL);
await ensureIndexes();
const seeded = await seedIfEmpty();
if (seeded) console.log("[seed] imported", seeded);
const org = await col.org().findOne({});
await initClock(org!.simulatedNow);
try {
  simBaseline = (await (await fetch(`${TIDEWATER_BASE_URL}/__sim/config`)).json()) as Record<string, unknown>;
} catch {
  console.warn(`[tidewater] simulator not reachable at ${TIDEWATER_BASE_URL}; sync will retry until it is.`);
}
if (process.env.SYNC_WORKER !== "off") worker.start();
app.listen(PORT, () => console.log(`[harbor-light] http://localhost:${PORT}  (mongo: ${MONGO_URL}, tidewater: ${TIDEWATER_BASE_URL})`));
