/**
 * Offline fakes for the AWS SDK clients the bridge uses, so integration tests
 * run with no network. These implement just the command surface the
 * {@link Repository} and intake exercise.
 */

import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

type Item = Record<string, unknown>;

/** Minimal in-memory DynamoDB document client. Keyed by `PK | SK`. */
export class FakeDocClient {
  readonly store = new Map<string, Item>();

  private key(pk: unknown, sk: unknown): string {
    return `${String(pk)}|${String(sk)}`;
  }

  // biome-ignore lint/suspicious/noExplicitAny: command union is large; narrow by instanceof.
  async send(command: any): Promise<any> {
    if (command instanceof PutCommand) {
      const item = command.input.Item as Item;
      const k = this.key(item.PK, item.SK);
      if (
        command.input.ConditionExpression?.includes("attribute_not_exists") &&
        this.store.has(k)
      ) {
        const err = new Error("conditional check failed");
        (err as { name: string }).name = "ConditionalCheckFailedException";
        throw err;
      }
      this.store.set(k, { ...item });
      return {};
    }

    if (command instanceof GetCommand) {
      const k = this.key(command.input.Key?.PK, command.input.Key?.SK);
      const item = this.store.get(k);
      return { Item: item ? { ...item } : undefined };
    }

    if (command instanceof DeleteCommand) {
      const k = this.key(command.input.Key?.PK, command.input.Key?.SK);
      const old = this.store.get(k);
      this.store.delete(k);
      return { Attributes: old };
    }

    if (command instanceof UpdateCommand) {
      return this.handleUpdate(command);
    }

    if (command instanceof QueryCommand) {
      return this.handleQuery(command);
    }

    throw new Error(`FakeDocClient: unsupported command ${command.constructor?.name}`);
  }

