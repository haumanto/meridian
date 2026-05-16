// Deploy rate-limit tests. After N successful deploys in an hour, the next
// safety check must refuse. Same for the daily window. The counter is
// persisted to state.json; tests chdir to a tmpdir so the live state file
// is never touched.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("deploy rate-limit helpers", () => {
  let getDeployRateState, recordDeployForRateLimit, _resetDeployRateLimit;
  let tmpdir;

  // Isolate via MERIDIAN_DATA_DIR + module reset: rate-limit persists to
  // state.json — must bind to the tmpdir, never the live state file.
  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-rate-"));
    process.env.MERIDIAN_DATA_DIR = tmpdir;
    vi.resetModules();
    const mod = await import("../../tools/rate-limit.js");
    getDeployRateState = mod.getDeployRateState;
    recordDeployForRateLimit = mod.recordDeployForRateLimit;
    _resetDeployRateLimit = mod._resetDeployRateLimit;
    _resetDeployRateLimit();
  });

  afterEach(() => {
    delete process.env.MERIDIAN_DATA_DIR;
    vi.resetModules();
    fs.rmSync(tmpdir, { recursive: true, force: true });
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

describe("shouldNotifyDeployCapPause (throttle)", () => {
  let shouldNotifyDeployCapPause;
  const HOUR = 60 * 60 * 1000;

  beforeEach(async () => {
    ({ shouldNotifyDeployCapPause } = await import("../../tools/rate-limit.js"));
  });

  it("fires on the first notice (lastNoticeMs = 0 / falsy)", () => {
    expect(shouldNotifyDeployCapPause(1_000_000, 0, HOUR)).toBe(true);
    expect(shouldNotifyDeployCapPause(1_000_000, null, HOUR)).toBe(true);
    expect(shouldNotifyDeployCapPause(1_000_000, undefined, HOUR)).toBe(true);
  });

  it("suppresses a repeat notice before the interval elapses", () => {
    const last = 1_000_000;
    expect(shouldNotifyDeployCapPause(last + 5 * 60 * 1000, last, HOUR)).toBe(false); // 5 min later
    expect(shouldNotifyDeployCapPause(last + HOUR - 1, last, HOUR)).toBe(false); // just under 1h
  });

  it("fires again at/after the interval", () => {
    const last = 1_000_000;
    expect(shouldNotifyDeployCapPause(last + HOUR, last, HOUR)).toBe(true); // exactly 1h
    expect(shouldNotifyDeployCapPause(last + 2 * HOUR, last, HOUR)).toBe(true);
  });
});
