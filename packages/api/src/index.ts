/**
 * @kiro-remote/api
 *
 * AWS Lambda handlers that are thin over the core service layer, wired to an
 * API Gateway HTTP API at base path /v1:
 *   - RFC 9457 problem+json errors,
 *   - Idempotency-Key on every POST (24h, scoped to the sub),
 *   - capability-gated 501s (type capability-unavailable),
 *   - writes enqueue a command and return 202; reads come from DynamoDB,
 *   - GET /openapi.json generated from the core zod objects,
 *   - the OAuth facade endpoints mounted unauthenticated on the same API,
 *   - the /mcp Streamable HTTP route protected by authenticate().
 *
 * authenticate()/authorize() run inside the Lambda (never an API Gateway JWT
 * authorizer); the client token is never forwarded to Kiro.
 */

export const PACKAGE_NAME = "@kiro-remote/api";

export type { ApiContext, FacadeDeps } from "./context.ts";
export { withDefaults } from "./context.ts";
export {
  acceptedResponse,
  type HttpRequest,
  type HttpResponse,
  jsonResponse,
  noContentResponse,
  parseEvent,
} from "./http.ts";
export { requireIdempotencyKey, withIdempotency } from "./idempotency.ts";
export type {
  KiroRemoteClient,
  McpTransportHandler,
  McpTransportRequest,
} from "./mcp-seam.ts";
export {
  NoopObservability,
  type Observability,
  PowertoolsObservability,
} from "./observability.ts";
export { buildOpenApiDocument } from "./openapi.ts";
export {
  BadRequestError,
  CapabilityUnavailableError,
  errorToProblem,
  NotFoundError,
  PROBLEM_TYPE_BASE,
  type ProblemDetail,
  problem,
  UnprocessableError,
} from "./problem.ts";
export { createHandler, route } from "./router.ts";
