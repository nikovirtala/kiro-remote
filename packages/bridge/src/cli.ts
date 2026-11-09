#!/usr/bin/env node
/**
 * `bridge` CLI entrypoint. Subcommands:
 *  - `serve`        : the persistent ACP-gateway container entrypoint (the ECS
 *                     Fargate bridge).
 *  - `caps-publish` : the one-shot capability publisher -- spin up the ACP
 *                     child, `initialize`, write CONFIG#CAPS, exit. The Lambda
 *                     deployment invokes this on deploy + on a schedule instead
 *                     of relying on the persistent bridge's boot-time publish.
 *
 * The Lambda cloud CONSUMER is NOT a CLI subcommand: a long-running `while`
 * loop is exactly what the serverless path removes. It is consumed instead as
 * the exported `handler` from {@link lambda-consumer} (the module is bundled and
 * the container-image Lambda runtime invokes that handler per SQS batch). This
 * keeps the bundle story consistent with the ECS image (cli.ts -> bridge.cjs via
 * esbuild) while expressing the two hosts' different invocation models: the ECS
 * bridge RUNS a process (a subcommand), the Lambda consumer EXPORTS a handler.
 * See FEAT-004 for the image/entry wiring that runs these.
 */

import { capsPublisherConfigFromEnv, runCapsPublish } from "./caps-publisher.ts";
import { BridgeServer, type ServeConfig } from "./serve.ts";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var: ${name}`);
  }
  return value;
}

function configFromEnv(): ServeConfig {
  return {
    tableName: requireEnv("TABLE_NAME"),
    bucketName: requireEnv("BUCKET_NAME"),
    queueUrl: requireEnv("COMMAND_QUEUE_URL"),
    workspaceRoot: process.env.WORKSPACE_ROOT ?? "/workspace",
    ...(process.env.ADDITIONAL_DIRECTORIES
      ? { additionalDirectories: process.env.ADDITIONAL_DIRECTORIES.split(",").filter(Boolean) }
      : {}),
    ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
  };
}

async function serve(): Promise<void> {
  const server = await BridgeServer.create({ config: configFromEnv() });
  server.installSignalHandlers();
  await server.start();
  server.beginIntake();
}

async function capsPublish(): Promise<void> {
  await runCapsPublish({ config: capsPublisherConfigFromEnv() });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  switch (command) {
    case "serve":
      await serve();
      return;
    case "caps-publish":
      await capsPublish();
      return;
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(2);
  }
}

main().catch((err) => {
  process.stderr.write(`bridge fatal: ${String(err)}\n`);
  process.exit(1);
});
