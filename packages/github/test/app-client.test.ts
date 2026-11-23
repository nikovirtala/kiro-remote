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

describe("what the sweep reads", () => {
  type Req = (
    route: string,
    params?: Record<string, unknown>,
  ) => Promise<{ data: unknown; headers?: Record<string, string | number | undefined> }>;
  const make = (request: Req) =>
    new GithubClient({
      credentials: CREDS,
      now: () => 0,
      auth: async (o) =>
        o.type === "app"
          ? { token: "app.jwt.token" }
          : { token: "ghs_x", expiresAt: new Date(3_600_000).toISOString() },
      request,
    });

  it("takes the rate limit from the headers of an answer, and of an error", async () => {
    let fail = false;
    const c = make(async (route) => {
      if (route.includes("/installation")) {
        return { data: { id: 5 } };
      }
      if (fail) {
        throw Object.assign(new Error("rate limited"), {
          status: 403,
          response: { headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "5000" } },
        });
      }
      return {
        data: [],
        headers: { "x-ratelimit-remaining": "4321", "x-ratelimit-reset": "1700000000" },
      };
    });
    expect(c.rateLimit()).toBeNull();
    await c.latestMergedPull("octo/repo", "main");
    expect(c.rateLimit()).toEqual({ remaining: 4321, resetAtMs: 1_700_000_000_000 });
    fail = true;
    await expect(c.latestMergedPull("octo/repo", "main")).rejects.toThrow("rate limited");
    expect(c.rateLimit()).toEqual({ remaining: 0, resetAtMs: 5_000_000 });
  });

  it("lists the closed PRs on the base and returns the latest merge, not the latest update", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const c = make(async (route, params) => {
      if (route.includes("/installation")) {
        return { data: { id: 5 } };
      }
      expect(route).toBe("GET /repos/{owner}/{repo}/pulls");
      seen.push(params ?? {});
      return {
        data: [
          { number: 9, merged_at: null, merge_commit_sha: "9".repeat(40) }, // closed unmerged
          { number: 7, merged_at: "2026-02-01T12:00:00Z", merge_commit_sha: "a".repeat(40) },
          { number: 6, merged_at: "2026-02-01T10:00:00Z", merge_commit_sha: "6".repeat(40) },
        ],
      };
    });
    expect(await c.latestMergedPull("octo/repo", "main")).toEqual({
      number: 7,
      mergedAt: "2026-02-01T12:00:00Z",
      mergeCommitSha: "a".repeat(40),
    });
    expect(seen[0]).toMatchObject({
      owner: "octo",
      repo: "repo",
      state: "closed",
      base: "main",
      sort: "updated",
      direction: "desc",
      per_page: 30,
    });
  });

  it("is null when nothing merged, the repo is not installed, or GitHub says 404", async () => {
    const none = make(async (route) =>
      route.includes("/installation") ? { data: { id: 5 } } : { data: [] },
    );
    expect(await none.latestMergedPull("octo/repo", "main")).toBeNull();
    const notInstalled = make(async () => {
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    expect(await notInstalled.latestMergedPull("octo/repo", "main")).toBeNull();
    const gone = make(async (route) => {
      if (route.includes("/installation")) {
        return { data: { id: 5 } };
      }
      throw Object.assign(new Error("not found"), { status: 404 });
    });
    expect(await gone.latestMergedPull("octo/repo", "main")).toBeNull();
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
