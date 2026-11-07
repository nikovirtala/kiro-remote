/**
 * The keychain fallback writes a 0600 file when no OS keychain is available.
 */

import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FileKeychain, type StoredTokens } from "../src/keychain.ts";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "kiro-kc-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sample: StoredTokens = {
  accessToken: "a",
  refreshToken: "r",
  expiresAt: 123,
  scope: "sessions:read",
  tokenEndpoint: "https://host/oauth/token",
  clientId: "https://host/oauth/clients/cli.json",
};

describe("FileKeychain (0600 fallback)", () => {
  it("writes the token file with 0600 permissions", async () => {
    const path = join(dir, "nested", "tokens.json");
    const kc = new FileKeychain(path);
    await kc.set(sample);

    const st = await stat(path);
    // Mask to the permission bits; owner read+write only.
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("round-trips the stored tokens", async () => {
    const path = join(dir, "tokens.json");
    const kc = new FileKeychain(path);
    await kc.set(sample);
    expect(await kc.get()).toEqual(sample);
  });

  it("returns null when no file exists", async () => {
    const kc = new FileKeychain(join(dir, "absent.json"));
    expect(await kc.get()).toBeNull();
  });

  it("clear empties the file and keeps 0600", async () => {
    const path = join(dir, "tokens.json");
    const kc = new FileKeychain(path);
    await kc.set(sample);
    await kc.clear();
    expect(await kc.get()).toBeNull();
    const raw = await readFile(path, "utf8");
    expect(raw).toBe("");
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
  });

  it("tightens a pre-existing looser file on write", async () => {
    const path = join(dir, "tokens.json");
    const kc = new FileKeychain(path);
    await kc.set(sample);
    // Re-set should re-assert 0600.
    await kc.set({ ...sample, accessToken: "b" });
    const st = await stat(path);
    expect(st.mode & 0o777).toBe(0o600);
    expect((await kc.get())?.accessToken).toBe("b");
  });
});
