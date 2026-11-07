import { describe, expect, it } from "vitest";
import {
  checkHost,
  checkInspector,
  checkKiroCli,
  type PreflightProbes,
  preflight,
} from "./preflight.ts";

const absent: PreflightProbes = { which: async () => null };
const present: PreflightProbes = { which: async (b) => `/usr/bin/${b}` };

describe("preflight", () => {
  it("blocks on a missing deployed host with a precise reason", () => {
    const c = checkHost(null);
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("KIRO_REMOTE_URL is unset");
  });

  it("passes the host check when a base URL is configured", () => {
    expect(checkHost("https://host").ok).toBe(true);
  });

  it("blocks on missing kiro-cli with a command-not-found reason", async () => {
    const c = await checkKiroCli(absent);
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("`kiro-cli` is not installed");
    expect(c.reason).toContain("command not found");
  });

  it("passes the kiro-cli check when the binary is on PATH", async () => {
    expect((await checkKiroCli(present)).ok).toBe(true);
  });

  it("blocks on missing MCP Inspector", async () => {
    const c = await checkInspector(absent);
    expect(c.ok).toBe(false);
    expect(c.reason).toContain("MCP Inspector");
  });

  it("aggregates all checks", async () => {
    const pf = await preflight(null, absent);
    expect(pf.host.ok).toBe(false);
    expect(pf.kiroCli.ok).toBe(false);
    expect(pf.inspector.ok).toBe(false);
  });
});
