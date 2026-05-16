// briefingDateParts drives the daily-briefing cron, the missed-briefing
// catch-up, and the "already sent today" dedupe — they must all agree on
// the operator's local day boundary, and a bad tz must not crash the cron.

import { describe, it, expect, beforeAll } from "vitest";

let briefingDateParts;
beforeAll(async () => {
  ({ briefingDateParts } = await import("../../briefing.js"));
});

describe("briefingDateParts", () => {
  it("UTC: returns the plain UTC date/hour", () => {
    const r = briefingDateParts("UTC", new Date("2026-05-16T00:30:00Z"));
    expect(r).toEqual({ date: "2026-05-16", hour: 0, zone: "UTC" });
  });

  it("Asia/Jakarta (UTC+7) shifts across the UTC midnight boundary", () => {
    // 23:30Z is 06:30 next-day WIB — date AND day must roll forward.
    const r = briefingDateParts("Asia/Jakarta", new Date("2026-05-15T23:30:00Z"));
    expect(r).toEqual({ date: "2026-05-16", hour: 6, zone: "Asia/Jakarta" });
  });

  it("normalizes ICU midnight (\"24\") to hour 0", () => {
    // 17:00Z + 7h = 00:00 WIB exactly — must be hour 0, not 24.
    const r = briefingDateParts("Asia/Jakarta", new Date("2026-05-15T17:00:00Z"));
    expect(r.hour).toBe(0);
    expect(r.date).toBe("2026-05-16");
  });

  it("7am WIB == 00:00 UTC (the requested default)", () => {
    // When it's 07:00 WIB the cron fires; that instant is 00:00Z.
    const at7WIB = new Date("2026-05-16T00:00:00Z");
    const r = briefingDateParts("Asia/Jakarta", at7WIB);
    expect(r.hour).toBe(7);
    expect(r.date).toBe("2026-05-16");
  });

  it("invalid timezone falls back to UTC instead of throwing", () => {
    const now = new Date("2026-05-16T09:15:00Z");
    const r = briefingDateParts("Not/ARealZone", now);
    expect(r.zone).toBe("UTC");
    expect(r).toEqual({ date: "2026-05-16", hour: 9, zone: "UTC" });
  });

  it("missing tz defaults safely to UTC", () => {
    const r = briefingDateParts(undefined, new Date("2026-05-16T12:00:00Z"));
    expect(r.zone).toBe("UTC");
    expect(r.hour).toBe(12);
  });
});
