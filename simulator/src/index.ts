// Starts the Tidewater simulator. See ../README.md for the contract and admin endpoints.

import { fileURLToPath } from "node:url";
import { createSimulator } from "./app";
import { configFromEnv } from "./config";
import { mulberry32 } from "./util";

const port = Number(process.env.TIDEWATER_PORT ?? 4010);
const preloadPath = process.env.TIDEWATER_PRELOAD ?? fileURLToPath(new URL("../../seed/tidewater-preload.json", import.meta.url));
const seed = process.env.TIDEWATER_RANDOM_SEED ? Number(process.env.TIDEWATER_RANDOM_SEED) : Date.now();

const sim = createSimulator({
  config: configFromEnv(process.env),
  preloadPath,
  rand: mulberry32(seed),
  quiet: process.env.TIDEWATER_QUIET === "1",
});

sim.app.listen(port, () => {
  const cfg = sim.getConfig();
  console.log(`[tidewater] listening on http://localhost:${port}  (panel: http://localhost:${port}/__sim/panel)`);
  console.log(`[tidewater] preloaded ${sim.store.all().length} events from ${preloadPath}`);
  console.log(`[tidewater] webhooks -> ${cfg.webhookUrl ?? "(not set: deliveries are logged but not sent)"}`);
  console.log(`[tidewater] failRate=${cfg.failRate} rateLimitPerSec=${cfg.rateLimitPerSec} duplicateRate=${cfg.duplicateRate} reorderRate=${cfg.reorderRate} randomSeed=${seed}`);
});
