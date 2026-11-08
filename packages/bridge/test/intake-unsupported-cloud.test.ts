/**
 * Intake-level redelivery behavior for cloud-unsupported operations (FEAT-002,
 * review v2 issue 1 + 2).
 *
 * A mid-turn `steer`/`cancel` (and a `whenBusy=queue` follow-up with no drain)
 * cannot be honored on a cloud session: the turn runs in a detached
 * `chat --cloud` subprocess that ACP cannot drive. SessionManager throws an
 * {@link UnsupportedCloudOperationError} for these. The command queue is a
 * DLQ-less FIFO keyed by `MessageGroupId = sessionId`, so if intake left such a
 * thrown message UNDELETED (its policy for a transient failure) it would
 * head-of-line-block the session's ENTIRE command stream and redeliver every
 * visibility timeout forever while the turn runs.
 *
 * These tests drive the REAL intake receive -> dispatch -> delete loop through
 * the FIFO-modeling FakeSqsClient (which enforces per-group head-of-line
 * blocking) with a gated headless runner that keeps a follow-up turn RUNNING,
 * and assert that an unsupported operation is:
 *  - DELETED from the queue (no redelivery loop),
 *  - does NOT head-of-line-block a later command in the same session,
 *  - logged loudly (`command_unsupported_cloud`),
 *  - surfaced to a polling client as a persisted `turn.failed` rejection event;
 * while a genuine TRANSIENT dispatch failure is still LEFT for redelivery.
 */

