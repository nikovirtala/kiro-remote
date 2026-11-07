/**
 * Production API Lambda entry point: exports `handler` so the construct's
 * `handler: "index.handler"` resolves once this module is bundled to
 * `index.js`.
 *
 * This entry lives in the cdk package (NOT packages/api) on purpose: wiring
 * ApiContext.mcp needs @nikovirtala/kiro-remote-mcp's InProcessClient +
 * createHttpTransportHandler, but @nikovirtala/kiro-remote-mcp already depends on
 * @nikovirtala/kiro-remote-api, so building the transport inside packages/api would
 * create a package dependency cycle (api -> mcp -> api). The cdk package is a
 * leaf consumer (nothing depends on it), so it can depend on BOTH api and mcp
 * and assemble them here without any cycle.
 *
 * A single handler serves every Function the construct points at this asset
 * (ApiFn, OAuthCallbackFn, OAuthTokenFn): the router's one app dispatches
 * /v1/*, /mcp, /.well-known/*, /openapi.json AND the /oauth/* facade. KMS
 * grants are per-Function-role, so the shared asset preserves the
 * callback-encrypt / token-decrypt scoping.
 *
 * The context (and the AWS SDK clients inside it) is built ONCE at module load
 * and reused across warm invocations.
 */

import { buildContextFromEnv, createHandler } from "@nikovirtala/kiro-remote-api";
import { createHttpTransportHandler, InProcessClient } from "@nikovirtala/kiro-remote-mcp";

// Build the context first WITHOUT mcp so we can reuse its service/repo/version
// resolver when constructing the in-process MCP client, then plug the transport
// back in (ctx.mcp is optional, so a second assembly would be wasteful).
const base = buildContextFromEnv();

const mcpClient = new InProcessClient({
  service: base.service,
  repo: base.repo,
  kiroCliVersion: base.kiroCliVersion,
});

const ctx = { ...base, mcp: createHttpTransportHandler({ client: mcpClient }) };

export const handler = createHandler(ctx);
