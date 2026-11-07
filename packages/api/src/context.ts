/**
 * The {@link ApiContext}: every dependency the Lambda needs, injected so the
 * whole package runs offline in tests (DynamoDB reads, the SQS enqueue behind
 * the core service, the token verifier, the idempotency store are all mocks).
 *
 * The context also carries the facade dependencies from @nikovirtala/auth and
 * the optional MCP transport handler (FEAT-006) for the /mcp seam.
 */

import type {
  AuthorizeDeps,
  CallbackDeps,
  FacadeConfig,
  RevokeDeps,
  TokenDeps,
} from "@nikovirtala/auth";
import type {
  AuthenticateConfig,
  Capabilities,
  Principal,
  Repository,
  ServiceDeps,
} from "@nikovirtala/core";
import type { McpTransportHandler } from "./mcp-seam.ts";
import { NoopObservability, type Observability } from "./observability.ts";

/** Bundle of the facade handler dependencies mounted (unauthenticated). */
export interface FacadeDeps {
  config: FacadeConfig;
  authorize: AuthorizeDeps;
  callback: CallbackDeps;
  token: TokenDeps;
  revoke: RevokeDeps;
}

/** Everything the API handler depends on. */
export interface ApiContext {
  /** The pure service layer deps (repo + SQS queue + allow-list + clocks). */
  service: ServiceDeps;
  /** Direct repository handle for reads the service layer does not expose. */
  repo: Repository;
  /** authenticate() configuration (token verifier, allowed clients, resource). */
  auth: AuthenticateConfig;
  /**
   * The RFC 9728 protected-resource-metadata URL advertised in 401 challenges.
   * Computed from the facade config so REST and /mcp agree.
   */
  resourceMetadataUrl: string;
  /** Resolve the running server's advertised capabilities (from CONFIG#CAPS). */
  capabilities: () => Promise<Capabilities>;
  /** The kiro-cli version string surfaced by GET /capabilities. */
  kiroCliVersion: () => Promise<string | null>;
  /** The facade handler dependencies (mounted with NO auth). */
  facade: FacadeDeps;
  /** The public base URL (no trailing slash) used to build absolute URLs. */
  publicBaseUrl: string;
  /** Observability facade (Powertools in prod, no-op by default). */
  obs: Observability;
  /**
   * The MCP Streamable HTTP transport handler, plugged in by FEAT-006. When
   * absent, /mcp still authenticates and then returns 501 so the auth boundary
   * and protected-resource advertisement are testable now.
   */
  mcp?: McpTransportHandler;
}

/** Fill in defaulted fields of a partial context (used by tests/builders). */
export function withDefaults(ctx: ApiContext): ApiContext {
  return { ...ctx, obs: ctx.obs ?? new NoopObservability() };
}

export type { Principal };
