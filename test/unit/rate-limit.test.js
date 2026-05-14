// Deploy rate-limit tests. After N successful deploys in an hour, the next
// safety check must refuse. Same for the daily window.

import { describe, it, expect, beforeEach } from "vitest";

describe("deploy rate-limit helpers", () => {
  let getDeployRateState, recordDeployForRateLimit, _resetDeployRateLimit;

  beforeEach(async () => {
    const mod = await import("../../tools/rate-limit.js");
    getDeployRateState = mod.getDeployRateState;
    recordDeployForRateLimit = mod.recordDeployForRateLimit;
    _resetDeployRateLimit = mod._resetDeployRateLimit;
    _resetDeployRateLimit();
  });

  it("starts at zero", () => {
    const { lastHour, lastDay } = getDeployRateState();
    expect(lastHour).toBe(0);
    expect(lastDay).toBe(0);
  });

  it("increments on record", () => {
    recordDeployForRateLimit();
    recordDeployForRateLimit();
    const { lastHour, lastDay } = getDeployRateState();
    expect(lastHour).toBe(2);
    expect(lastDay).toBe(2);
  });

  it("prunes entries older than 24 hours", () => {
    const now = Date.now();
    const dayPlusOne = now - 25 * 60 * 60 * 1000;
    recordDeployForRateLimit(dayPlusOne);
    recordDeployForRateLimit(now);
    const { lastHour, lastDay } = getDeployRateState(now);
    expect(lastDay).toBe(1); // old entry pruned
    expect(lastHour).toBe(1);
  });

  it("hourly window excludes entries older than 60 min", () => {
    const now = Date.now();
    const ninetyMinAgo = now - 90 * 60 * 1000;
    recordDeployForRateLimit(ninetyMinAgo);
    recordDeployForRateLimit(now);
    const { lastHour, lastDay } = getDeployRateState(now);
    expect(lastDay).toBe(2);
    expect(lastHour).toBe(1);
  });
});
