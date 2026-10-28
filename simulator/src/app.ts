// The Tidewater Calendar simulator: public /v1 API, /__sim admin endpoints, and a dev panel.

import { existsSync, readFileSync } from "node:fs";
import express, { type NextFunction, type Request, type Response } from "express";
import { mergeConfig, type SimConfig } from "./config";
import { EventStore, publicView, ValidationError, type TwEvent } from "./store";
import { between, sleep, ulid } from "./util";
import { Dispatcher } from "./webhooks";

export interface SimulatorOptions {
  config: SimConfig;
  preloadPath?: string;
  rand?: () => number;
  quiet?: boolean;
}

export function createSimulator(opts: SimulatorOptions) {
  let config = opts.config;
  const rand = opts.rand ?? Math.random;
  const log = (msg: string) => opts.quiet || console.log(`[tidewater] ${msg}`);
  const store = new EventStore();
  const dispatcher = new Dispatcher(() => config, rand, opts.quiet);

  // Token bucket shared by all /v1 calls. Refills continuously at rateLimitPerSec, holds at most that many.
  const bucket = { tokens: config.rateLimitPerSec, last: Date.now() };
  const takeToken = () => {
    const limit = config.rateLimitPerSec;
    if (limit <= 0) return true;
    const now = Date.now();
    bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.last) / 1000) * limit);
    bucket.last = now;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  };

  const reset = () => {
    dispatcher.reset();
    let events: TwEvent[] = [];
    if (opts.preloadPath && existsSync(opts.preloadPath)) {
      events = (JSON.parse(readFileSync(opts.preloadPath, "utf8")) as { events: TwEvent[] }).events;
    }
    store.load(events);
    bucket.tokens = config.rateLimitPerSec;
    bucket.last = Date.now();
    return { events: events.length };
  };
  reset();

  const app = express();
  app.use(express.json({ limit: "100kb" }));

  // ---------- public API ----------
  const v1 = express.Router();

  // Throttling and failure injection are decided when the request arrives, then latency is applied.
  // A 429 or 503 means nothing was changed.
  v1.use(async (req: Request, res: Response, next: NextFunction) => {
    const started = Date.now();
    const allowed = takeToken();
    const failed = rand() < config.failRate;
    await sleep(between(rand, config.latencyMinMs, config.latencyMaxMs));
    res.on("finish", () => log(`${req.method} ${req.originalUrl} -> ${res.statusCode} (${Date.now() - started}ms)`));
    if (!allowed) {
      res.status(429).set("Retry-After", "1").json({ error: "rate_limited", message: "Too many requests. Retry after 1 second." });
    } else if (failed) {
      res.status(503).json({ error: "unavailable", message: "Transient failure. Nothing was changed. Retry later." });
    } else {
      next();
    }
  });

  v1.get("/accounts/:accountId/events", (req, res) => {
    res.json({ events: store.list(req.params.accountId).map(publicView) });
  });

  v1.post("/accounts/:accountId/events", (req, res) => {
    const event = store.create(req.params.accountId, req.body, `evt_${ulid(rand)}`);
    dispatcher.emit("event.created", event);
    res.status(201).json(publicView(event));
  });

  v1.patch("/accounts/:accountId/events/:id", (req, res) => {
    const event = store.update(req.params.accountId, req.params.id, req.body);
    if (!event) return void res.status(404).json({ error: "not_found", message: "No such event on this account." });
    dispatcher.emit("event.updated", event);
    res.json(publicView(event));
  });

  v1.delete("/accounts/:accountId/events/:id", (req, res) => {
    const event = store.remove(req.params.accountId, req.params.id);
    if (!event) return void res.status(404).json({ error: "not_found", message: "No such event on this account." });
    dispatcher.emit("event.deleted", event);
    res.status(204).end();
  });

  app.use("/v1", v1);

  // ---------- admin (never throttled or failure-injected) ----------
  const sim = express.Router();

  sim.get("/config", (_req, res) => res.json(config));

  sim.post("/config", (req, res) => {
    config = mergeConfig(config, req.body ?? {});
    log(`config updated: ${JSON.stringify(req.body)}`);
    res.json(config);
  });

  sim.post("/reset", (_req, res) => res.json({ reset: true, ...reset() }));

  sim.get("/state", (_req, res) => {
    const accounts: Record<string, ReturnType<typeof publicView>[]> = {};
    for (const e of store.all()) (accounts[e.accountId] ??= []).push(publicView(e));
    res.json({ accounts });
  });

  // Simulates the volunteer deleting the event in their own calendar app.
  sim.post("/accounts/:accountId/events/:id/user-delete", (req, res) => {
    const event = store.remove(req.params.accountId, req.params.id);
    if (!event) return void res.status(404).json({ error: "not_found" });
    dispatcher.emit("event.deleted", event);
    res.json({ deleted: publicView(event) });
  });

  // Simulates the volunteer editing the event in their own calendar app.
  sim.post("/accounts/:accountId/events/:id/user-edit", (req, res) => {
    const { start, end, title } = req.body ?? {};
    const event = store.update(req.params.accountId, req.params.id, { start, end, title });
    if (!event) return void res.status(404).json({ error: "not_found" });
    dispatcher.emit("event.updated", event);
    res.json({ updated: publicView(event) });
  });

  sim.get("/deliveries", (req, res) => {
    const eventId = typeof req.query.event_id === "string" ? req.query.event_id : undefined;
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 2000);
    const rows = dispatcher.log.filter((d) => !eventId || d.event_id === eventId);
    res.json({ deliveries: rows.slice(-limit).reverse() });
  });

  sim.post("/replay/:deliveryId", async (req, res) => {
    const attempt = await dispatcher.replay(req.params.deliveryId);
    if (!attempt) return void res.status(404).json({ error: "not_found" });
    res.json({ replayed: req.params.deliveryId, attempt });
  });

  const panelPath = new URL("./panel.html", import.meta.url);
  sim.get("/panel", (_req, res) => res.type("html").send(readFileSync(panelPath, "utf8")));

  app.use("/__sim", sim);
  app.get("/", (_req, res) => res.redirect("/__sim/panel"));

  // ---------- errors ----------
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof ValidationError) return void res.status(400).json({ error: "invalid_request", message: err.message });
    const e = err as { type?: string; message?: string };
    if (e.type === "entity.parse.failed") return void res.status(400).json({ error: "invalid_json", message: "Body is not valid JSON." });
    if (e.message?.startsWith("Unknown config key") || e.message?.includes(" must ")) {
      return void res.status(400).json({ error: "invalid_config", message: e.message });
    }
    console.error(err);
    res.status(500).json({ error: "internal", message: "Simulator error." });
  });

  return {
    app,
    store,
    dispatcher,
    reset,
    getConfig: () => config,
    setConfig: (patch: Partial<SimConfig>) => (config = mergeConfig(config, patch)),
    stop: () => dispatcher.stop(),
  };
}
