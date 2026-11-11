import { describe, expect, it } from "vitest";
import { Report } from "./report.ts";
import { REASON_NO_GITHUB, runSteps } from "./runner.ts";
import { expectNoWake, GITHUB_STEPS, githubWakes, STEPS } from "./steps.ts";

describe("githubWakes", () => {
  const wake = (seq: number, turnId: string, source: string, deliveryIds: unknown) => ({
    seq,
    turnId,
    type: "session.info",
    ts: "2026-02-01T10:00:00.000Z",
    payload: { payload: { trigger: { source, deliveryIds } } },
  });

  it("finds turns whose trigger source is github, with their delivery ids", () => {
    expect(
      githubWakes([
        wake(1, "t-user", "user", []),
        wake(2, "t-gh", "github", ["d1", "d2"]),
        { seq: 3, turnId: "t-x", type: "message.chunk", payload: {} },
        wake(4, "t-gh2", "github", "nope"),
      ]),
    ).toEqual([
      { seq: 2, turnId: "t-gh", deliveryIds: ["d1", "d2"], ts: "2026-02-01T10:00:00.000Z" },
      { seq: 4, turnId: "t-gh2", deliveryIds: [], ts: "2026-02-01T10:00:00.000Z" },
    ]);
  });
});

describe("expectNoWake", () => {
  const ghWake = {
    seq: 9,
    turnId: "t-self",
    type: "session.info",
    ts: "2026-02-01T10:00:00.000Z",
    payload: { payload: { trigger: { source: "github", deliveryIds: ["d-comment"] } } },
  };
  function ctxWith(pages: unknown[][]) {
    let clock = 0;
    let calls = 0;
    const ctx = {
      deps: {
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
      },
      state: {
        created: new Set<string>(),
        rest: {
          getEvents: async () => ({ events: pages[Math.min(calls++, pages.length - 1)] }),
        },
      },
    };
    return { ctx: ctx as never, calls: () => calls };
  }

  it("passes when no GitHub wake starts within the quiet period, polling until it ends", async () => {
    const { ctx, calls } = ctxWith([[{ seq: 5, turnId: "t1", type: "message.chunk" }]]);
    await expect(expectNoWake(ctx, { id: "S", cursor: 4 }, 20_000, "x")).resolves.toBeUndefined();
    expect(calls()).toBe(5); // t = 0, 5, 10, 15, 20 s
  });

  it("fails on a GitHub wake the harness did not cause, naming the turn and delivery", async () => {
    const { ctx } = ctxWith([[], [ghWake]]);
    await expect(
      expectNoWake(ctx, { id: "S", cursor: 4 }, 45_000, "the review wake turn settled"),
    ).rejects.toThrow(
      /unexpected GitHub wake turn t-self \(deliveries: d-comment\) within 45 s after the review wake turn settled/,
    );
  });
});

describe("gh-chain-first-pr", () => {
  const step = GITHUB_STEPS.find((s) => s.id === "gh-chain-first-pr");
  const pull = (number: number, created: string) => ({
    number,
    state: "open",
    created_at: created,
    merged_at: null,
    head: { ref: `branch-${number}`, sha: "a".repeat(40) },
    base: { ref: "main" },
  });
  function ctxWith(pulls: unknown[]) {
    const launchedAt = Date.parse("2026-02-01T10:00:00Z");
    const ghCalls: string[][] = [];
    const ctx = {
      deps: {
        now: () => launchedAt,
        sleep: async () => {},
        gh: async (args: string[]) => {
          ghCalls.push(args);
          return JSON.stringify(pulls);
        },
      },
      state: {
        created: new Set<string>(),
        ghChain: { session: { id: "S", cursor: 3 }, launchedAt, prs: [] as unknown[] },
        rest: {
          getSession: async () => ({
            links: [{ pr: "o/r#5", repo: "o/r", linkedBy: "harvest", prState: "open" }],
          }),
        },
      },
    };
    return { ctx, ghCalls };
  }

  it("passes when only the linked PR was opened since launch, and records it", async () => {
    const { ctx } = ctxWith([
      pull(5, "2026-02-01T10:00:30Z"),
      pull(4, "2026-02-01T09:00:00Z"), // an older run's PR
    ]);
    await expect(step?.run(ctx as never)).resolves.toEqual({ firstPr: 5, linkedBy: "harvest" });
    expect(ctx.state.ghChain.prs).toEqual([{ repo: "o/r", number: 5, headRef: "branch-5" }]);
  });

  it("fails when the agent opened the second PR before the first was merged", async () => {
    const { ctx } = ctxWith([pull(6, "2026-02-01T10:01:00Z"), pull(5, "2026-02-01T10:00:30Z")]);
    await expect(step?.run(ctx as never)).rejects.toThrow(
      /expected only the linked PR #5 to exist after the first turn, found: #6, #5/,
    );
  });
});

