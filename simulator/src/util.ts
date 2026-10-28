// Small helpers shared by the simulator. No dependencies.

/** Seedable PRNG (mulberry32). Set TIDEWATER_RANDOM_SEED to make jitter reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** ULID-style id: 10 chars of millisecond time + 16 random chars, Crockford base32. */
export function ulid(rand: () => number, now = Date.now()): string {
  let time = "";
  for (let i = 0, t = now; i < 10; i++, t = Math.floor(t / 32)) time = CROCKFORD[t % 32] + time;
  let random = "";
  for (let i = 0; i < 16; i++) random += CROCKFORD[Math.floor(rand() * 32)];
  return time + random;
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const between = (rand: () => number, min: number, max: number) => min + rand() * (max - min);
