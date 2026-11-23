/**
 * Puts the open waits and open linked PRs that existed before GSI2 into the sweep's index
 * (`tasks/1-index-open-waits-and-links.ts` runs it once; docs/github.md, "The sweep").
 *
 * It scans GSI1, which holds every wait and every link (and the sessions), asking for nothing but
 * keys: no item's content is read. A wait is `SESSION#<id>` / `WAIT#<pr>` under `GHWAIT#...`, an
 * open link is `GHPR#<pr>` / `LINK` under `GHREPO#...` with an `OPEN#` sort key. The write is
 * conditional, so running it twice, or while a wait fires or a PR closes, changes nothing it should
 * not.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  GH_LINK_OPEN_PREFIX,
  GH_LINK_SK,
  SWEEP_LINK_PK,
  SWEEP_WAIT_PK,
  sweepLinkSk,
  sweepWaitSk,
  WAIT_PREFIX,
} from "./keys.ts";

export interface BackfillResult {
  /** GSI1 items looked at. */
  scanned: number;
  /** Waits put (or to be put, in a dry run) into the sweep's index. */
  waits: number;
  /** Open links put (or to be put) into it. */
  links: number;
  /** Already in the index, or changed while the backfill ran. */
  skipped: number;
}

type Key = { PK: string; SK: string };

/** What an item of GSI1 needs to get into GSI2, or null when it is not a wait or an open link. */
export function sweepKeysFor(item: {
  PK?: unknown;
  SK?: unknown;
  GSI1PK?: unknown;
  GSI1SK?: unknown;
}): { kind: "wait" | "link"; gsi2pk: string; gsi2sk: string } | null {
  const pk = String(item.PK ?? "");
  const sk = String(item.SK ?? "");
  const gsi1pk = String(item.GSI1PK ?? "");
  if (gsi1pk.startsWith("GHWAIT#") && pk.startsWith("SESSION#") && sk.startsWith(WAIT_PREFIX)) {
    return {
      kind: "wait",
      gsi2pk: SWEEP_WAIT_PK,
      gsi2sk: sweepWaitSk(sk.slice(WAIT_PREFIX.length), pk.slice("SESSION#".length)),
    };
  }
  if (
    gsi1pk.startsWith("GHREPO#") &&
    pk.startsWith("GHPR#") &&
    sk === GH_LINK_SK &&
    String(item.GSI1SK ?? "").startsWith(GH_LINK_OPEN_PREFIX)
  ) {
    return {
      kind: "link",
      gsi2pk: SWEEP_LINK_PK,
      gsi2sk: sweepLinkSk(pk.slice("GHPR#".length)),
    };
  }
  return null;
}

export async function backfillSweepIndex(
  ddb: DynamoDBDocumentClient,
  table: string,
  opts: { dryRun: boolean },
): Promise<BackfillResult> {
  const out: BackfillResult = { scanned: 0, waits: 0, links: 0, skipped: 0 };
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: table,
        IndexName: "GSI1",
        // Keys only: the task never reads what a session, a link or a wait says.
        ProjectionExpression: "PK, SK, GSI1PK, GSI1SK, GSI2PK",
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of (page.Items as Array<Key & Record<string, unknown>> | undefined) ?? []) {
      out.scanned++;
      const keys = sweepKeysFor(item);
      if (!keys) {
        continue;
      }
      if (item.GSI2PK !== undefined) {
        out.skipped++;
        continue;
      }
      if (!opts.dryRun) {
        try {
          await ddb.send(
            new UpdateCommand({
              TableName: table,
              Key: { PK: item.PK, SK: item.SK },
              UpdateExpression: "SET GSI2PK = :pk, GSI2SK = :sk",
              // Still there, not indexed yet, and (for a link) still open as it was scanned.
              ConditionExpression:
                keys.kind === "link"
                  ? "attribute_exists(PK) AND attribute_not_exists(GSI2PK) AND GSI1SK = :open"
                  : "attribute_exists(PK) AND attribute_not_exists(GSI2PK)",
              ExpressionAttributeValues: {
                ":pk": keys.gsi2pk,
                ":sk": keys.gsi2sk,
                ...(keys.kind === "link" ? { ":open": item.GSI1SK } : {}),
              },
            }),
          );
        } catch (err) {
          if ((err as { name?: string }).name === "ConditionalCheckFailedException") {
            out.skipped++;
            continue;
          }
          throw err;
        }
      }
      if (keys.kind === "wait") {
        out.waits++;
      } else {
        out.links++;
      }
    }
    cursor = page.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (cursor);
  return out;
}

/** The document client the task uses: the task role's keys come from the environment. */
export function backfillClient(region: string): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient({ region }));
}
