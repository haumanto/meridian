// Regression: cli.js `lessons add` (via lessons.js sanitizeLessonText)
// used to strip < and >, destroying comparison operators that are core
// to trading rules ("organic_score > 80"). Storage must preserve them;
// the Telegram-HTML briefing escapes them at render time instead.
// lessons.js uses ./lessons.json (cwd-relative) — chdir to a tmpdir,
// same pattern as pool-cooldown.test.js.

import { describe, it, expect, beforeEach, afterEach, beforeAll, vi } from "vitest";
import fs from "fs";
import path from "path";
import os from "os";

describe("lesson comparison operators survive storage", () => {
  let tmpdir, lessons;

  // Isolate via MERIDIAN_DATA_DIR + module reset so lessons.json binds
  // to the tmpdir, never the live file.
  beforeEach(async () => {
    tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-lesson-"));
    process.env.MERIDIAN_DATA_DIR = tmpdir;
    vi.resetModules();
    fs.mkdirSync(path.join(tmpdir, "logs"), { recursive: true }); // addLesson() calls log()
    lessons = await import("../../lessons.js");
  });

  afterEach(() => {
    delete process.env.MERIDIAN_DATA_DIR;
    vi.resetModules();
    fs.rmSync(tmpdir, { recursive: true, force: true });
  });

  it("addLesson keeps > and < verbatim", () => {
    lessons.addLesson("Prefer organic_score > 80 and bin_step < 100", [], { pinned: false, role: null });
    const got = lessons.listLessons({ limit: 10 }).lessons.map((l) => l.rule);
    expect(got).toContain("Prefer organic_score > 80 and bin_step < 100");
  });

  it("keeps backticks and >= / <= operators", () => {
    lessons.addLesson("fee/TVL `ratio` >= 0.03 but <= 0.10", [], { pinned: false, role: null });
    const rule = lessons.listLessons({ limit: 10 }).lessons.at(-1).rule;
    expect(rule).toBe("fee/TVL `ratio` >= 0.03 but <= 0.10");
  });

  it("still collapses newlines/tabs and trims (other sanitization intact)", () => {
    lessons.addLesson("  a\n\tb   c  > 5 ", [], { pinned: false, role: null });
    const rule = lessons.listLessons({ limit: 10 }).lessons.at(-1).rule;
    expect(rule).toBe("a b c > 5");
  });
});

describe("briefing escapeHtml (the HTML sink)", () => {
  let escapeHtml;
  beforeAll(async () => {
    ({ escapeHtml } = await import("../../briefing.js"));
  });

  it("escapes & < > so Telegram HTML stays valid", () => {
    expect(escapeHtml("organic_score > 80 & vol < 3")).toBe(
      "organic_score &gt; 80 &amp; vol &lt; 3",
    );
  });

  it("handles null/undefined without throwing", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});
