import { describe, expect, it } from "vitest";
import { type Command, SqsCommandQueue } from "../src/index.ts";

/** A fake SQSClient capturing every SendMessageCommand input. */
class FakeSqsClient {
  // biome-ignore lint/suspicious/noExplicitAny: command input shape is dynamic.
  readonly sent: any[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: SQS command is dynamic.
  async send(command: { input: any }): Promise<Record<string, unknown>> {
    this.sent.push(command.input);
    return { MessageId: "msg-1" };
  }
}

function launchCommand(): Command {
  return {
    kind: "launch",
    sub: "user-1",
    sessionId: "sess-42",
    commandId: "cmd-1",
    prompt: "hello",
    repos: ["acme/app"],
  };
}

describe("SqsCommandQueue", () => {
  it("sends a SendMessageCommand with MessageGroupId=sessionId and a JSON body", async () => {
    const sqs = new FakeSqsClient();
    const queue = new SqsCommandQueue({
      // biome-ignore lint/suspicious/noExplicitAny: fake SQS client.
      sqs: sqs as any,
      queueUrl: "https://sqs.local/queue.fifo",
    });

    const command = launchCommand();
    await queue.enqueue(command);

    expect(sqs.sent).toHaveLength(1);
    const input = sqs.sent[0];
    expect(input.QueueUrl).toBe("https://sqs.local/queue.fifo");
    expect(input.MessageGroupId).toBe("sess-42");
    // Content-based dedup: no explicit MessageDeduplicationId is sent.
    expect(input.MessageDeduplicationId).toBeUndefined();
    expect(JSON.parse(input.MessageBody)).toEqual(command);
  });

  it("groups by the command's own sessionId for each enqueue", async () => {
    const sqs = new FakeSqsClient();
    const queue = new SqsCommandQueue({
      // biome-ignore lint/suspicious/noExplicitAny: fake SQS client.
      sqs: sqs as any,
      queueUrl: "https://sqs.local/queue.fifo",
    });

    await queue.enqueue({ ...launchCommand(), sessionId: "a" });
    await queue.enqueue({ ...launchCommand(), sessionId: "b" });

    expect(sqs.sent.map((i) => i.MessageGroupId)).toEqual(["a", "b"]);
  });
});
