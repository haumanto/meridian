// The Telegram getUpdates offset must survive restarts and only advance
// after a message is handled — otherwise a command in flight during a
// restart is confirmed-and-dropped. This covers the persistence half
// (load/save round-trip + corrupt-file fallback). The "advance after
// await" half is a finally-block reorder in poll(), verified by redeploy.

import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

let tg, tmpdir, offsetPath;

beforeAll(async () => {
  tg = await import("../../telegram.js");
});

beforeEach(() => {
  tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-tgoff-"));
  offsetPath = path.join(tmpdir, "telegram-offset.json");
  tg._setOffsetPathForTest(offsetPath);
  tg._setOffsetForTest(0);
});

afterEach(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
});

describe("Telegram offset persistence", () => {
  it("save then load round-trips the offset", () => {
    tg._setOffsetForTest(42);
    tg._saveOffsetForTest();
    expect(JSON.parse(fs.readFileSync(offsetPath, "utf8"))).toEqual({ offset: 42 });
    expect(tg._loadOffsetForTest()).toBe(42);
  });

  it("missing file leaves offset at 0 (safe — Telegram resends unconfirmed)", () => {
    expect(fs.existsSync(offsetPath)).toBe(false);
    expect(tg._loadOffsetForTest()).toBe(0);
  });

  it("corrupt file falls back to 0 instead of throwing", () => {
    fs.writeFileSync(offsetPath, "{not json");
    expect(() => tg._loadOffsetForTest()).not.toThrow();
    expect(tg._getOffsetForTest()).toBe(0);
  });

  it("rejects non-integer / negative persisted offsets", () => {
    fs.writeFileSync(offsetPath, JSON.stringify({ offset: -3 }));
    expect(tg._loadOffsetForTest()).toBe(0);
    fs.writeFileSync(offsetPath, JSON.stringify({ offset: "12" }));
    expect(tg._loadOffsetForTest()).toBe(0);
  });

  it("a later save overwrites an earlier one (monotonic advance)", () => {
    tg._setOffsetForTest(100);
    tg._saveOffsetForTest();
    tg._setOffsetForTest(137);
    tg._saveOffsetForTest();
    expect(tg._loadOffsetForTest()).toBe(137);
  });
});
