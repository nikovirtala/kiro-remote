import { describe, expect, test } from "vitest";
import {
  CIMD_MAX_BYTES,
  CimdError,
  CimdFetcher,
  type CimdHttpGetter,
  type CimdHttpResponse,
  isDisallowedAddress,
} from "./cimd.ts";

const ALLOWED = ["claude.ai", "kiro.example.com"];

function okResponse(body: string, headers: Record<string, string> = {}): CimdHttpResponse {
  return { status: 200, redirected: false, headers, body, tooLarge: false };
}

function validDoc(clientId: string): string {
  return JSON.stringify({
    client_id: clientId,
    client_name: "Claude",
    redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
    grant_types: ["authorization_code", "refresh_token"],
    token_endpoint_auth_method: "none",
  });
}

/** A getter bound to a canned response, recording the URL it was asked for. */
function getterReturning(res: CimdHttpResponse): { getter: CimdHttpGetter; calls: string[] } {
  const calls: string[] = [];
  const getter: CimdHttpGetter = async (url) => {
    calls.push(url);
    return res;
  };
  return { getter, calls };
}

describe("isDisallowedAddress", () => {
  test.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "0.0.0.0",
    "100.64.0.1",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    "224.0.0.1",
  ])("rejects private/loopback/link-local %s", (addr) => {
    expect(isDisallowedAddress(addr)).toBe(true);
  });

  test.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "2606:4700:4700::1111"])(
    "allows public %s",
    (addr) => {
      expect(isDisallowedAddress(addr)).toBe(false);
    },
  );
});

describe("CIMD SSRF guard", () => {
  test("rejects non-https client_id", async () => {
    const { getter } = getterReturning(okResponse("{}"));
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getter,
    });
    await expect(f.fetch("http://claude.ai/client.json")).rejects.toMatchObject({
      oauthError: "invalid_client",
    });
  });

  test("rejects client_id URL without a path component", async () => {
    const { getter } = getterReturning(okResponse("{}"));
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getter,
    });
    await expect(f.fetch("https://claude.ai")).rejects.toBeInstanceOf(CimdError);
    await expect(f.fetch("https://claude.ai/")).rejects.toBeInstanceOf(CimdError);
  });

  test("rejects a host not on the allow-list", async () => {
    const { getter } = getterReturning(okResponse(validDoc("https://evil.example/c.json")));
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getter,
    });
    await expect(f.fetch("https://evil.example/c.json")).rejects.toMatchObject({
      message: expect.stringContaining("not allowed"),
    });
  });

  test("rejects a host resolving to a private IP", async () => {
    const { getter, calls } = getterReturning(okResponse(validDoc("https://claude.ai/c.json")));
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["10.0.0.5"],
      httpGet: getter,
    });
    await expect(f.fetch("https://claude.ai/c.json")).rejects.toMatchObject({
      message: expect.stringContaining("disallowed address"),
    });
    // The HTTP getter must never run once DNS is rejected.
    expect(calls).toHaveLength(0);
  });

  test("rejects when the endpoint attempts a redirect", async () => {
    const { getter } = getterReturning({
      status: 302,
      redirected: true,
      headers: {},
      body: "",
      tooLarge: false,
    });
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getter,
    });
    await expect(f.fetch("https://claude.ai/c.json")).rejects.toMatchObject({
      message: expect.stringContaining("redirect"),
    });
  });

  test("rejects an oversize body", async () => {
    const { getter } = getterReturning({
      status: 200,
      redirected: false,
      headers: {},
      body: "x".repeat(CIMD_MAX_BYTES + 10),
      tooLarge: true,
    });
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getter,
    });
    await expect(f.fetch("https://claude.ai/c.json")).rejects.toMatchObject({
      message: expect.stringContaining("size limit"),
    });
  });

  test("propagates a timeout surfaced by the getter", async () => {
    const getter: CimdHttpGetter = async () => {
      throw new Error("The operation was aborted due to timeout");
    };
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getter,
    });
    await expect(f.fetch("https://claude.ai/c.json")).rejects.toThrow(/timeout/);
  });
});

describe("CIMD document validation", () => {
  test("accepts a valid document and derives max-age from Cache-Control", async () => {
    const clientId = "https://claude.ai/c.json";
    const { getter } = getterReturning(
      okResponse(validDoc(clientId), { "cache-control": "public, max-age=600" }),
    );
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getter,
    });
    const result = await f.fetch(clientId);
    expect(result.document.client_id).toBe(clientId);
    expect(result.maxAgeMs).toBe(600_000);
  });

  test("rejects a document whose client_id does not equal the URL", async () => {
    const { getter } = getterReturning(okResponse(validDoc("https://claude.ai/OTHER.json")));
    const f = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getter,
    });
    await expect(f.fetch("https://claude.ai/c.json")).rejects.toMatchObject({
      message: expect.stringContaining("does not match"),
    });
  });

  test("rejects malformed JSON and missing required fields", async () => {
    const f1 = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getterReturning(okResponse("{not json")).getter,
    });
    await expect(f1.fetch("https://claude.ai/c.json")).rejects.toMatchObject({
      message: expect.stringContaining("not valid JSON"),
    });

    const noRedirects = JSON.stringify({ client_id: "https://claude.ai/c.json", client_name: "x" });
    const f2 = new CimdFetcher({
      allowedHosts: ALLOWED,
      resolve: async () => ["8.8.8.8"],
      httpGet: getterReturning(okResponse(noRedirects)).getter,
    });
    await expect(f2.fetch("https://claude.ai/c.json")).rejects.toMatchObject({
      message: expect.stringContaining("redirect_uris"),
    });
  });
});
