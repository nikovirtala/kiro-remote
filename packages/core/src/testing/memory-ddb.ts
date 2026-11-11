/**
 * In-memory stand-ins for the DynamoDB document client and S3 client, for
 * tests. They interpret only the command shapes and expression dialect the
 * {@link Repository} uses (simple conditions, `SET` updates, key conditions on
 * PK plus `begins_with` / `BETWEEN` on SK, transactional put/delete), so the
 * real Repository code, expressions included, runs in unit tests.
 */

type Item = Record<string, unknown>;
type Names = Record<string, string>;
type Values = Record<string, unknown>;

function conditionalFailure(): Error {
  return Object.assign(new Error("conditional check failed"), {
    name: "ConditionalCheckFailedException",
  });
}

function resolveName(token: string, names: Names): string {
  return token.startsWith("#") ? (names[token] ?? token) : token;
}

/** True when every AND-ed clause of `expr` holds for `item` (undefined = no item). */
function holds(
  expr: string | undefined,
  item: Item | undefined,
  names: Names,
  values: Values,
): boolean {
  if (!expr) {
    return true;
  }
  return expr.split(/\s+AND\s+/).every((clause) => {
    const c = clause.trim();
    let m = /^attribute_not_exists\((\w+)\)$/.exec(c);
    if (m) {
      return item === undefined || item[m[1]] === undefined;
    }
    m = /^attribute_exists\((\w+)\)$/.exec(c);
    if (m) {
      return item !== undefined && item[m[1]] !== undefined;
    }
    m = /^([#\w]+)\s*=\s*(:\w+)$/.exec(c);
    if (m) {
      if (item === undefined) {
        return false;
      }
      const actual = item[resolveName(m[1], names)];
      const want = values[m[2]];
      return JSON.stringify(actual ?? null) === JSON.stringify(want ?? null);
    }
    throw new Error(`MemoryDdb: unsupported condition clause: ${c}`);
  });
}

function applyUpdate(expr: string, item: Item, names: Names, values: Values): void {
  const body = expr.replace(/^\s*SET\s+/i, "");
  for (const assignment of body.split(/,\s*(?=[#\w]+\s*=)/)) {
    const m = /^\s*([#\w]+)\s*=\s*(.+?)\s*$/.exec(assignment);
    if (!m) {
      throw new Error(`MemoryDdb: unsupported update clause: ${assignment}`);
    }
    const target = resolveName(m[1], names);
    const rhs = m[2];
    const plus = /^([#\w]+)\s*\+\s*(:\w+)$/.exec(rhs);
    if (plus) {
      item[target] = (Number(item[resolveName(plus[1], names)]) || 0) + Number(values[plus[2]]);
    } else if (rhs.startsWith(":")) {
      item[target] = structuredClone(values[rhs]);
    } else {
      throw new Error(`MemoryDdb: unsupported update value: ${rhs}`);
    }
  }
}

export class MemoryDdb {
  /** `PK\u0000SK` -> item. */
  readonly store = new Map<string, Item>();
  /** Every command sent, for assertions. */
  readonly sent: string[] = [];
  /** Optional fault injection: throw this for the next command with that name. */
  failNext = new Map<string, Error>();

  private k(pk: unknown, sk: unknown): string {
    return `${String(pk)}\u0000${String(sk)}`;
  }

  items(): Item[] {
    return [...this.store.values()];
  }

  get(pk: string, sk: string): Item | undefined {
    return this.store.get(this.k(pk, sk));
  }

  put(item: Item): void {
    this.store.set(this.k(item.PK, item.SK), structuredClone(item));
  }

  async send(cmd: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<unknown> {
    const name = cmd.constructor.name;
    this.sent.push(name);
    const injected = this.failNext.get(name);
    if (injected) {
      this.failNext.delete(name);
      throw injected;
    }
    const input = cmd.input;
    const names = (input.ExpressionAttributeNames ?? {}) as Names;
    const values = (input.ExpressionAttributeValues ?? {}) as Values;
    switch (name) {
      case "PutCommand": {
        const item = input.Item as Item;
        const existing = this.store.get(this.k(item.PK, item.SK));
        if (!holds(input.ConditionExpression as string | undefined, existing, names, values)) {
          throw conditionalFailure();
        }
        this.put(item);
        return {};
      }
      case "GetCommand": {
        const key = input.Key as Item;
        const found = this.store.get(this.k(key.PK, key.SK));
        return { Item: found ? structuredClone(found) : undefined };
      }
      case "DeleteCommand": {
        const key = input.Key as Item;
        const k = this.k(key.PK, key.SK);
        const old = this.store.get(k);
        if (!holds(input.ConditionExpression as string | undefined, old, names, values)) {
          throw conditionalFailure();
        }
        this.store.delete(k);
        return { Attributes: old ? structuredClone(old) : undefined };
      }
      case "UpdateCommand": {
        const key = input.Key as Item;
        const k = this.k(key.PK, key.SK);
        const existing = this.store.get(k);
        if (!holds(input.ConditionExpression as string | undefined, existing, names, values)) {
          throw conditionalFailure();
        }
        const next: Item = existing ? structuredClone(existing) : { PK: key.PK, SK: key.SK };
        applyUpdate(input.UpdateExpression as string, next, names, values);
        this.store.set(k, next);
        return { Attributes: structuredClone(next) };
      }
      case "QueryCommand":
        return this.query(input, values);
      case "TransactWriteCommand":
        return this.transact(input.TransactItems as Record<string, Record<string, unknown>>[]);
      default:
        throw new Error(`MemoryDdb: unhandled command ${name}`);
    }
  }

  private query(input: Record<string, unknown>, values: Values): unknown {
    const index = input.IndexName as string | undefined;
    const pkAttr = index ? `${index}PK` : "PK";
    const skAttr = index ? `${index}SK` : "SK";
    const expr = input.KeyConditionExpression as string;
    const pk = values[":pk"];
    let rows = this.items().filter((i) => i[pkAttr] === pk);
    const begins = /begins_with\(SK, (:\w+)\)/.exec(expr);
    const between = /SK BETWEEN (:\w+) AND (:\w+)/.exec(expr);
    if (begins) {
      const prefix = String(values[begins[1]]);
      rows = rows.filter((i) => String(i[skAttr]).startsWith(prefix));
    } else if (between) {
      const lo = String(values[between[1]]);
      const hi = String(values[between[2]]);
      rows = rows.filter((i) => String(i[skAttr]) >= lo && String(i[skAttr]) <= hi);
    }
    rows.sort((a, b) => String(a[skAttr]).localeCompare(String(b[skAttr])));
    if (input.ScanIndexForward === false) {
      rows.reverse();
    }
    if (typeof input.Limit === "number") {
      rows = rows.slice(0, input.Limit);
    }
    return { Items: rows.map((r) => structuredClone(r)) };
  }

  private transact(ops: Record<string, Record<string, unknown>>[]): unknown {
    const reasons: Array<{ Code: string }> = [];
    let failed = false;
    for (const op of ops) {
      const body = (op.Put ?? op.Delete) as Record<string, unknown>;
      const key = (op.Put ? (body.Item as Item) : (body.Key as Item)) as Item;
      const existing = this.store.get(this.k(key.PK, key.SK));
      const ok = holds(
        body.ConditionExpression as string | undefined,
        existing,
        (body.ExpressionAttributeNames ?? {}) as Names,
        (body.ExpressionAttributeValues ?? {}) as Values,
      );
      reasons.push({ Code: ok ? "None" : "ConditionalCheckFailed" });
      failed ||= !ok;
    }
    if (failed) {
      throw Object.assign(new Error("transaction cancelled"), {
        name: "TransactionCanceledException",
        CancellationReasons: reasons,
      });
    }
    for (const op of ops) {
      if (op.Put) {
        this.put(op.Put.Item as Item);
      } else {
        const key = op.Delete.Key as Item;
        this.store.delete(this.k(key.PK, key.SK));
      }
    }
    return {};
  }
}

export class MemoryS3 {
  readonly objects = new Map<string, string>();

  async send(cmd: {
    constructor: { name: string };
    input: Record<string, unknown>;
  }): Promise<unknown> {
    const key = `${String(cmd.input.Bucket)}/${String(cmd.input.Key)}`;
    switch (cmd.constructor.name) {
      case "PutObjectCommand":
        this.objects.set(key, String(cmd.input.Body));
        return {};
      case "GetObjectCommand": {
        const body = this.objects.get(key);
        return { Body: { transformToString: async () => body } };
      }
      default:
        throw new Error(`MemoryS3: unhandled command ${cmd.constructor.name}`);
    }
  }
}

/** A session META item with sensible defaults, for seeding tests. */
export function sessionItem(
  id: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> & { PK: string; SK: "META"; id: string } {
  const ts = "2026-01-01T00:00:00.000Z";
  return {
    PK: `SESSION#${id}`,
    SK: "META",
    id,
    kiroSessionId: "sess_cloud_1",
    title: null,
    repos: ["octo/repo"],
    agent: null,
    mode: null,
    model: null,
    effort: null,
    status: "idle",
    activeTurnId: null,
    eventSeq: 0,
    createdBy: "user-sub-1",
    createdAt: ts,
    updatedAt: ts,
    version: 0,
    GSI1PK: "USER#user-sub-1",
    GSI1SK: ts,
    ...overrides,
  };
}

/** A Repository over fresh in-memory stores. */
export async function memoryRepository(now: () => number = () => Date.now()) {
  const { Repository } = await import("../repo/repository.ts");
  const ddb = new MemoryDdb();
  const s3 = new MemoryS3();
  const repo = new Repository({
    ddb: ddb as never,
    s3: s3 as never,
    tableName: "t",
    bucketName: "b",
    now,
  });
  return { repo, ddb, s3 };
}
