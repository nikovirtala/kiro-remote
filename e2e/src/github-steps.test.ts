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

describe("the GitHub scenario is opt-in", () => {
  it("is separate from the default steps and every step requires the github flag", () => {
    expect(STEPS.some((s) => GITHUB_STEPS.includes(s))).toBe(false);
    expect(GITHUB_STEPS.map((s) => s.id)).toEqual([
      "gh-launch",
      "gh-link",
      "gh-review-wake",
      "gh-merge-wake",
      "gh-cleanup",
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
    expect(out.steps.map((s) => s.status)).toEqual([
      "skipped",
      "skipped",
      "skipped",
      "skipped",
      "skipped",
    ]);
    expect(out.steps[0].reason).toBe(REASON_NO_GITHUB);
  });
});
