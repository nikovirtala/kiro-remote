/**
 * @kiro-remote/bridge
 *
 * Container entrypoint (`bridge serve`): one ACP V3 gateway over a single
 * `kiro-cli acp --agent-engine=v3` child, SQS FIFO command intake, and
 * event/state writes to DynamoDB.
 *
 * This is a scaffold stub; real implementation lands in later features.
 */

export const PACKAGE_NAME = "@kiro-remote/bridge";
