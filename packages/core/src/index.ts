/**
 * @nikovirtala/kiro-remote-core
 *
 * Single source of truth for the kiro-remote control plane:
 *  - zod schemas (REST validation + OpenAPI 3.1 + MCP tool input schemas)
 *  - domain types and the normalized event union
 *  - the KiroGateway interface and capabilities() model
 *  - the pure state machine transition(state, event)
 *  - the ACP V3 event normalizer + coalescer
 *  - the DynamoDB single-table repository
 *  - the pure service layer
 *  - authenticate()/authorize() (the only token-claim readers)
 *  - the redaction utility
 */

export const PACKAGE_NAME = "@nikovirtala/kiro-remote-core";

export * from "./auth/authenticate.ts";
export * from "./auth/authorize.ts";
export * from "./config.ts";
export * from "./domain.ts";
export * from "./events/coalesce.ts";
export * from "./events/dedupe.ts";
export * from "./events/normalize.ts";
export * from "./gateway/index.ts";
export * from "./gateway/jsonrpc.ts";
export * from "./gateway/reconnect.ts";
export * from "./redact.ts";
export * from "./repo/keys.ts";
export * from "./repo/repository.ts";
export * from "./repo/types.ts";
export * from "./schemas/index.ts";
export * from "./schemas/jsonschema.ts";
export * from "./service/allowlist.ts";
export * from "./service/commands.ts";
export * from "./service/errors.ts";
export * from "./service/index.ts";
export * from "./state/transition.ts";
