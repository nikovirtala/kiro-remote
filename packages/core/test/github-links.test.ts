import { describe, expect, it } from "vitest";
import {
  findPrUrls,
  LinkConflictError,
  linkPullRequest,
  listUnmatchedDeliveries,
  type Principal,
  parsePrRef,
  parseTrailer,
  prKeyOf,
  RepoNotAllowedError,
  redact,
  type ServiceDeps,
  trailerInstruction,
  trailerLine,
  unlinkPullRequest,
} from "../src/index.ts";
import { memoryRepository, sessionItem } from "../src/testing/memory-ddb.ts";

const P: Principal = {
  sub: "user-sub-1",
  scopes: ["sessions:read", "sessions:write", "sessions:delete"],
} as Principal;

async function setup() {
  const { repo, ddb, s3 } = await memoryRepository();
  ddb.put(sessionItem("S1"));
  ddb.put(sessionItem("S2", { createdBy: "user-sub-1" }));
  const deps = {
    repo,
    queue: { enqueue: async () => {} },
    allowedRepos: ["octo/*"],
  } as unknown as ServiceDeps;
  return { repo, ddb, s3, deps };
}

describe("PR references", () => {
  it("parses owner/repo#n and PR URLs", () => {
    expect(parsePrRef("octo/repo#12")).toEqual({ owner: "octo", repo: "repo", number: 12 });
    expect(parsePrRef("https://github.com/octo/repo/pull/12")).toEqual({
      owner: "octo",
      repo: "repo",
      number: 12,
    });
    expect(parsePrRef("https://github.com/octo/repo/pull/12/files#diff-1")?.number).toBe(12);
  });

  it("rejects things that are not pull requests", () => {
    for (const bad of [
      "octo/repo",
      "octo/repo#0",
      "octo/repo#x",
      "https://github.com/octo/repo/issues/12",
      "http://github.com/octo/repo/pull/12",
      "https://evil.example/octo/repo/pull/12",
      "octo/repo/pull/12",
    ]) {
      expect(parsePrRef(bad), bad).toBeNull();
    }
  });

  it("finds distinct PR URLs in text and stops at the URL boundary", () => {
    const text =
      "Opened https://github.com/Octo/Repo/pull/7, see also https://github.com/octo/repo/pull/7/files and (https://github.com/octo/other/pull/9).";
    expect(findPrUrls(text).map(prKeyOf)).toEqual(["octo/repo#7", "octo/other#9"]);
  });

  it("canonicalises keys to lower case", () => {
    expect(prKeyOf({ owner: "Octo", repo: "Repo", number: 3 })).toBe("octo/repo#3");
  });
});

describe("trailer", () => {
  it("formats and parses the trailer line", () => {
    expect(trailerLine("S1ABCDEFGH")).toBe("Kiro-Remote-Session: S1ABCDEFGH");
    expect(trailerInstruction("S1ABCDEFGH")).toContain("Kiro-Remote-Session: S1ABCDEFGH");
    expect(parseTrailer("Fixes docs.\n\nKiro-Remote-Session: 01HZX0000000000000000000AB\n")).toBe(
      "01HZX0000000000000000000AB",
    );
  });

  it("returns null with no trailer, and for an ambiguous body", () => {
    expect(parseTrailer(null)).toBeNull();
    expect(parseTrailer("no trailer here")).toBeNull();
    expect(
      parseTrailer("Kiro-Remote-Session: AAAAAAAAAA\nKiro-Remote-Session: BBBBBBBBBB"),
    ).toBeNull();
    // The same id twice is not ambiguous.
    expect(parseTrailer("Kiro-Remote-Session: AAAAAAAAAA\nKiro-Remote-Session: AAAAAAAAAA")).toBe(
      "AAAAAAAAAA",
    );
  });

  it("only matches the trailer at the start of a line", () => {
    expect(parseTrailer("see Kiro-Remote-Session: AAAAAAAAAA")).toBeNull();
  });
});

