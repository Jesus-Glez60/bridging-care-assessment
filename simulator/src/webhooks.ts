// Webhook delivery, modeled on how real calendar providers behave:
//   - at-least-once: some deliveries are sent twice with the same delivery_id
//   - unordered: a delivery may be overtaken by a later one for the same event
//   - retried: non-2xx responses and network errors are retried with backoff
// Every delivery is logged and can be replayed byte-for-byte.

import { createHmac } from "node:crypto";
import type { SimConfig } from "./config";
import { publicView, type TwEvent } from "./store";
import { between, ulid } from "./util";

export type WebhookType = "event.created" | "event.updated" | "event.deleted";

export interface Attempt {
  at: string;
  status: number | string; // HTTP status, "no-target", or "network-error: ..."
  kind: "original" | "retry" | "duplicate" | "replay";
}

export interface Delivery {
  delivery_id: string;
  type: WebhookType;
  event_id: string;
  version: number;
  created_at: string;
  raw: string; // exact body sent; signature is computed over this
  attempts: Attempt[];
}

const MAX_LOG = 2000;

export const sign = (raw: string, secret: string) => createHmac("sha256", secret).update(raw).digest("hex");

export class Dispatcher {
  readonly log: Delivery[] = [];
  private held = new Map<string, { delivery: Delivery; timer: NodeJS.Timeout }>();
  private timers = new Set<NodeJS.Timeout>();

  constructor(
    private config: () => SimConfig,
    private rand: () => number,
    private quiet = false,
  ) {}

  emit(type: WebhookType, event: TwEvent) {
    const cfg = this.config();
    const body = {
      delivery_id: `dlv_${ulid(this.rand)}`,
      type,
      occurred_at: new Date().toISOString(),
      event: publicView(event),
    };
    const delivery: Delivery = {
      delivery_id: body.delivery_id,
      type,
      event_id: event.id,
      version: event.version,
      created_at: body.occurred_at,
      raw: JSON.stringify(body),
      attempts: [],
    };
    this.log.push(delivery);
    if (this.log.length > MAX_LOG) this.log.splice(0, this.log.length - MAX_LOG);

    const held = this.held.get(event.id);
    if (held) {
      // An older delivery for this event is being held back: send this one first, then release the older one.
      clearTimeout(held.timer);
      this.held.delete(event.id);
      const d = this.delay();
      this.schedule(delivery, d);
      this.schedule(held.delivery, d + between(this.rand, 250, 750));
      return;
    }
    if (this.rand() < cfg.reorderRate) {
      const timer = setTimeout(() => {
        this.held.delete(event.id);
        this.schedule(delivery, 0);
      }, cfg.reorderHoldMs);
      this.held.set(event.id, { delivery, timer });
      return;
    }
    this.schedule(delivery, this.delay());
  }

  /** Re-sends a logged delivery with the identical body and delivery_id. No retries. */
  async replay(deliveryId: string): Promise<Attempt | undefined> {
    const delivery = this.log.find((d) => d.delivery_id === deliveryId);
    if (!delivery) return undefined;
    return this.send(delivery, "replay");
  }

  reset() {
    this.stop();
    this.log.length = 0;
  }

  /** Cancels everything pending (used by reset and tests). */
  stop() {
    for (const t of this.timers) clearTimeout(t);
    for (const h of this.held.values()) clearTimeout(h.timer);
    this.timers.clear();
    this.held.clear();
  }

  private delay() {
    const cfg = this.config();
    return between(this.rand, cfg.webhookDelayMinMs, cfg.webhookDelayMaxMs);
  }

  private later(ms: number, fn: () => void) {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  private schedule(delivery: Delivery, ms: number) {
    this.later(ms, async () => {
      await this.sendWithRetry(delivery, 1);
      const cfg = this.config();
      if (this.rand() < cfg.duplicateRate) {
        this.later(between(this.rand, cfg.duplicateDelayMinMs, cfg.duplicateDelayMaxMs), () => {
          void this.send(delivery, "duplicate");
        });
      }
    });
  }

  private async sendWithRetry(delivery: Delivery, attempt: number): Promise<void> {
    const result = await this.send(delivery, attempt === 1 ? "original" : "retry");
    const ok = typeof result.status === "number" && result.status >= 200 && result.status < 300;
    if (ok || result.status === "no-target" || attempt >= this.config().webhookMaxAttempts) return;
    await new Promise<void>((resolve) => this.later(1000 * 3 ** (attempt - 1), resolve));
    return this.sendWithRetry(delivery, attempt + 1);
  }

  private async send(delivery: Delivery, kind: Attempt["kind"]): Promise<Attempt> {
    const cfg = this.config();
    const attempt: Attempt = { at: new Date().toISOString(), status: "no-target", kind };
    if (cfg.webhookUrl) {
      try {
        const res = await fetch(cfg.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-tidewater-signature": sign(delivery.raw, cfg.secret) },
          body: delivery.raw,
          signal: AbortSignal.timeout(5000),
        });
        attempt.status = res.status;
      } catch (err) {
        const cause = (err as { cause?: { code?: string } }).cause?.code ?? (err as Error).name;
        attempt.status = `network-error: ${cause}`;
      }
    }
    delivery.attempts.push(attempt);
    if (!this.quiet) {
      console.log(`[tidewater] webhook ${delivery.type} v${delivery.version} ${delivery.delivery_id} (${kind}) -> ${attempt.status}`);
    }
    return attempt;
  }
}