  // biome-ignore lint/suspicious/noExplicitAny: UpdateCommand input is dynamic.
  private handleUpdate(command: any): Item {
    const input = command.input;
    const k = this.key(input.Key.PK, input.Key.SK);
    const item = this.store.get(k) ?? { ...input.Key };
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const names = (input.ExpressionAttributeNames ?? {}) as Record<string, string>;

    // Enforce conditional expressions on version / status / existence.
    const cond: string | undefined = input.ConditionExpression;
    if (cond) {
      if (cond.includes("attribute_exists(PK)") && !this.store.has(k)) {
        throw named("ConditionalCheckFailedException");
      }
      if (cond.includes("#version = :expected") && item.version !== values[":expected"]) {
        throw named("ConditionalCheckFailedException");
      }
      if (cond.includes("#status = :pending") && item.status !== values[":pending"]) {
        throw named("ConditionalCheckFailedException");
      }
    }

    const expr: string = input.UpdateExpression ?? "";
    const setPart = expr.replace(/^SET\s+/i, "");
    for (const clause of setPart.split(",").map((c: string) => c.trim())) {
      // #name = #name + :one   (atomic increment)
      const incr = clause.match(/^(#?\w+)\s*=\s*(#?\w+)\s*\+\s*(:\w+)$/);
      if (incr) {
        const field = resolveName(incr[1], names);
        const current = Number(item[field] ?? 0);
        item[field] = current + Number(values[incr[3]]);
        continue;
      }
      // #name = :value
      const set = clause.match(/^(#?\w+)\s*=\s*(:\w+)$/);
      if (set) {
        const field = resolveName(set[1], names);
        item[field] = values[set[2]];
      }
    }
    this.store.set(k, item);
    const updatedNew: Item = {};
    if (input.ReturnValues === "UPDATED_NEW") {
      updatedNew.eventSeq = item.eventSeq;
    }
    return { Attributes: updatedNew };
  }

  // biome-ignore lint/suspicious/noExplicitAny: QueryCommand input is dynamic.
  private handleQuery(command: any): { Items: Item[]; LastEvaluatedKey?: unknown } {
    const input = command.input;
    const values = (input.ExpressionAttributeValues ?? {}) as Record<string, unknown>;
    const all = [...this.store.values()];

    // GSI1 query by GSI1PK.
    if (input.IndexName === "GSI1") {
      const pk = values[":pk"];
      const items = all
        .filter((i) => i.GSI1PK === pk)
        .sort((a, b) => String(b.GSI1SK).localeCompare(String(a.GSI1SK)));
      return { Items: items.slice(0, input.Limit ?? items.length) };
    }

    // Main table event query: PK = :pk AND SK > :after, begins_with(SK, EVT#).
    const pk = values[":pk"];
    const after = values[":after"] as string | undefined;
    let items = all.filter((i) => i.PK === pk);
    if (after) {
      items = items.filter((i) => String(i.SK) > after);
    }
    if (input.FilterExpression?.includes("begins_with(SK, :evtPrefix)")) {
      items = items.filter((i) => String(i.SK).startsWith("EVT#"));
    }
    items = items.sort((a, b) => String(a.SK).localeCompare(String(b.SK)));
    return { Items: input.Limit ? items.slice(0, input.Limit) : items };
  }
}

function resolveName(token: string, names: Record<string, string>): string {
  return token.startsWith("#") ? (names[token] ?? token.slice(1)) : token;
}

function named(name: string): Error {
  const err = new Error(name);
  (err as { name: string }).name = name;
  return err;
}

/** S3 fake: in-memory object store. */
export class FakeS3Client {
  readonly objects = new Map<string, string>();
  // biome-ignore lint/suspicious/noExplicitAny: command union narrowed by name.
  async send(command: any): Promise<any> {
    const name = command.constructor?.name;
    if (name === "PutObjectCommand") {
      this.objects.set(command.input.Key, String(command.input.Body));
      return {};
    }
    if (name === "GetObjectCommand") {
      const body = this.objects.get(command.input.Key);
      return { Body: { transformToString: async () => body } };
    }
    throw new Error(`FakeS3Client: unsupported command ${name}`);
  }
}

/**
 * SQS fake: an in-memory FIFO queue that models per-group HEAD-OF-LINE BLOCKING.
 *
 * Real SQS FIFO guarantees ordered, exactly-once-in-flight delivery PER message
 * group: once a message in a group has been received (returned by Receive) and
 * is not yet deleted, SQS will NOT deliver any later message in that SAME group
 * until the in-flight one is deleted (or its visibility timeout expires).
 * Delivery across DIFFERENT groups is independent.
 *
 * The previous fake ignored this and returned later same-group messages even
 * while an earlier one was still in-flight, which hid the real permission
 * deadlock (a launch parked on a permission stayed in-flight, and the
 * answerPermission that would release it is in the SAME group, so it is
 * head-of-line blocked and never delivered). Modeling the blocking here is what
 * lets a test reproduce -- and prove the fix for -- that deadlock.
 */
export class FakeSqsClient {
  private messages: { Body: string; ReceiptHandle: string; groupId: string }[] = [];
  private nextHandle = 1;
  /** Groups with an outstanding (received-but-not-deleted) message. */
  private readonly inFlightGroups = new Set<string>();
  /** ReceiptHandle -> groupId for the currently in-flight message of each group. */
  private readonly inFlightByHandle = new Map<string, string>();

  /** Test helper: enqueue a command body with its group id (sessionId). */
  enqueue(body: unknown, groupId: string): void {
    this.messages.push({
      Body: JSON.stringify(body),
      ReceiptHandle: `rh-${this.nextHandle++}`,
      groupId,
    });
  }

  remaining(): number {
    return this.messages.length;
  }

  // biome-ignore lint/suspicious/noExplicitAny: command union narrowed by name.
  async send(command: any): Promise<any> {
    const name = command.constructor?.name;
    if (name === "ReceiveMessageCommand") {
      const max = command.input.MaxNumberOfMessages ?? 1;
      const batch: typeof this.messages = [];
      // Deliver at most one message per group (FIFO: the next undelivered
      // message of a group is only eligible when that group has nothing
      // in-flight), in enqueue order, up to the batch size.
      const claimedGroups = new Set<string>();
      for (const m of this.messages) {
        if (batch.length >= max) {
          break;
        }
        if (this.inFlightGroups.has(m.groupId) || claimedGroups.has(m.groupId)) {
          // Group is head-of-line blocked (or already contributed this batch).
          continue;
        }
        claimedGroups.add(m.groupId);
        this.inFlightGroups.add(m.groupId);
        this.inFlightByHandle.set(m.ReceiptHandle, m.groupId);
        batch.push(m);
      }
      return {
        Messages: batch.map((m) => ({
          Body: m.Body,
          ReceiptHandle: m.ReceiptHandle,
          Attributes: { MessageGroupId: m.groupId },
        })),
      };
    }
    if (name === "DeleteMessageCommand") {
      const handle = command.input.ReceiptHandle;
      this.messages = this.messages.filter((m) => m.ReceiptHandle !== handle);
      // Releasing the in-flight message unblocks its group for later messages.
      const groupId = this.inFlightByHandle.get(handle);
      if (groupId !== undefined) {
        this.inFlightByHandle.delete(handle);
        this.inFlightGroups.delete(groupId);
      }
      return {};
    }
    throw new Error(`FakeSqsClient: unsupported command ${name}`);
  }
}
