// Starter skeleton — replace freely.
// Express + Mongoose shell: health check, seed import, a user list for the client's switcher,
// and a Tidewater webhook route that verifies the signature and logs. No domain logic.
import { fileURLToPath } from "node:url";
import express from "express";
import mongoose from "mongoose";
import { importSeed } from "./seed-import";
import { verifyTidewaterSignature } from "./signature";

const PORT = Number(process.env.PORT ?? 3000);
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://localhost:27017/harborlight?directConnection=true";
const TIDEWATER_SECRET = process.env.TIDEWATER_SECRET ?? "tidewater-dev";
const SEED_PATH = process.env.SEED_PATH ?? fileURLToPath(new URL("../../../seed/data.json", import.meta.url));

const app = express();

// Registered before express.json(): signature verification needs the exact raw bytes.
app.post("/webhooks/tidewater", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body as Buffer;
  if (!verifyTidewaterSignature(raw, req.header("x-tidewater-signature"), TIDEWATER_SECRET)) {
    res.status(401).json({ error: "bad_signature" });
    return;
  }
  console.log("[webhook]", raw.toString("utf8"));
  res.status(204).end();
});

app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ ok: true, mongo: mongoose.connection.readyState === 1 ? "connected" : "disconnected" });
});

app.post("/seed", async (_req, res) => {
  const counts = await importSeed(mongoose.connection.db!, SEED_PATH);
  res.json({ imported: counts });
});

app.get("/api/users", async (_req, res) => {
  const db = mongoose.connection.db!;
  const org = await db.collection("org").findOne({});
  const volunteers = await db.collection("volunteers").find({}, { projection: { _id: 0, id: 1, name: 1 } }).sort({ id: 1 }).toArray();
  if (!org) {
    res.status(409).json({ error: "not_seeded", message: "Run POST /seed first." });
    return;
  }
  res.json({ coordinators: org.coordinators ?? [], volunteers });
});

await mongoose.connect(MONGO_URL);
app.listen(PORT, () => console.log(`[skeleton] http://localhost:${PORT}  (mongo: ${MONGO_URL})`));
