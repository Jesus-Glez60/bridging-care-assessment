// Proves the simulator behaves the way the README says it does.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createSimulator } from "../src/app";
import { DEFAULTS, mergeConfig } from "../src/config";
import { mulberry32 } from "../src/util";
import { sign } from "../src/webhooks";

type Received = { raw: string; signature: string | undefined; body: any };

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanups.push(() => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function setup(overrides: Record<string, unknown> = {}) {
  const received: Received[] = [];
  const receiver = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      received.push({ raw, signature: req.headers["x-tidewater-signature"] as string, body: JSON.parse(raw) });
      res.writeHead(204).end();
    });
  });
  const webhookUrl = await listen(receiver);
  const config = mergeConfig(DEFAULTS, {
    webhookUrl,
    latencyMinMs: 0,
    latencyMaxMs: 0,
    webhookDelayMinMs: 0,
    webhookDelayMaxMs: 0,
    duplicateRate: 0,
    reorderRate: 0,
    rateLimitPerSec: 0,
    ...overrides,
  });
  const sim = createSimulator({ config, rand: mulberry32(42), quiet: true });
  cleanups.push(() => sim.stop());
  const base = await listen(createServer(sim.app));
  const api = (path: string, method = "GET", body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { sim, api, received };
}

const event = { title: "Harbor Light: Tuesday Dinner Prep", start: "2026-11-03T16:00:00-06:00", end: "2026-11-03T18:00:00-06:00", app_ref: "test-1" };

async function waitFor(check: () => boolean, ms = 3000) {
  const until = Date.now() + ms;
  while (!check()) {
    if (Date.now() > until) throw new Error("timed out waiting for webhooks");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("Tidewater simulator", () => {
  it("rejects timestamps without an offset", async () => {
    const { api } = await setup();
    const res = await api("/v1/accounts/acct1/events", "POST", { ...event, start: "2026-11-14 10:00" });
    expect(res.status).toBe(400);
  });

  it("signs webhooks and emits them for the app's own changes", async () => {
    const { api, received } = await setup();
    const res = await api("/v1/accounts/acct1/events", "POST", event);
    expect(res.status).toBe(201);
    await waitFor(() => received.length === 1);
    expect(received[0].body.type).toBe("event.created");
    expect(received[0].body.event.app_ref).toBe("test-1");
    expect(received[0].signature).toBe(sign(received[0].raw, "tidewater-dev"));
  });

  it("delivers duplicates with the same delivery_id and identical body", async () => {
    const { api, received } = await setup({ duplicateRate: 1, duplicateDelayMinMs: 10, duplicateDelayMaxMs: 20 });
    await api("/v1/accounts/acct1/events", "POST", event);
    await waitFor(() => received.length === 2);
    expect(received[1].body.delivery_id).toBe(received[0].body.delivery_id);
    expect(received[1].raw).toBe(received[0].raw);
  });

  it("can deliver a newer version before an older one for the same event", async () => {
    const { api, received } = await setup({ reorderRate: 1 });
    const created = await (await api("/v1/accounts/acct1/events", "POST", event)).json();
    await api(`/v1/accounts/acct1/events/${created.id}`, "PATCH", { start: "2026-11-03T16:30:00-06:00" });
    await waitFor(() => received.length === 2);
    expect(received.map((r) => r.body.event.version)).toEqual([2, 1]);
  });

  it("throttles bursts with 429 and Retry-After", async () => {
    const { api } = await setup({ rateLimitPerSec: 5 });
    const responses = await Promise.all(Array.from({ length: 8 }, () => api("/v1/accounts/acct1/events", "POST", event)));
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((s) => s === 201)).toHaveLength(5);
    expect(statuses.filter((s) => s === 429)).toHaveLength(3);
    expect(responses.find((r) => r.status === 429)!.headers.get("retry-after")).toBe("1");
  });

  it("changes nothing when it returns 503", async () => {
    const { api, sim } = await setup({ failRate: 1 });
    expect((await api("/v1/accounts/acct1/events", "POST", event)).status).toBe(503);
    sim.setConfig({ failRate: 0 });
    expect((await (await api("/v1/accounts/acct1/events")).json()).events).toHaveLength(0);
  });

  it("emits event.deleted with a bumped version when the user deletes, and later PATCHes 404", async () => {
    const { api, received } = await setup();
    const created = await (await api("/v1/accounts/acct1/events", "POST", event)).json();
    await api(`/__sim/accounts/acct1/events/${created.id}/user-delete`, "POST");
    await waitFor(() => received.length === 2);
    const deleted = received.find((r) => r.body.type === "event.deleted")!;
    expect(deleted.body.event.version).toBe(2);
    expect((await api(`/v1/accounts/acct1/events/${created.id}`, "PATCH", { title: "x" })).status).toBe(404);
  });

  it("replays a delivery byte-for-byte", async () => {
    const { api, received } = await setup();
    await api("/v1/accounts/acct1/events", "POST", event);
    await waitFor(() => received.length === 1);
    const id = received[0].body.delivery_id;
    expect((await api(`/__sim/replay/${id}`, "POST")).status).toBe(200);
    await waitFor(() => received.length === 2);
    expect(received[1].raw).toBe(received[0].raw);
  });
});
