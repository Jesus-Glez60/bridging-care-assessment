// Stage 1 of the import: copy seed/data.json into raw_* collections exactly as-is (the "spreadsheet").
// Stage 2 (import/normalize.ts) reads these, cleans them, and writes the domain collections plus a report,
// so the import report can always point back at the untouched source rows.
import { readFileSync } from "node:fs";
import type { mongo } from "mongoose";

export async function importSeed(db: mongo.Db, seedPath: string) {
  const data = JSON.parse(readFileSync(seedPath, "utf8"));
  const collections: Record<string, unknown[]> = {
    raw_org: [data.org],
    raw_series: data.series,
    raw_exceptions: data.exceptions,
    raw_volunteers: data.volunteers,
    raw_signups: data.signups,
  };
  const counts: Record<string, number> = {};
  for (const [name, docs] of Object.entries(collections)) {
    await db.collection(name).deleteMany({});
    if (docs.length) await db.collection(name).insertMany(docs.map((d) => ({ ...(d as object) })));
    counts[name] = docs.length;
  }
  return counts;
}
