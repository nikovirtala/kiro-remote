import { describe, expect, it } from "vitest";
import { Report } from "./report.ts";
import { REASON_NO_GITHUB, runSteps } from "./runner.ts";
import { GITHUB_STEPS, githubWakes, STEPS } from "./steps.ts";

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
