import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.ts";

describe("loadConfig", () => {
  it("surfaces the repo only as a presence boolean and strips the trailing slash", () => {
    const { config, secrets } = loadConfig({
      KIRO_API_KEY: "ksk_realsecret",
      KIRO_API_E2E_REPO: "owner/private-repo",
      KIRO_REMOTE_URL: "https://host.example.com/",
    });
    const configJson = JSON.stringify(config);
    expect(configJson).not.toContain("owner/private-repo");
    expect(configJson).not.toContain("ksk_realsecret");
    expect(config).toEqual({ baseUrl: "https://host.example.com", hasRepo: true });
    expect(secrets.repo()).toBe("owner/private-repo");
    // KIRO_API_KEY is the bridge's credential and is not read by the harness.
    expect(Object.keys(secrets)).toEqual(["repo"]);
  });

  it("treats missing or empty env values as absent", () => {
    const { config, secrets } = loadConfig({ KIRO_REMOTE_URL: "  ", KIRO_API_E2E_REPO: "" });
    expect(config.hasRepo).toBe(false);
    expect(config.baseUrl).toBeNull();
    expect(secrets.repo()).toBeNull();
  });
});
