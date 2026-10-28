// Starter skeleton — replace freely.
import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies X-Tidewater-Signature: hex HMAC-SHA256 of the raw request body. */
export function verifyTidewaterSignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = Buffer.from(createHmac("sha256", secret).update(raw).digest("hex"), "utf8");
  const received = Buffer.from(header, "utf8");
  return expected.length === received.length && timingSafeEqual(expected, received);
}
