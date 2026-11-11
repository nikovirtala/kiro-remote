import { describe, expect, it } from "vitest";
import { handleWebhook, type IngressDeps } from "../src/ingress.ts";
import { CollectingMetrics } from "../src/log.ts";
import { signBody } from "../src/signature.ts";
import { collectingLogger, RecordingGithubQueue, world } from "./helpers.ts";

const SECRET = "whsec_test";

function setup(allowed = ["octo/*"]) {
  const w = world();
  const queue = new RecordingGithubQueue();
  const metrics = new CollectingMetrics();
  const log = collectingLogger();
  const deps: IngressDeps = {
    webhookSecret: async () => SECRET,
    repo: w.repo,
    queue,
    allowedRepos: allowed,
    metrics,
    logger: log.logger,
  };
  const send = (
    body: object | string,
    headers: Record<string, string | undefined> = {},
    secret = SECRET,
  ) => {
    const raw = Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    return handleWebhook(deps, {
      body: raw,
      headers: {
        "x-hub-signature-256": signBody(secret, raw),
        "x-github-event": "pull_request",
        "x-github-delivery": "11111111-2222-3333-4444-555555555555",
        ...headers,
      },
    });
  };
  return { w, queue, metrics, log, send, deps };
}

const PAYLOAD = {
  action: "opened",
  repository: { full_name: "octo/repo" },
  secretish: "do-not-echo",
};

describe("webhook ingress", () => {
  it("accepts a valid delivery: stores it, enqueues its id, returns 202", async () => {
    const { w, queue, metrics, send } = setup();
    const res = await send(PAYLOAD);
    expect(res).toEqual({ status: 202, body: "" });
    expect(queue.sent).toEqual([
      { message: { kind: "delivery", deliveryId: "11111111-2222-3333-4444-555555555555" } },
    ]);
    const stored = await w.repo.getDelivery("11111111-2222-3333-4444-555555555555");
    expect(stored).toMatchObject({
      event: "pull_request",
      action: "opened",
      repo: "octo/repo",
      status: "received",
    });
    expect(JSON.parse(stored?.rawBody ?? "")).toEqual(PAYLOAD);
    expect(metrics.sum("WebhooksReceived")).toBe(1);
  });

  it("rejects a bad signature with 401, no body, and parses nothing", async () => {
    const { w, queue, metrics, send, log } = setup();
    for (const headers of [
      { "x-hub-signature-256": undefined },
      { "x-hub-signature-256": "sha256=deadbeef" },
      { "x-hub-signature-256": signBody("wrong", JSON.stringify(PAYLOAD)) },
    ]) {
      const res = await send(PAYLOAD, headers);
      expect(res).toEqual({ status: 401, body: "" });
    }
    expect(queue.sent).toEqual([]);
    expect(w.ddb.items()).toEqual([]);
    expect(metrics.sum("WebhooksRejectedSignature")).toBe(3);
    expect(metrics.sum("WebhooksReceived")).toBe(0);
    expect(log.lines.join("\n")).not.toContain("do-not-echo");
  });

  it("verifies BEFORE parsing: an unparseable body with a bad signature is 401, not 400", async () => {
    const { send } = setup();
    expect((await send("{not json", { "x-hub-signature-256": "sha256=00" })).status).toBe(401);
  });

  it("treats a duplicate delivery id as a no-op 202", async () => {
    const { queue, metrics, send } = setup();
    await send(PAYLOAD);
    const again = await send(PAYLOAD);
    expect(again).toEqual({ status: 202, body: "" });
    expect(queue.sent).toHaveLength(1);
    expect(metrics.sum("WebhooksDuplicate")).toBe(1);
  });

  it("a redelivery reuses the id and is deduped too", async () => {
    const { queue, send } = setup();
    await send(PAYLOAD);
    await send(PAYLOAD, { "x-github-delivery": "11111111-2222-3333-4444-555555555555" });
    expect(queue.sent).toHaveLength(1);
  });

  it("drops events from repos outside ALLOWED_REPOS after verifying, and counts them", async () => {
    const { w, queue, metrics, send } = setup(["acme/*"]);
    const res = await send(PAYLOAD);
    expect(res.status).toBe(202);
    expect(queue.sent).toEqual([]);
    expect(w.ddb.items()).toEqual([]);
    expect(metrics.sum("WebhooksDropped", { reason: "repo_not_allowed" })).toBe(1);
  });

  it("a forged event for a disallowed repo with a bad signature is still 401 (verification comes first)", async () => {
    const { send } = setup(["acme/*"]);
    expect((await send(PAYLOAD, { "x-hub-signature-256": "sha256=00" })).status).toBe(401);
  });

  it("acknowledges and forgets events it does not handle (ping, installation)", async () => {
    const { w, queue, send } = setup();
    expect((await send({ zen: "hi" }, { "x-github-event": "ping" })).status).toBe(202);
    expect(queue.sent).toEqual([]);
    expect(w.ddb.items()).toEqual([]);
  });

  it("rejects a delivery without event/delivery headers, or with a hostile delivery id", async () => {
    const { send } = setup();
    expect((await send(PAYLOAD, { "x-github-event": undefined })).status).toBe(400);
    expect((await send(PAYLOAD, { "x-github-delivery": undefined })).status).toBe(400);
    expect((await send(PAYLOAD, { "x-github-delivery": "../../etc/passwd" })).status).toBe(400);
  });

  it("returns 500 and forgets the delivery when it cannot be enqueued, so GitHub's redelivery is accepted", async () => {
    const { queue, send, w } = setup();
    queue.failNext = true;
    expect((await send(PAYLOAD)).status).toBe(500);
    expect(w.ddb.items()).toEqual([]);
    expect((await send(PAYLOAD)).status).toBe(202);
    expect(queue.sent).toHaveLength(1);
  });

  it("stores a large delivery in S3 and enqueues only its id", async () => {
    const { w, queue, send } = setup();
    const res = await send({ ...PAYLOAD, pad: "x".repeat(70_000) });
    expect(res.status).toBe(202);
    expect(w.s3.objects.size).toBe(1);
    expect(JSON.stringify(queue.sent)).not.toContain("xxxx");
  });
});