describe("links in the single table", () => {
  it("creates a link both ways and refuses a second session (never overwrites)", async () => {
    const { repo } = await setup();
    const first = await repo.createLink({
      repo: "octo/repo",
      number: 5,
      sessionId: "S1",
      linkedBy: "harvest",
      prState: "open",
      headSha: "abc",
    });
    expect(first.created).toBe(true);
    const second = await repo.createLink({
      repo: "octo/repo",
      number: 5,
      sessionId: "S2",
      linkedBy: "manual",
      prState: "unknown",
      headSha: null,
    });
    expect(second.created).toBe(false);
    if (!second.created) {
      expect(second.existing.sessionId).toBe("S1");
      expect(second.existing.linkedBy).toBe("harvest");
    }
    expect((await repo.getPrLink("octo/repo#5"))?.sessionId).toBe("S1");
    expect(await repo.queryLinks("S2")).toEqual([]);
    expect((await repo.queryLinks("S1")).map((l) => l.pr)).toEqual(["octo/repo#5"]);
  });

  it("stores the documented keys", async () => {
    const { repo, ddb } = await setup();
    await repo.createLink({
      repo: "octo/repo",
      number: 5,
      sessionId: "S1",
      linkedBy: "trailer",
      prState: "open",
      headSha: "abc",
    });
    expect(ddb.get("GHPR#octo/repo#5", "LINK")).toMatchObject({
      sessionId: "S1",
      linkedBy: "trailer",
      prState: "open",
      headSha: "abc",
    });
    expect(ddb.get("SESSION#S1", "LINK#octo/repo#5")).toMatchObject({ sessionId: "S1" });
  });

  it("updates PR state and only the owner can delete the link", async () => {
    const { repo } = await setup();
    await repo.createLink({
      repo: "octo/repo",
      number: 5,
      sessionId: "S1",
      linkedBy: "harvest",
      prState: "open",
      headSha: "a",
    });
    await repo.updateLinkState("octo/repo#5", { prState: "merged", headSha: "b" });
    expect(await repo.getPrLink("octo/repo#5")).toMatchObject({ prState: "merged", headSha: "b" });
    expect(await repo.deleteLink("octo/repo#5", "S2")).toBe(false);
    expect(await repo.getPrLink("octo/repo#5")).not.toBeNull();
    expect(await repo.deleteLink("octo/repo#5", "S1")).toBe(true);
    expect(await repo.getPrLink("octo/repo#5")).toBeNull();
    expect(await repo.queryLinks("S1")).toEqual([]);
  });
});

describe("manual links (service)", () => {
  it("links by owner/repo#n or URL and is idempotent for the same session", async () => {
    const { deps } = await setup();
    const a = await linkPullRequest(deps, P, "S1", "octo/repo#8");
    expect(a.created).toBe(true);
    expect(a.link).toMatchObject({ pr: "octo/repo#8", linkedBy: "manual", prState: "unknown" });
    const b = await linkPullRequest(deps, P, "S1", "https://github.com/octo/repo/pull/8");
    expect(b.created).toBe(false);
  });

  it("refuses a PR already linked to another session", async () => {
    const { deps } = await setup();
    await linkPullRequest(deps, P, "S1", "octo/repo#8");
    await expect(linkPullRequest(deps, P, "S2", "octo/repo#8")).rejects.toBeInstanceOf(
      LinkConflictError,
    );
  });

  it("refuses a repo that is not one of the session's repos", async () => {
    const { deps } = await setup();
    await expect(linkPullRequest(deps, P, "S1", "octo/other#8")).rejects.toBeInstanceOf(
      RepoNotAllowedError,
    );
  });

  it("needs the write scope and ownership", async () => {
    const { deps } = await setup();
    await expect(
      linkPullRequest(
        deps,
        { sub: "user-sub-1", scopes: ["sessions:read"] } as Principal,
        "S1",
        "octo/repo#8",
      ),
    ).rejects.toThrow();
    await expect(
      linkPullRequest(deps, { ...P, sub: "someone-else" } as Principal, "S1", "octo/repo#8"),
    ).rejects.toThrow();
  });

  it("unlinks, including after the session was deleted", async () => {
    const { deps, ddb } = await setup();
    await linkPullRequest(deps, P, "S1", "octo/repo#8");
    (ddb.get("SESSION#S1", "META") as { status: string }).status = "deleted";
    await unlinkPullRequest(deps, P, "S1", "octo/repo#8");
    await expect(unlinkPullRequest(deps, P, "S1", "octo/repo#8")).rejects.toThrow(/not linked/);
  });
});

