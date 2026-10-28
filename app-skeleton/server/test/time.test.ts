import { describe, expect, it } from "vitest";
import { dualTime, normalizeZone, occurrenceWindow, offerExpiry, weeklyDates, zonedInstant } from "../src/time";

describe("schedule expansion", () => {
  it("keeps 4 PM local across the Nov 1 DST change", () => {
    const before = occurrenceWindow("2026-10-27", "16:00", "18:00", "America/Chicago");
    const after = occurrenceWindow("2026-11-03", "16:00", "18:00", "America/Chicago");
    expect(before.start.toISOString()).toBe("2026-10-27T21:00:00.000Z"); // CDT, UTC-5
    expect(after.start.toISOString()).toBe("2026-11-03T22:00:00.000Z"); // CST, UTC-6
  });

  it("expands weekly dates on the weekday, inclusive of the range end", () => {
    expect(weeklyDates("TU", "2026-10-20", "2026-11-03")).toEqual(["2026-10-20", "2026-10-27", "2026-11-03"]);
    expect(weeklyDates("SA", "2026-10-21", "2026-10-31")).toEqual(["2026-10-24", "2026-10-31"]);
  });

  it("rejects wall-clock times that don't exist", () => {
    expect(() => zonedInstant("2027-03-14", "02:30", "America/Chicago")).toThrow(/DST gap/);
  });
});

describe("zones from imported data", () => {
  it("accepts IANA zones, maps abbreviations (flagged), defaults missing", () => {
    expect(normalizeZone("America/Phoenix", "America/Chicago")).toEqual({ tz: "America/Phoenix", source: "seed" });
    expect(normalizeZone("CST", "America/Chicago")).toEqual({ tz: "America/Chicago", source: "normalized" });
    expect(normalizeZone(null, "America/Chicago")).toEqual({ tz: "America/Chicago", source: "defaulted" });
  });

  it("shows the volunteer's own time only when the wall clock differs", () => {
    const { start, end } = occurrenceWindow("2026-11-07", "09:00", "12:00", "America/Chicago");
    expect(dualTime(start, end, "America/Chicago", "America/New_York")).toEqual({ kitchen: "Sat, Nov 7 · 9 AM–12 PM CT", viewer: "Sat, Nov 7 · 10 AM–1 PM ET" });
    expect(dualTime(start, end, "America/Chicago", "America/Chicago").viewer).toBeNull();
  });
});

describe("offer holds pause during quiet hours", () => {
  it("12 waking hours from 9 AM fit exactly before 9 PM; from 10 AM they spill to 9 AM next day", () => {
    expect(offerExpiry(new Date("2026-10-21T14:00:00Z"), "America/Chicago").toISOString()).toBe("2026-10-22T02:00:00.000Z"); // 9 PM CDT
    expect(offerExpiry(new Date("2026-10-21T15:00:00Z"), "America/Chicago").toISOString()).toBe("2026-10-22T14:00:00.000Z"); // 9 AM CDT next day
  });

  it("an offer at 11 PM starts counting at 8 AM in the volunteer's zone", () => {
    const at = new Date("2026-10-22T04:00:00Z"); // 11 PM CDT Oct 21
    // Clock starts 8 AM CDT Oct 22, runs 12h → 8 PM CDT Oct 22 = 01:00Z Oct 23.
    expect(offerExpiry(at, "America/Chicago").toISOString()).toBe("2026-10-23T01:00:00.000Z");
  });

  it("uses the volunteer's zone, not the kitchen's", () => {
    const at = new Date("2026-10-22T02:30:00Z"); // 9:30 PM CDT = 10:30 PM EDT
    const chicago = offerExpiry(at, "America/Chicago");
    const newYork = offerExpiry(at, "America/New_York");
    expect(newYork.getTime()).toBeLessThan(chicago.getTime()); // New York's 8 AM comes an hour earlier
  });
});