import type { Command } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { HeadlessResult } from "../src/headless.ts";
import { cloudStdout, createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

const CLOUD_ID = "08047063-f7b4-4ce5-b79a-2aea9a7a1d29";

/**
 * A runner whose FIRST call (launch) resolves immediately and whose SECOND call
 * (the follow-up resume) PARKS on a gate, so the follow-up turn stays running
 * while the test issues a mid-turn steer/cancel/queue.
 */
function launchThenGatedResume(): {
  runner: () => Promise<HeadlessResult>;
  release: () => void;
  callCount: () => number;
} {
  let resolveFn: (() => void) | null = null;
  const gate = new Promise<void>((r) => {
    resolveFn = r;
  });
  let call = 0;
  const runner = vi.fn(async () => {
    call += 1;
    if (call === 1) {
      return {
        code: 0,
        stdout: cloudStdout({ cloudSessionId: CLOUD_ID, assistant: "ok" }),
        stderr: "",
      };
    }
    await gate;
    return {
      code: 0,
      stdout: cloudStdout({ cloudSessionId: CLOUD_ID, assistant: "late" }),
      stderr: "",
    };
  });
  return { runner, release: () => resolveFn?.(), callCount: () => runner.mock.calls.length };
}

async function drainQueue(h: Harness, maxPolls = 50): Promise<void> {
  for (let i = 0; i < maxPolls && h.sqs.remaining() > 0; i++) {
    const n = await h.server.intake.pollOnce();
    if (n === 0) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

/**
 * Read the rejected operation out of a persisted rejection event. The repo
 * stores the whole normalized event as the item `payload`, so the rejection
 * detail lives at `payload.payload.operation`.
 */
function rejectionOperation(event: { payload?: unknown } | undefined): string | undefined {
  const inner = (event?.payload as { payload?: { operation?: string } } | undefined)?.payload;
  return inner?.operation;
}

function launchCmd(sessionId: string): Command {
  return {
    kind: "launch",
    sub: "user-sub-1",
    sessionId,
    commandId: "cmd-launch",
    prompt: "first",
    repos: ["octo/repo"],
  };
}

/** Bring a cloud session to idle, then start a follow-up turn that parks RUNNING. */
async function runningTurn(sessionId: string): Promise<{ release: () => void }> {
  const g = launchThenGatedResume();
  harness = await createHarness(
    { initialize: initResult(), onPrompt: { response: { stopReason: "end_turn" } } },
    g.runner,
  );
  await harness.server.start();
  await harness.seedSession(sessionId);

  await harness.server.intake.dispatch(launchCmd(sessionId));
  await waitFor(
    async () => (await requireHarness(harness).repo.getSession(sessionId))?.status === "idle",
  );

  // Start a follow-up turn via prompt() so it parks on the gate -> RUNNING.
  await requireHarness(harness).server.manager.prompt(sessionId, "mid", "t-mid");
  expect(requireHarness(harness).server.manager.machineState(sessionId)?.turn).toBe("running");

  return { release: g.release };
}

describe("intake: cloud-unsupported operation is deleted, not redelivered (FEAT-002 v2)", () => {
  test("a mid-turn cancel is deleted (no loop) and does not head-of-line-block a later same-session command", async () => {
    const { release } = await runningTurn("c1");
    const h = requireHarness(harness);

    // Enqueue a mid-turn cancel FOLLOWED BY a redelivered launch in the SAME
    // FIFO group. The launch proves the stream kept moving: it is only ever
    // delivered once the cancel ahead of it is deleted (FIFO head-of-line).
    const cancel: Command = {
      kind: "cancel",
      sub: "user-sub-1",
      sessionId: "c1",
      commandId: "cmd-cancel",
    };
    h.sqs.enqueue(cancel, "c1");
    h.sqs.enqueue({ ...launchCmd("c1"), commandId: "cmd-launch-redeliver" }, "c1");

    await drainQueue(h);

    // Both messages were deleted: the cancel did NOT loop and did NOT block the
    // launch behind it.
    expect(h.sqs.remaining()).toBe(0);
    // No command_dispatch_error (which would mean "left for redelivery").
    expect(h.logLines.some((l) => l.includes("command_dispatch_error"))).toBe(false);
    // Loud to the operator...
    expect(h.logLines.some((l) => l.includes("command_unsupported_cloud"))).toBe(true);
    // ...and loud to a polling client: a turn.failed rejection event is present.
    const events = await h.repo.queryEvents("c1", 0, { limit: 100 });
    const rejection = events.find(
      (e) => e.type === "turn.failed" && e.rawType === "operation_rejected",
    );
    expect(rejection).toBeDefined();
    expect(rejectionOperation(rejection)).toBe("cancel");

    // The turn is still running -- the swallowed cancel did not fake a state
    // change -- and the follow-up (redelivered) launch was an idempotent skip.
    expect(h.server.manager.machineState("c1")?.turn).toBe("running");
    expect(h.logLines.some((l) => l.includes("launch_idempotent_skip"))).toBe(true);

    release();
    await h.server.manager.awaitTurnSettled("c1");
  });

  test("a mid-turn steer is deleted and persists a steer rejection event", async () => {
    const { release } = await runningTurn("s1");
    const h = requireHarness(harness);

    const steer: Command = {
      kind: "steer",
      sub: "user-sub-1",
      sessionId: "s1",
      commandId: "cmd-steer",
      content: "interrupt",
    };
    h.sqs.enqueue(steer, "s1");

    await drainQueue(h);

    expect(h.sqs.remaining()).toBe(0);
    expect(h.logLines.some((l) => l.includes("command_dispatch_error"))).toBe(false);
    expect(h.logLines.some((l) => l.includes("command_unsupported_cloud"))).toBe(true);
    const events = await h.repo.queryEvents("s1", 0, { limit: 100 });
    const rejection = events.find(
      (e) => e.type === "turn.failed" && e.rawType === "operation_rejected",
    );
    expect(rejectionOperation(rejection)).toBe("steer");

    release();
    await h.server.manager.awaitTurnSettled("s1");
  });

  test("a whenBusy=queue follow-up is deleted (not left queued-but-never-drained) and rejected visibly", async () => {
    const { release } = await runningTurn("q1");
    const h = requireHarness(harness);

    const queued: Command = {
      kind: "prompt",
      sub: "user-sub-1",
      sessionId: "q1",
      commandId: "cmd-queue",
      turnId: "t-queue",
      prompt: "queued follow-up",
      whenBusy: "queue",
    };
    h.sqs.enqueue(queued, "q1");

    await drainQueue(h);

    // Deleted, not looping; the machine was NOT left in a phantom "queued" turn.
    expect(h.sqs.remaining()).toBe(0);
    expect(h.logLines.some((l) => l.includes("command_dispatch_error"))).toBe(false);
    expect(h.logLines.some((l) => l.includes("steer_queue_unsupported_cloud"))).toBe(true);
    const events = await h.repo.queryEvents("q1", 0, { limit: 100 });
    const rejection = events.find(
      (e) => e.type === "turn.failed" && e.rawType === "operation_rejected",
    );
    expect(rejectionOperation(rejection)).toBe("queue");

    release();
    await h.server.manager.awaitTurnSettled("q1");
  });

  test("a genuine TRANSIENT dispatch failure is still LEFT for redelivery (not deleted)", async () => {
    // The default runner resolves fine, so force a transient failure by making
    // the FIRST launch subprocess throw. launch() settles in the background so a
    // launch dispatch cannot itself throw; instead drive a command whose
    // handler throws synchronously on the dispatch path: setConfig with an
    // un-advertised model rejects with a plain Error (NOT the sentinel).
    harness = await createHarness({
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    const h = harness;
    await h.server.start();
    await h.seedSession("t1", { status: "idle", kiroSessionId: CLOUD_ID });

    const badConfig: Command = {
      kind: "setConfig",
      sub: "user-sub-1",
      sessionId: "t1",
      commandId: "cmd-config",
      model: "model-that-is-not-advertised",
    };
    h.sqs.enqueue(badConfig, "t1");

    // One poll: the dispatch throws a plain Error -> the message is LEFT.
    await h.server.intake.pollOnce();

    expect(h.sqs.remaining()).toBe(1);
    expect(h.logLines.some((l) => l.includes("command_dispatch_error"))).toBe(true);
    // No unsupported-cloud handling for a transient failure.
    expect(h.logLines.some((l) => l.includes("command_unsupported_cloud"))).toBe(false);
  });
});
