/**
 * Ack-on-dispatch + idempotency + shutdown-drain regression tests (FEAT-002),
 * adapted to the chat-only cloud path.
 *
 * The cloud launch runs a long (~30-40s live) `kiro-cli chat --cloud`
 * subprocess as BACKGROUND work: launch() returns PROMPTLY so intake deletes
 * the SQS message on dispatch (not on settlement), which keeps the FIFO group
 * from head-of-line-blocking other sessions. These tests drive the REAL SQS
 * intake receive -> dispatch -> delete loop with a controllable headless runner
 * whose subprocess only resolves when the test releases it, so the
 * ack-on-dispatch and shutdown-drain behavior are actually exercised.
 *
 * The ACP interactive-permission flow does NOT apply to chat --cloud
 * (`--no-interactive` governs tool permissions inside the subprocess), so there
 * is no mid-turn permission parking to test on the cloud path.
 */

import type { Command } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HeadlessResult } from "../src/headless.ts";
import { cloudStreams, createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

function launchCmd(sessionId: string, commandId = "cmd-launch"): Command {
  return {
    kind: "launch",
    sub: "user-sub-1",
    sessionId,
    commandId,
    prompt: "run the tests",
    repos: ["octo/repo"],
  };
}

/**
 * A controllable headless runner: each call parks until the returned `release`
 * is called, then resolves with a successful cloud result. Lets a test assert
 * that the SQS message was acked while the subprocess is still in-flight.
 */
function gatedRunner(): {
  runner: () => Promise<HeadlessResult>;
  release: () => void;
  callCount: () => number;
} {
  let resolveFn: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    resolveFn = r;
  });
  const runner = vi.fn(async () => {
    await gate;
    return {
      code: 0,
      ...cloudStreams({ cloudSessionId: CLOUD_ID, assistant: "done" }),
    };
  });
  return {
    runner,
    release: () => resolveFn?.(),
    callCount: () => runner.mock.calls.length,
  };
}

async function drainQueue(h: Harness, maxPolls = 50): Promise<void> {
  for (let i = 0; i < maxPolls && h.sqs.remaining() > 0; i++) {
    const n = await h.server.intake.pollOnce();
    if (n === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe("ack-on-dispatch (FEAT-002)", () => {
  test("the launch SQS message is acked (deleted) before the subprocess settles", async () => {
    const g = gatedRunner();
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      g.runner,
    );
    await harness.server.start();
    await harness.seedSession("ack");

    harness.sqs.enqueue(launchCmd("ack"), "ack");
    await harness.server.intake.pollOnce();

    // The launch message is gone even though the chat --cloud subprocess is
    // still running (gated). This is the crux: ack-on-dispatch, not on-settle.
    await waitFor(() => requireHarness(harness).sqs.remaining() === 0);
    expect(harness.sqs.remaining()).toBe(0);
    expect(g.callCount()).toBe(1);
    // Still provisioning (the subprocess has not resolved yet).
    expect(harness.server.manager.machineState("ack")?.session).toBe("provisioning");

    // Release the subprocess and let the session settle to idle.
    g.release();
    await harness.server.manager.awaitTurnSettled("ack");
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("ack"))?.status === "idle",
    );
  });
});

describe("FakeSqsClient FIFO head-of-line blocking", () => {
  test("a group with an in-flight (undeleted) message does not deliver later same-group messages", async () => {
    harness = await createHarness({
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    const sqs = harness.sqs;

    sqs.enqueue(launchCmd("A", "a1"), "A");
    sqs.enqueue({ ...launchCmd("A", "a2"), kind: "cancel" } as Command, "A");
    sqs.enqueue(launchCmd("B", "b1"), "B");

    const first = (await (
      sqs as unknown as {
        send: (c: unknown) => Promise<{ Messages: { Attributes: { MessageGroupId: string } }[] }>;
      }
    ).send({
      constructor: { name: "ReceiveMessageCommand" },
      input: { MaxNumberOfMessages: 10 },
    })) as { Messages: { ReceiptHandle: string; Attributes: { MessageGroupId: string } }[] };

    const groups = first.Messages.map((m) => m.Attributes.MessageGroupId).sort();
    expect(groups).toEqual(["A", "B"]);

    const second = (await (
      sqs as unknown as { send: (c: unknown) => Promise<{ Messages: unknown[] }> }
    ).send({
      constructor: { name: "ReceiveMessageCommand" },
      input: { MaxNumberOfMessages: 10 },
    })) as { Messages: unknown[] };
    expect(second.Messages).toEqual([]);

    const aHandle = first.Messages.find((m) => m.Attributes.MessageGroupId === "A")?.ReceiptHandle;
    await (sqs as unknown as { send: (c: unknown) => Promise<unknown> }).send({
      constructor: { name: "DeleteMessageCommand" },
      input: { ReceiptHandle: aHandle },
    });
    const third = (await (
      sqs as unknown as {
        send: (c: unknown) => Promise<{ Messages: { Attributes: { MessageGroupId: string } }[] }>;
      }
    ).send({
      constructor: { name: "ReceiveMessageCommand" },
      input: { MaxNumberOfMessages: 10 },
    })) as { Messages: { Attributes: { MessageGroupId: string } }[] };
    expect(third.Messages.map((m) => m.Attributes.MessageGroupId)).toEqual(["A"]);
  });
});

describe("launch idempotency (FEAT-002)", () => {
  test("a redelivered launch does not spawn a second chat --cloud / second Space", async () => {
    const runner = vi.fn(async () => ({
      code: 0,
      ...cloudStreams({ cloudSessionId: CLOUD_ID, assistant: "hi" }),
    }));
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      runner,
    );
    await harness.server.start();
    await harness.seedSession("idem");

    harness.sqs.enqueue(launchCmd("idem", "cmd-launch-1"), "idem");
    await drainQueue(harness);
    await harness.server.manager.awaitTurnSettled("idem");
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("idem"))?.status === "idle",
    );
    expect(runner).toHaveBeenCalledTimes(1);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);

    // Redeliver the SAME launch.
    harness.sqs.enqueue(launchCmd("idem", "cmd-launch-1"), "idem");
    await drainQueue(harness);
    await harness.server.manager.awaitTurnSettled("idem");

    // Idempotent: no second subprocess, no duplicate Space, no double metric.
    expect(runner).toHaveBeenCalledTimes(1);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);
    expect(harness.logLines.some((l) => l.includes("launch_idempotent_skip"))).toBe(true);
    expect(harness.sqs.remaining()).toBe(0);
  });
});

