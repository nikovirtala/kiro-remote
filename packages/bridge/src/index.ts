/**
 * @kiro-remote/bridge
 *
 * Container entrypoint (`bridge serve`): one ACP V3 gateway over a single
 * `kiro-cli acp --agent-engine=v3` child, SQS FIFO command intake, and
 * event/state writes to DynamoDB. The API only ever READS the log; the bridge
 * is the sole writer.
 *
 * This barrel re-exports the composable pieces so tests (and the CLI) can wire
 * them against a fake scripted ACP agent with injected AWS clients.
 */

export const PACKAGE_NAME = "@kiro-remote/bridge";

export * from "./gateway.ts";
export * from "./headless.ts";
export * from "./health.ts";
export * from "./intake.ts";
export * from "./logger.ts";
export * from "./metrics.ts";
export * from "./secrets.ts";
export * from "./serve.ts";
export * from "./session-manager.ts";
export * from "./supervisor.ts";
export * from "./transport.ts";
