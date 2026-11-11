import { redact } from "@nikovirtala/kiro-remote-core";
import { describe, expect, it } from "vitest";
import { GithubClient, parseAppSecret, TOKEN_REFRESH_MARGIN_MS } from "../src/app-client.ts";
import { createLogger } from "../src/log.ts";

const PEM =
  "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAabcdef\n-----END RSA PRIVATE KEY-----";
const CREDS = { appId: "123", privateKey: PEM, webhookSecret: "whsec_test" };

function client(opts: { tokens: Array<{ token: string; expiresAt: string }>; now: { t: number } }) {
  const calls: Array<{ type: string; installationId?: number; refresh?: boolean }> = [];
  const requests: Array<{ route: string; authorization?: string }> = [];
  let i = 0;
  const c = new GithubClient({
    credentials: CREDS,
    now: () => opts.now.t,
    auth: async (o) => {
      calls.push(o);
      if (o.type === "app") {
        return { token: "app.jwt.token" };
      }
      return opts.tokens[Math.min(i++, opts.tokens.length - 1)];
    },
    request: async (route, params) => {
      requests.push({
        route,
        authorization: (params?.headers as { authorization?: string })?.authorization,
      });
      if (route.startsWith("GET /repos/{owner}/{repo}/installation")) {
        return { data: { id: 55 } };
      }
      if (route.includes("/pulls/{pull_number}")) {
        return {
          data: {
            number: 7,
            state: "open",
            merged: false,
            created_at: "2026-02-01T10:00:00Z",
            head: { sha: "abc", ref: "b" },
            user: { login: "kiro" },
            body: "x",
          },
        };
      }
      return { data: [] };
    },
  });
  return { c, calls, requests };
}

describe("parseAppSecret", () => {
  it("reads appId, privateKey and webhookSecret", () => {
    expect(parseAppSecret(JSON.stringify(CREDS))).toEqual(CREDS);
    expect(parseAppSecret(JSON.stringify({ ...CREDS, appId: 123 })).appId).toBe("123");
  });

  it("restores PEM newlines that were stored as \\n", () => {
    expect(
      parseAppSecret(JSON.stringify({ ...CREDS, privateKey: PEM.replace(/\n/g, "\\n") }))
        .privateKey,
    ).toBe(PEM);
  });

  it("names the missing field without echoing the secret", () => {
    expect(() => parseAppSecret(JSON.stringify({ appId: "1", privateKey: PEM }))).toThrow(
      'missing "webhookSecret"',
    );
    expect(() => parseAppSecret("{nope")).toThrow("not valid JSON");
    try {
      parseAppSecret(JSON.stringify({ ...CREDS, appId: "" }));
    } catch (e) {
      expect(String(e)).not.toContain("MIIEow");
    }
  });
});

describe("installation tokens", () => {
  const FAR = "2026-02-01T12:00:00Z";

  it("are minted on demand and cached while more than 5 minutes remain", async () => {
    const now = { t: Date.parse("2026-02-01T11:00:00Z") };
    const { c, calls } = client({
      tokens: [{ token: "ghs_first00000000000000000000", expiresAt: FAR }],
      now,
    });
    expect(await c.installationToken(55)).toBe("ghs_first00000000000000000000");
    expect(await c.installationToken(55)).toBe("ghs_first00000000000000000000");
    expect(calls.filter((x) => x.type === "installation")).toHaveLength(1);
    expect(calls[0]).toMatchObject({ installationId: 55, refresh: true });
  });

  it("are refreshed once they are within 5 minutes of expiry", async () => {
    const expires = Date.parse(FAR);
    const now = { t: expires - TOKEN_REFRESH_MARGIN_MS - 1_000 };
    const { c, calls } = client({
      tokens: [
        { token: "ghs_first00000000000000000000", expiresAt: FAR },
        { token: "ghs_second0000000000000000000", expiresAt: "2026-02-01T13:00:00Z" },
      ],
      now,
    });
    expect(await c.installationToken(55)).toBe("ghs_first00000000000000000000");
    now.t = expires - TOKEN_REFRESH_MARGIN_MS + 1_000; // 4m59s left
    expect(await c.installationToken(55)).toBe("ghs_second0000000000000000000");
    expect(calls.filter((x) => x.type === "installation")).toHaveLength(2);
  });

  it("are cached per installation", async () => {
    const now = { t: Date.parse("2026-02-01T11:00:00Z") };
    const { c, calls } = client({
      tokens: [{ token: "ghs_x00000000000000000000000", expiresAt: FAR }],
      now,
    });
    await c.installationToken(1);
    await c.installationToken(2);
    expect(calls.filter((x) => x.type === "installation")).toHaveLength(2);
  });

  it("are sent only as the Authorization header of the call that needs them", async () => {
    const now = { t: Date.parse("2026-02-01T11:00:00Z") };
    const { c, requests } = client({
      tokens: [{ token: "ghs_tok0000000000000000000000", expiresAt: FAR }],
      now,
    });
    const p = await c.getPull("octo/repo", 7);
    expect(p).toMatchObject({ number: 7, headSha: "abc", createdAt: "2026-02-01T10:00:00Z" });
    expect(requests[0].authorization).toBe("bearer app.jwt.token"); // installation lookup uses the App JWT
    expect(requests[1].authorization).toBe("bearer ghs_tok0000000000000000000000");
  });

  it("returns null for a PR the App cannot see (404)", async () => {
    const c = new GithubClient({
      credentials: CREDS,
      auth: async () => ({
        token: "ghs_t0000000000000000000000",
        expiresAt: "2099-01-01T00:00:00Z",
      }),
      request: async (route) => {
        if (route.includes("/installation")) return { data: { id: 5 } };
        throw Object.assign(new Error("Not Found"), { status: 404 });
      },
    });
    expect(await c.getPull("octo/repo", 99)).toBeNull();
  });
});

describe("secrets never reach the logs", () => {
  it("installation tokens, the private key and signatures are redacted from log lines", () => {
    const lines: string[] = [];
    const log = createLogger((l) => lines.push(l));
    log.error("request failed", {
      error: `401 for Bearer ghs_16C7e42F292c6912E7710c838347Ae178B4a using key ${PEM}`,
      privateKey: PEM,
      headers: {
        authorization: "bearer ghs_16C7e42F292c6912E7710c838347Ae178B4a",
        "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
      },
      token: "ghs_16C7e42F292c6912E7710c838347Ae178B4a",
    });
    const out = lines.join("\n");
    for (const leak of ["ghs_16C7", "MIIEow", "BEGIN RSA", "a".repeat(64)]) {
      expect(out, leak).not.toContain(leak);
    }
    expect(redact(PEM)).not.toContain("MIIEow");
  });
});
