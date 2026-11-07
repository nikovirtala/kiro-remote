import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("surfaces secrets only as presence booleans, never values", () => {
    const { config, secrets } = loadConfig({
      KIRO_API_KEY: "ksk_realsecret",
      KIRO_API_E2E_REPO: "owner/private-repo",
      KIRO_REMOTE_URL: "https://host.example.com/",
    });
    // Config carries no secret values.
    const configJson = JSON.stringify(config);
    expect(configJson).not.toContain("ksk_realsecret");
    expect(configJson).not.toContain("owner/private-repo");
    expect(config.hasApiKey).toBe(true);
    expect(config.hasRepo).toBe(true);
    // Trailing slash stripped from the base URL.
    expect(config.baseUrl).toBe("https://host.example.com");
    // Secrets are reachable only via the accessors, held in memory.
    expect(secrets.apiKey()).toBe("ksk_realsecret");
    expect(secrets.repo()).toBe("owner/private-repo");
  });

  it("treats missing or empty env values as absent", () => {
    const { config, secrets } = loadConfig({ KIRO_API_KEY: "   ", KIRO_API_E2E_REPO: "" });
    expect(config.hasApiKey).toBe(false);
    expect(config.hasRepo).toBe(false);
    expect(config.baseUrl).toBeNull();
    expect(secrets.apiKey()).toBeNull();
    expect(secrets.repo()).toBeNull();
  });
});
