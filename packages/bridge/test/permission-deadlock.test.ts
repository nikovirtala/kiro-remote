/**
 * Regression tests for the interactive-permission DEADLOCK (FEAT-002).
 *
 * These tests drive the REAL SQS intake receive -> dispatch -> delete loop
 * (FakeSqsClient.enqueue + intake.pollOnce), NOT direct intake.dispatch(), so
 * the message lifecycle and FIFO head-of-line blocking are actually exercised.
 *
 * The bug: intake deleted a launch/prompt command's SQS message only AFTER
 * dispatch() resolved, and dispatch awaited gateway.prompt() which resolves
 * only on the session/prompt response. When the agent parks the turn awaiting a
 * tool permission, that response is held open, so the launch message stays
 * in-flight. Because the FIFO MessageGroupId = sessionId, the answerPermission
 * command (same group) is head-of-line blocked and never delivered -- the only
 * thing that could release the parked turn. Circular deadlock.
 *
 * The fix acks (deletes) the launch/prompt message once the turn has been
 * DISPATCHED (session/prompt sent), running settlement as a background task. The
 * FIFO group then unblocks so the same-group answerPermission is delivered and
 * applied while the turn is parked.
 */

import type { Command } from "@nikovirtala/kiro-remote-core";
import { afterEach, describe, expect, test } from "vitest";
import { createHarness, type Harness, requireHarness, waitFor } from "./harness.ts";
import { initResult, SHELL_PERMISSION_PARAMS } from "./scenarios.ts";

let harness: Harness | null = null;

afterEach(async () => {
  if (harness) {
    await harness.stop();
    harness = null;
  }
});

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
 * Pump the intake receive->dispatch->delete loop until the queue is drained
 * (bounded). Each pollOnce receives at most one message per FIFO group and
 * deletes it on successful dispatch; a parked turn no longer blocks the ack.
 */
