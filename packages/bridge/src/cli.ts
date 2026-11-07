#!/usr/bin/env node
/**
 * `bridge` CLI entrypoint. The only supported subcommand is `serve`, which is
 * the container entrypoint for the ACP gateway.
 */

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

async function main(): Promise<void> {
  const command = process.argv[2] ?? "serve";
  switch (command) {
    case "serve":
      await serve();
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
