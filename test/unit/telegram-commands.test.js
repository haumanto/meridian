// The Telegram "/" menu list. Telegram rejects the ENTIRE setMyCommands
// call if any entry is malformed, so validate the static list here.

import { describe, it, expect, beforeAll } from "vitest";

// telegram.js reads env at module load but constructs nothing that needs
// a token; still, import dynamically for symmetry with the other suites.
let buildBotCommands;
beforeAll(async () => {
  ({ buildBotCommands } = await import("../../telegram.js"));
});

describe("buildBotCommands", () => {
  it("returns a non-empty array", () => {
    const c = buildBotCommands();
    expect(Array.isArray(c)).toBe(true);
    expect(c.length).toBeGreaterThan(0);
  });

  it("every command name matches Telegram's ^[a-z0-9_]{1,32}$", () => {
    for (const { command } of buildBotCommands()) {
      expect(command, `bad command: ${command}`).toMatch(/^[a-z0-9_]{1,32}$/);
    }
  });

  it("every description is a non-empty string ≤ 256 chars", () => {
    for (const { command, description } of buildBotCommands()) {
      expect(typeof description, `desc type for ${command}`).toBe("string");
      expect(description.trim().length, `empty desc for ${command}`).toBeGreaterThan(0);
      expect(description.length, `desc too long for ${command}`).toBeLessThanOrEqual(256);
    }
  });

  it("has no duplicate command names", () => {
    const names = buildBotCommands().map((c) => c.command);
    expect(new Set(names).size).toBe(names.length);
  });

  it("includes the safety-critical commands", () => {
    const names = new Set(buildBotCommands().map((c) => c.command));
    for (const must of ["emergency_stop", "resume", "close", "closeall"]) {
      expect(names.has(must), `missing ${must}`).toBe(true);
    }
  });

  it("excludes hyphen/alias forms that Telegram would reject", () => {
    const names = buildBotCommands().map((c) => c.command);
    expect(names).not.toContain("emergency-stop");
    expect(names).not.toContain("emergencystop");
    expect(names).not.toContain("configmenu");
  });
});
