/**
 * Offline fakes for the AWS SDK clients the bridge uses, so integration tests
 * run with no network. These implement just the command surface the
 * {@link Repository} exercises.
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

    // Like real DynamoDB, refuse a FilterExpression on a primary-key attribute.
    if (/\bSK\b/.test(input.FilterExpression ?? "")) {
      throw named("ValidationException");
    }
    // Main table event query: PK = :pk AND SK BETWEEN :from AND :to.
    const pk = values[":pk"];
    const from = values[":from"] as string | undefined;
    const to = values[":to"] as string | undefined;
    let items = all.filter((i) => i.PK === pk);
    if (from !== undefined && to !== undefined) {
      items = items.filter((i) => String(i.SK) >= from && String(i.SK) <= to);
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