describe("unmatched deliveries", () => {
  it("lists newest first, only for allowed repos", async () => {
    const { repo, deps } = await setup();
    for (const [i, r] of ["octo/repo", "elsewhere/x", "octo/repo"].entries()) {
      await repo.putUnmatched({
        deliveryId: `d${i}`,
        event: "pull_request",
        action: "opened",
        repo: r,
        number: i + 1,
        sender: "kiro-bot",
        receivedAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        url: null,
      });
    }
    const { deliveries } = await listUnmatchedDeliveries(deps, P, { limit: 20 });
    expect(deliveries.map((d) => d.deliveryId)).toEqual(["d2", "d0"]);
    expect((await listUnmatchedDeliveries(deps, P, { limit: 1 })).deliveries).toHaveLength(1);
  });
});

describe("deliveries", () => {
  it("claims a delivery id once (dedupe) and keeps the raw body", async () => {
    const { repo, ddb } = await setup();
    const args = {
      deliveryId: "d-1",
      event: "pull_request",
      action: "closed",
      repo: "octo/repo",
      rawBody: '{"a":1}',
    };
    expect(await repo.putDelivery(args)).toBe(true);
    expect(await repo.putDelivery({ ...args, rawBody: '{"a":2}' })).toBe(false);
    expect((await repo.getDelivery("d-1"))?.rawBody).toBe('{"a":1}');
    const item = ddb.get("GHDLV#d-1", "A") as { ttl: number; receivedAt: string };
    const days = (item.ttl * 1000 - Date.parse(item.receivedAt)) / 86_400_000;
    expect(Math.round(days)).toBe(7);
  });

  it("spills a body over 64 KB to S3 and reads it back", async () => {
    const { repo, ddb, s3 } = await setup();
    const big = JSON.stringify({ pad: "x".repeat(70_000) });
    await repo.putDelivery({
      deliveryId: "d-big",
      event: "pull_request",
      action: null,
      repo: null,
      rawBody: big,
    });
    expect((ddb.get("GHDLV#d-big", "A") as { body: { s3: boolean } }).body.s3).toBe(true);
    expect(s3.objects.size).toBe(1);
    expect((await repo.getDelivery("d-big"))?.rawBody).toBe(big);
  });

  it("can forget a delivery so a redelivery is accepted again", async () => {
    const { repo } = await setup();
    const args = { deliveryId: "d-2", event: "x", action: null, repo: null, rawBody: "{}" };
    await repo.putDelivery(args);
    await repo.deleteDelivery("d-2");
    expect(await repo.putDelivery(args)).toBe(true);
  });
});

describe("redaction of GitHub secrets", () => {
  const PEM =
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----";
  it("redacts installation tokens, other GitHub tokens and PEM keys in strings", () => {
    const out = redact(
      `token ghs_16C7e42F292c6912E7710c838347Ae178B4a and ghp_16C7e42F292c6912E7710c838347Ae178B4a and github_pat_11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz ${PEM}`,
    );
    expect(out).not.toContain("ghs_16C7");
    expect(out).not.toContain("ghp_16C7");
    expect(out).not.toContain("github_pat_11");
    expect(out).not.toContain("MIIEow");
    expect(out).not.toContain("BEGIN RSA PRIVATE KEY");
  });

  it("redacts by key name, and a truncated PEM", () => {
    const out = redact({
      privateKey: PEM,
      webhookSecret: "whsec",
      token: "ghs_x",
      nested: {
        "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
        note: `sha256=${"b".repeat(64)}`,
      },
      cut: "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0B",
    });
    const text = JSON.stringify(out);
    for (const leak of ["MIIEow", "whsec", "ghs_x", "a".repeat(64), "b".repeat(64), "MIIEvQ"]) {
      expect(text, leak).not.toContain(leak);
    }
  });
});