describe("gh-checks-wake", () => {
  const step = GITHUB_STEPS.find((s) => s.id === "gh-checks-wake");
  const suites = (...conclusions: Array<string | null>) =>
    JSON.stringify({
      check_suites: conclusions.map((c) => ({
        status: c === null ? "in_progress" : "completed",
        conclusion: c,
      })),
    });
  function ctxWith(ghResponses: string[]) {
    let clock = 0;
    const ctx = {
      deps: {
        now: () => clock,
        sleep: async (ms: number) => {
          clock += ms;
        },
        gh: async () => ghResponses.shift() ?? ghResponses[ghResponses.length - 1] ?? "{}",
      },
      state: {
        created: new Set<string>(),
        ghChecks: { session: { id: "S", cursor: 0 } },
        rest: {
          getSession: async () => ({
            links: [{ pr: "o/r#8", repo: "o/r", linkedBy: "harvest", prState: "open" }],
          }),
          getEvents: async () => ({ events: [] }),
        },
      },
    };
    return ctx as never;
  }
  const PULL = JSON.stringify({
    number: 8,
    state: "open",
    created_at: "2026-02-01T10:00:00Z",
    merged_at: null,
    head: { ref: "b", sha: "c".repeat(40) },
    base: { ref: "main" },
  });

  it("fails loudly when the PR's checks complete without failing", async () => {
    // The repo's workflow did not fail the marker PR: a wake would prove nothing.
    await expect(step?.run(ctxWith([PULL, suites("success")]))).rejects.toThrow(
      /checks completed without failing \(success\); the repo's "e2e check" workflow must fail a PR carrying the marker/,
    );
  });

  it("waits for a completed suite before looking for the wake", async () => {
    // Checks still running, then a failure: the step gets past the check gate
    // and then times out waiting for the wake turn (no events in this fake).
    await expect(step?.run(ctxWith([PULL, suites(null), suites("failure")]))).rejects.toThrow(
      /the GitHub wake turn did not happen within \d+ s/,
    );
  });
});

describe("the GitHub scenario is opt-in", () => {
  it("is separate from the default steps and every step requires the github flag", () => {
    expect(STEPS.some((s) => GITHUB_STEPS.includes(s))).toBe(false);
    expect(GITHUB_STEPS.map((s) => s.id)).toEqual([
      "gh-launch",
      "gh-link",
      "gh-review-wake",
      "gh-merge-wake",
      "gh-cleanup",
      "gh-chain-launch",
      "gh-chain-first-pr",
      "gh-chain-merge-first",
      "gh-chain-merge-second",
      "gh-chain-cleanup",
      "gh-checks-launch",
      "gh-checks-wake",
      "gh-close-wake",
      "gh-checks-cleanup",
    ]);
    expect(GITHUB_STEPS.every((s) => s.requires.includes("github"))).toBe(true);
  });

  it("is skipped with a reason when KIRO_API_E2E_GITHUB is not set", async () => {
    const report = new Report(
      { kiroRemoteUrl: "https://x", e2eRepoPresent: true },
      { literalSecrets: [] },
    );
    await runSteps(GITHUB_STEPS, {} as never, report, {
      hasBaseUrl: true,
      hasRepo: true,
      now: () => 0,
      progress: () => {},
    });
    const out = report.build();
    expect(out.steps.map((s) => s.status)).toEqual(GITHUB_STEPS.map(() => "skipped"));
    expect(out.steps[0].reason).toBe(REASON_NO_GITHUB);
  });
});
