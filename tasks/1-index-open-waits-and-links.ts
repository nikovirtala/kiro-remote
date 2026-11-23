// Puts the waits and open linked PRs that exist before the sweep's index (GSI2) into it, once, so
// the first run of the scheduled sweep finds them (docs/github.md, "The sweep"). A wait or a link
// written after the deploy carries the keys from the start. The work is
// packages/core/src/repo/backfill.ts, which reads keys only.
import { backfillClient, backfillSweepIndex } from "../packages/core/src/repo/backfill.ts";

export const needs = {
  role: "kiro-remote-deployment-task-index-sweep", // packages/pipeline/src/task-roles.ts
  description:
    "Adds the sweep's index keys (GSI2PK, GSI2SK) to the open waits and open linked PRs that predate the index.",
  outputs: ["TableName"], // KiroRemoteStack outputs it reads, given as ctx.outputs
};

interface Ctx {
  region: string;
  outputs: Readonly<Record<string, string>>;
  log: (message: string) => void;
}

export async function execute(
  ctx: Ctx,
  dryRun: boolean,
  client = backfillClient(ctx.region),
): Promise<{ summary: string }> {
  const table = ctx.outputs.TableName;
  if (!table) {
    throw new Error("the stack has no TableName output");
  }
  const r = await backfillSweepIndex(client, table, { dryRun });
  ctx.log(`scanned ${r.scanned} index item(s), skipped ${r.skipped}`);
  return {
    summary: `${dryRun ? "would index" : "indexed"} ${r.waits} wait(s) and ${r.links} open link(s) (${r.scanned} scanned, ${r.skipped} skipped)`,
  };
}

export const dryRun = (ctx: Ctx) => execute(ctx, true);
export const run = (ctx: Ctx) => execute(ctx, false);
