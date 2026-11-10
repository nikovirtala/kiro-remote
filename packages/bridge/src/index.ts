/**
 * @nikovirtala/kiro-remote-bridge
 *
 * The Lambda bridge: an SQS FIFO command consumer and a CONFIG#CAPS publisher,
 * each starting a short-lived KAS engine child per invocation and writing
 * events and state to DynamoDB. The API only ever READS the log; the bridge is
 * the sole writer.
 *
 * This barrel re-exports the composable pieces the two Lambda entries share.
 */

export const PACKAGE_NAME = "@nikovirtala/kiro-remote-bridge";

export * from "./cloud-session.ts";
// NOTE: caps-publisher.ts and lambda-consumer.ts are Lambda ENTRYPOINT modules
// (each exports a `handler`), not composable library pieces, so they are NOT
// re-exported through this barrel (two `handler` exports would be ambiguous).
// Tests and the bundle entrypoints import them directly by module path.
export * from "./logger.ts";
export * from "./metrics.ts";
export * from "./secrets.ts";
export * from "./transport.ts";
