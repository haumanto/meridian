// LLM fallback: candidate-chain construction + provider-down classifier.
// Pure helpers from agent.js, exercised without any network.

import { describe, it, expect, beforeAll } from "vitest";

// agent.js constructs a default OpenAI client at module load, which needs
// *some* key present. Production supplies it via envcrypt/.env; for the
// unit test set a dummy then dynamic-import so env is ready first.
let buildLlmCandidates, isProviderDown, config;
beforeAll(async () => {
  process.env.LLM_API_KEY ||= "test-key";
  ({ buildLlmCandidates, isProviderDown } = await import("../../agent.js"));
  ({ config } = await import("../../config.js"));
});

const role = (over = {}) => ({
  baseUrl: "https://opencode.ai/zen/go/v1",
  apiKey: "kKEY",
  model: "qwen3.6-plus",
  temperature: 0.3,
  maxTokens: 4096,
  fallbackModels: [],
  alt: null,
  role: "SCREENER",
  ...over,
});

describe("isProviderDown", () => {
  it("true for connection-level failures", () => {
    expect(isProviderDown(Object.assign(new Error("x"), { code: "ECONNREFUSED" }))).toBe(true);
    expect(isProviderDown(Object.assign(new Error("x"), { code: "ENOTFOUND" }))).toBe(true);
    expect(isProviderDown(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isProviderDown(new Error("fetch failed"))).toBe(true);
    expect(isProviderDown(new Error("getaddrinfo ENOTFOUND opencode.ai"))).toBe(true);
    expect(isProviderDown(new Error("socket hang up"))).toBe(true);
  });
  it("false for 5xx / model errors / nullish (those = model-degraded, try sibling first)", () => {
    expect(isProviderDown(Object.assign(new Error("Service Unavailable"), { status: 503 }))).toBe(false);
    expect(isProviderDown(new Error("upstream model overloaded"))).toBe(false);
    expect(isProviderDown(new Error("invalid request"))).toBe(false);
    expect(isProviderDown(null)).toBe(false);
  });
});

describe("buildLlmCandidates", () => {
  it("back-compat: no fallback, non-OpenRouter → single primary candidate", () => {
    const c = buildLlmCandidates(role(), null, false);
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ baseUrl: "https://opencode.ai/zen/go/v1", model: "qwen3.6-plus", tier: "primary" });
  });

  it("same-provider siblings appended in order, same baseUrl/apiKey", () => {
    const c = buildLlmCandidates(role({ fallbackModels: ["minimax-m2.7", "deepseek-v4-pro"] }), null, false);
    expect(c.map((x) => x.model)).toEqual(["qwen3.6-plus", "minimax-m2.7", "deepseek-v4-pro"]);
    expect(c.every((x) => x.baseUrl === "https://opencode.ai/zen/go/v1" && x.apiKey === "kKEY")).toBe(true);
    expect(c.slice(1).every((x) => x.tier === "same-provider")).toBe(true);
  });

  it("explicit model overrides roleCfg.model as primary", () => {
    const c = buildLlmCandidates(role(), "kimi-k2.6", false);
    expect(c[0].model).toBe("kimi-k2.6");
  });

  it("dedupes when a fallback repeats the primary", () => {
    const c = buildLlmCandidates(role({ fallbackModels: ["qwen3.6-plus", "minimax-m2.7"] }), null, false);
    expect(c.map((x) => x.model)).toEqual(["qwen3.6-plus", "minimax-m2.7"]);
  });

  it("OpenRouter: legacy fallbackModel appended as a same-provider candidate", () => {
    const c = buildLlmCandidates(role({ baseUrl: "https://openrouter.ai/api/v1" }), null, true);
    const slugs = c.map((x) => x.model);
    expect(slugs[0]).toBe("qwen3.6-plus");
    expect(slugs).toContain(config.llm.fallbackModel); // stepfun/step-3.5-flash:free by default
    expect(c.find((x) => x.model === config.llm.fallbackModel).tier).toBe("same-provider");
  });

  it("alt provider appended LAST with its own baseUrl/apiKey/model", () => {
    const c = buildLlmCandidates(
      role({ fallbackModels: ["minimax-m2.7"], alt: { baseUrl: "https://openrouter.ai/api/v1", apiKey: "ALT", model: "anthropic/claude" } }),
      null,
      false,
    );
    const last = c[c.length - 1];
    expect(last).toMatchObject({ baseUrl: "https://openrouter.ai/api/v1", apiKey: "ALT", model: "anthropic/claude", tier: "alt-provider" });
    expect(c.findIndex((x) => x.tier === "alt-provider")).toBe(c.length - 1);
  });
});