async function drainQueue(h: Harness, maxPolls = 50): Promise<void> {
  for (let i = 0; i < maxPolls && h.sqs.remaining() > 0; i++) {
    const n = await h.server.intake.pollOnce();
    if (n === 0) {
      // Head-of-line blocked on an in-flight group with nothing yet to do;
      // yield so background settlement / async hooks can progress.
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}

describe("interactive permission deadlock (FEAT-002)", () => {
  test("a same-group answerPermission is delivered and applied while the turn is parked", async () => {
    harness = await createHarness({
      newSessionId: "cloud-dl",
      initialize: initResult(),
      // The agent holds the session/prompt response open until a permission
      // reply arrives (exactly the live parked-turn behavior).
      waitForPermissionReply: true,
      onPrompt: {
        messages: [
          {
            kind: "request",
            method: "session/request_permission",
            params: SHELL_PERMISSION_PARAMS,
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("dl");

    // Enqueue the launch into the FIFO group = sessionId.
    harness.sqs.enqueue(launchCmd("dl"), "dl");

    // One poll delivers + dispatches + ACKS (deletes) the launch. Before the
    // fix the message would NOT be deleted here (dispatch would hang on the
    // parked prompt), so the queue would never drain and the group would stay
    // head-of-line blocked. After the fix the launch is acked on dispatch.
    await harness.server.intake.pollOnce();
    await waitFor(() => requireHarness(harness).sqs.remaining() === 0);

    // The turn is parked on the permission: it was stored verbatim and the
    // session is awaiting_permission.
    await waitFor(
      async () => (await requireHarness(harness).repo.getPermission("dl", "perm-1")) !== null,
    );
    const pending = await harness.repo.getPermission("dl", "perm-1");
    expect(pending?.status).toBe("pending");
    expect(pending?.options).toEqual(SHELL_PERMISSION_PARAMS.options);
    expect(harness.server.manager.machineState("dl")?.session).toBe("awaiting_permission");
    expect(harness.server.gateway.pendingPermissions.has("perm-1")).toBe(true);

    // Now enqueue the answerPermission into the SAME FIFO group. Because the
    // launch message was acked, the group is unblocked and this is deliverable.
    const answer: Command = {
      kind: "answerPermission",
      sub: "user-sub-1",
      sessionId: "dl",
      commandId: "cmd-answer",
      requestId: "perm-1",
      optionId: "accept",
    };
    harness.sqs.enqueue(answer, "dl");

    // Pump the loop: the answerPermission is delivered + applied, which resolves
    // the held-open request, so the parked turn settles in the background.
    await drainQueue(harness);
    await harness.server.manager.awaitTurnSettled("dl");

    // The answer was applied: PERM row -> answered with the exact optionId.
    const answered = await harness.repo.getPermission("dl", "perm-1");
    expect(answered?.status).toBe("answered");
    expect(answered?.answer).toEqual({ optionId: "accept" });
    expect(harness.server.gateway.pendingPermissions.has("perm-1")).toBe(false);

    // The turn settled (prompt.response) and the session returned to idle.
    expect(harness.server.manager.machineState("dl")?.turn).toBe("completed");
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("dl"))?.status === "idle",
    );
    const session = await harness.repo.getSession("dl");
    expect(session?.status).toBe("idle");

    // Events were written to the DynamoDB log.
    const events = await harness.repo.queryEvents("dl", 0, { limit: 100 });
    expect(events.length).toBeGreaterThan(0);

    // The queue fully drained (nothing left head-of-line blocked).
    expect(harness.sqs.remaining()).toBe(0);
  });

  test("the launch SQS message is acked (deleted) before the turn settles", async () => {
    harness = await createHarness({
      newSessionId: "cloud-ack",
      initialize: initResult(),
      waitForPermissionReply: true,
      onPrompt: {
        messages: [
          {
            kind: "request",
            method: "session/request_permission",
            params: SHELL_PERMISSION_PARAMS,
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("ack");

    harness.sqs.enqueue(launchCmd("ack"), "ack");
    await harness.server.intake.pollOnce();

    // The launch message is gone even though the turn is still parked (not
    // settled). This is the crux of the fix: ack-on-dispatch, not ack-on-settle.
    await waitFor(() => requireHarness(harness).sqs.remaining() === 0);
    await waitFor(() => requireHarness(harness).server.gateway.pendingPermissions.has("perm-1"));
    expect(harness.sqs.remaining()).toBe(0);
    // The turn has NOT settled yet (still awaiting the permission answer).
    expect(harness.server.manager.machineState("ack")?.session).toBe("awaiting_permission");
  });
});

describe("FakeSqsClient FIFO head-of-line blocking", () => {
  test("a group with an in-flight (undeleted) message does not deliver later same-group messages", async () => {
    harness = await createHarness({
      newSessionId: "cloud-fifo",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    const sqs = harness.sqs;

    // Two messages in group A, one in group B.
    sqs.enqueue(launchCmd("A", "a1"), "A");
    sqs.enqueue({ ...launchCmd("A", "a2"), kind: "cancel" } as Command, "A");
    sqs.enqueue(launchCmd("B", "b1"), "B");

    // Receive a batch directly from the fake (bypassing dispatch). FIFO: one
    // message per group, so we get A's first message and B's -- NOT A's second.
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

    // A second receive delivers NOTHING new: group A's head is still in-flight
    // (undeleted) and group B's is too.
    const second = (await (
      sqs as unknown as { send: (c: unknown) => Promise<{ Messages: unknown[] }> }
    ).send({
      constructor: { name: "ReceiveMessageCommand" },
      input: { MaxNumberOfMessages: 10 },
    })) as { Messages: unknown[] };
    expect(second.Messages).toEqual([]);

    // Delete group A's in-flight message -> A's second message becomes eligible.
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
  test("a redelivered launch does not issue a second session/new or a second turn", async () => {
    harness = await createHarness({
      newSessionId: "cloud-idem",
      initialize: initResult(),
      onPrompt: {
        messages: [
          {
            kind: "notify",
            method: "session/update",
            params: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "hi" },
            },
          },
        ],
        response: { stopReason: "end_turn" },
      },
    });
    await harness.server.start();
    await harness.seedSession("idem");

    // First launch: dispatch it and let the turn settle.
    harness.sqs.enqueue(launchCmd("idem", "cmd-launch-1"), "idem");
    await drainQueue(harness);
    await harness.server.manager.awaitTurnSettled("idem");
    await waitFor(
      async () => (await requireHarness(harness).repo.getSession("idem"))?.status === "idle",
    );

    // Count how many session/new the fake agent received (it echoes each one to
    // stderr as fakeAgentNewSessionParams, surfaced as acp_stderr log lines).
    const newSessionCount = (): number =>
      requireHarness(harness).logLines.filter((l) => l.includes("fakeAgentNewSessionParams"))
        .length;
    expect(newSessionCount()).toBe(1);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);

    // Redeliver the SAME launch (at-least-once / visibility-timeout redelivery).
    harness.sqs.enqueue(launchCmd("idem", "cmd-launch-1"), "idem");
    await drainQueue(harness);
    await harness.server.manager.awaitTurnSettled("idem");

    // Idempotent: no second session/new, no duplicate cloud session, and the
    // SessionsLaunched metric did not double. A single kiroToLocal mapping.
    expect(newSessionCount()).toBe(1);
    expect(harness.metrics.sum("SessionsLaunched")).toBe(1);
    const skipped = harness.logLines.some((l) => l.includes("launch_idempotent_skip"));
    expect(skipped).toBe(true);
    // The redelivered launch was still acked (deleted), so the queue drained.
    expect(harness.sqs.remaining()).toBe(0);
  });
});

describe("shutdown awaits in-flight settlement (FEAT-002 hardening)", () => {
  test("shutdown waits for an actively-settling turn to finish persisting", async () => {
    harness = await createHarness({
      newSessionId: "cloud-drain",
      initialize: initResult(),
      onPrompt: {
        messages: [
          {
            kind: "notify",
            method: "session/update",
            params: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "working" },
            },
          },
        ],
        // The prompt response resolves after a short delay, so at the moment we
        // call shutdown() the turn is still settling in the background. Because
        // the SQS message was already deleted on dispatch, a bounded drain is
        // the only thing that lets this turn finish persisting.
        promptDelayMs: 80,
        response: { stopReason: "end_turn" },
      },
      // Comfortably longer than promptDelayMs so the drain does not cut it off.
      shutdownDrainMs: 2000,
    });
    await harness.server.start();
    await harness.seedSession("drain");

    // Dispatch the launch through the real intake loop so it acks on dispatch.
    harness.sqs.enqueue(launchCmd("drain"), "drain");
    await harness.server.intake.pollOnce();
    await waitFor(() => requireHarness(harness).sqs.remaining() === 0);

    // The turn is still in-flight (settling): the message was acked but the
    // prompt response has not resolved yet.
    expect(harness.server.manager.runtime("drain")?.settling).not.toBeNull();
    expect(harness.server.manager.machineState("drain")?.turn).toBe("running");

    // shutdown() must await the in-flight settlement (bounded), not drop it.
    const h = harness;
    await h.server.shutdown();
    harness = null; // shutdown already ran; skip afterEach double-stop.

    // The turn actually settled rather than being dropped: machine completed,
    // session idle, events persisted.
    expect(h.server.manager.machineState("drain")?.turn).toBe("completed");
    expect((await h.repo.getSession("drain"))?.status).toBe("idle");
    const events = await h.repo.queryEvents("drain", 0, { limit: 100 });
    expect(events.length).toBeGreaterThan(0);
  });

  test("shutdown does NOT hang when a turn is parked on an unanswered permission", async () => {
    harness = await createHarness({
      newSessionId: "cloud-parked",
      initialize: initResult(),
      // The agent holds the prompt response open until a permission reply that
      // never arrives, so the turn stays parked forever -- the bounded-timeout
      // path must return rather than wait indefinitely.
      waitForPermissionReply: true,
      onPrompt: {
        messages: [
          {
            kind: "request",
            method: "session/request_permission",
            params: SHELL_PERMISSION_PARAMS,
          },
        ],
        response: { stopReason: "end_turn" },
      },
      // A short drain bound keeps the test fast; the parked turn outlives it.
      shutdownDrainMs: 150,
    });
    await harness.server.start();
    await harness.seedSession("parked");

    harness.sqs.enqueue(launchCmd("parked"), "parked");
    await harness.server.intake.pollOnce();
    await waitFor(() => requireHarness(harness).sqs.remaining() === 0);
    await waitFor(() => requireHarness(harness).server.gateway.pendingPermissions.has("perm-1"));

    // The turn is parked (never answered) so its settling promise will not
    // resolve. The bounded drain must return on its timeout rather than wait
    // indefinitely -- measure the drain directly (isolated from the fixed child
    // transport-stop overhead that the full shutdown also incurs).
    const h = harness;
    expect(h.server.manager.runtime("parked")?.settling).not.toBeNull();
    const started = Date.now();
    await h.server.manager.awaitAllSettled(150);
    const elapsed = Date.now() - started;
    // Returned bounded (~150ms + slack), proving it capped the wait on the
    // unsettleable parked turn rather than hanging.
    expect(elapsed).toBeLessThan(1000);
    // The parked turn is STILL unsettled: the drain did not fabricate a
    // settlement, it only bounded the wait.
    expect(h.server.manager.runtime("parked")?.settling).not.toBeNull();

    // And the full shutdown also completes without hanging.
    await h.server.shutdown();
    harness = null; // shutdown already ran; skip afterEach double-stop.
  });
});

describe("lost permission soft-fail (FEAT-002)", () => {
  test("answerPermission for an unknown requestId is a clean logged no-op", async () => {
    harness = await createHarness({
      newSessionId: "cloud-lost",
      initialize: initResult(),
      onPrompt: { response: { stopReason: "end_turn" } },
    });
    await harness.server.start();
    await harness.seedSession("lost", { status: "idle", kiroSessionId: "cloud-lost" });

    const answer: Command = {
      kind: "answerPermission",
      sub: "user-sub-1",
      sessionId: "lost",
      commandId: "cmd-answer-lost",
      requestId: "does-not-exist",
      optionId: "accept",
    };
    harness.sqs.enqueue(answer, "lost");

    // The dispatch must NOT hang or throw: the message is acked and the queue
    // drains cleanly even though there is no pending in-memory permission.
    await drainQueue(harness);
    expect(harness.sqs.remaining()).toBe(0);

    // The soft-fail was logged at both the gateway and manager layers.
    expect(harness.logLines.some((l) => l.includes("permission_answer_no_pending"))).toBe(true);
    expect(harness.logLines.some((l) => l.includes("permission_answer_soft_fail"))).toBe(true);

    // No PERM row was fabricated for the unknown requestId.
    const perm = await harness.repo.getPermission("lost", "does-not-exist");
    expect(perm).toBeNull();
  });
});
