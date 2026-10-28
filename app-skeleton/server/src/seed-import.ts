// Starter skeleton — replace freely.
// Copies seed/data.json into MongoDB as-is. No cleaning, no derived data, no occurrence generation.
import { readFileSync } from "node:fs";
import type { mongo } from "mongoose";

export async function importSeed(db: mongo.Db, seedPath: string) {
  const data = JSON.parse(readFileSync(seedPath, "utf8"));
  const collections: Record<string, unknown[]> = {
    org: [data.org],
    series: data.series,
    exceptions: data.exceptions,
    volunteers: data.volunteers,
    signups_import: data.signups,
  };
  const counts: Record<string, number> = {};
  for (const [name, docs] of Object.entries(collections)) {
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs.map((d) => ({ ...(d as object) })));
    counts[name] = docs.length;
  }
  return counts;
}