describe("shutdown awaits in-flight settlement (FEAT-002 hardening)", () => {
  test("shutdown waits for an actively-settling launch to finish persisting", async () => {
    const g = gatedRunner();
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      g.runner,
    );
    // createHarness ignores a shutdownDrainMs via config; set it directly.
    // biome-ignore lint/suspicious/noExplicitAny: set private drain bound.
    (harness.server as any).config.shutdownDrainMs = 2000;
    await harness.server.start();
    await harness.seedSession("drain");

    harness.sqs.enqueue(launchCmd("drain"), "drain");
    await harness.server.intake.pollOnce();
    await waitFor(() => requireHarness(harness).sqs.remaining() === 0);

    // The launch is still settling (subprocess gated): message acked, not idle.
    expect(harness.server.manager.runtime("drain")?.settling).not.toBeNull();
    expect(harness.server.manager.machineState("drain")?.session).toBe("provisioning");

    // Release so settlement can finish during the bounded shutdown drain.
    g.release();
    const h = harness;
    await h.server.shutdown();
    harness = null;

    expect((await h.repo.getSession("drain"))?.status).toBe("idle");
    const events = await h.repo.queryEvents("drain", 0, { limit: 100 });
    expect(events.length).toBeGreaterThan(0);
  });

  test("shutdown does NOT hang when a launch subprocess never resolves", async () => {
    const g = gatedRunner(); // never released
    harness = await createHarness(
      { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
      g.runner,
    );
    await harness.server.start();
    await harness.seedSession("parked");

    harness.sqs.enqueue(launchCmd("parked"), "parked");
    await harness.server.intake.pollOnce();
    await waitFor(() => requireHarness(harness).sqs.remaining() === 0);

    const h = harness;
    expect(h.server.manager.runtime("parked")?.settling).not.toBeNull();
    const started = Date.now();
    await h.server.manager.awaitAllSettled(150);
    const elapsed = Date.now() - started;
    expect(elapsed).toBeLessThan(1000);
    // The parked settlement is STILL unsettled: the drain only bounded the wait.
    expect(h.server.manager.runtime("parked")?.settling).not.toBeNull();

    await h.server.shutdown();
    harness = null;
    g.release();
  });
});

describe("lost permission soft-fail (FEAT-002)", () => {
  test("answerPermission for an unknown requestId is a clean logged no-op", async () => {
    harness = await createHarness({
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("lost", { status: "idle", kiroSessionId: CLOUD_ID });

    const answer: Command = {
      kind: "answerPermission",
      sub: "user-sub-1",
      sessionId: "lost",
      commandId: "cmd-answer-lost",
      requestId: "does-not-exist",
      optionId: "accept",
    };
    harness.sqs.enqueue(answer, "lost");

    await drainQueue(harness);
    expect(harness.sqs.remaining()).toBe(0);

    // The soft-fail was logged at both the gateway and manager layers.
    expect(harness.logLines.some((l) => l.includes("permission_answer_no_pending"))).toBe(true);
    expect(harness.logLines.some((l) => l.includes("permission_answer_soft_fail"))).toBe(true);

    const perm = await harness.repo.getPermission("lost", "does-not-exist");
    expect(perm).toBeNull();
  });
});
