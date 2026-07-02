import { afterEach, describe, expect, it, vi } from "vitest";

// DEFAULT_PROVIDER / DEFAULT_MODEL are computed at module load, so each
// case re-imports the module against a fresh env.
async function loadDefaults() {
  vi.resetModules();
  return await import("./defaults.js");
}

describe("agent model defaults", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("falls back to the baked-in Anthropic pair when env is unset", async () => {
    vi.stubEnv("KWAVE_DEFAULT_PROVIDER", "");
    vi.stubEnv("KWAVE_DEFAULT_MODEL", "");
    const mod = await loadDefaults();
    expect(mod.DEFAULT_PROVIDER).toBe("anthropic");
    expect(mod.DEFAULT_MODEL).toBe("claude-sonnet-4-6");
  });

  it("honors the companion-pushed registry default", async () => {
    vi.stubEnv("KWAVE_DEFAULT_PROVIDER", "anthropic");
    vi.stubEnv("KWAVE_DEFAULT_MODEL", "claude-haiku-4-5-20251001");
    const mod = await loadDefaults();
    expect(mod.DEFAULT_PROVIDER).toBe("anthropic");
    expect(mod.DEFAULT_MODEL).toBe("claude-haiku-4-5-20251001");
  });

  it("ignores whitespace-only overrides", async () => {
    vi.stubEnv("KWAVE_DEFAULT_MODEL", "   ");
    const mod = await loadDefaults();
    expect(mod.DEFAULT_MODEL).toBe("claude-sonnet-4-6");
  });
});
