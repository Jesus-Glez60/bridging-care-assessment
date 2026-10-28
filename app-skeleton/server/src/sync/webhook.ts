// Inbound Tidewater webhooks. Signature is checked on the raw bytes. Recording the delivery_id and
// applying its effect happen in one transaction, so a crash can't leave a delivery "seen" but unapplied.
// Any failure returns 503 and the provider retries; a concurrent duplicate loses the race the same way.
import type { Request, Response } from "express";
import { col, tx } from "../db";
import { verifyTidewaterSignature } from "../signature";
import type { TwEventPayload } from "../types";
import { applyObservation, type ObservationType } from "./engine";

const TYPES = new Set(["event.created", "event.updated", "event.deleted"]);

export function webhookHandler(secret: string) {
  return async (req: Request, res: Response) => {
    const raw = req.body as Buffer;
    if (!Buffer.isBuffer(raw) || !verifyTidewaterSignature(raw, req.header("x-tidewater-signature"), secret)) {
      res.status(401).json({ error: "bad_signature" });
      return;
    }
    let payload: { delivery_id: string; type: string; event: TwEventPayload };
    try {
      payload = JSON.parse(raw.toString("utf8"));
    } catch {
      res.status(400).json({ error: "bad_json" });
      return;
    }
    if (!payload?.delivery_id || !TYPES.has(payload.type) || !payload.event?.id || typeof payload.event.version !== "number") {
      res.status(400).json({ error: "bad_payload" });
      return;
    }
    try {
      const outcome = await tx(async (session) => {
        const dup = await col.deliveries().findOne({ _id: payload.delivery_id }, { session });
        if (dup) return "duplicate_delivery";
        const result = await applyObservation(payload.event.app_ref ?? "", payload.type as ObservationType, payload.event, session);
        await col.deliveries().insertOne({ _id: payload.delivery_id, receivedAt: new Date(), outcome: result, type: payload.type, eventId: payload.event.id }, { session });
        return result;
      });
      res.status(200).json({ outcome });
    } catch (e) {
      console.error("[webhook] failed, asking provider to retry", (e as Error).message);
      res.status(503).json({ error: "retry" });
    }
  };
}
