/**
 * The HTTP API router and the Lambda entry point.
 *
 * Dispatch order:
 *   1. Unauthenticated facade endpoints (/.well-known/*, /oauth/*).
 *   2. GET /openapi.json (the public API description; unauthenticated).
 *   3. /mcp Streamable HTTP transport -- authenticate() first (401 with the
 *      resource_metadata challenge when unauthenticated), then hand to the MCP
 *      handler registered by FEAT-006, or 501 until it is wired.
 *   4. /v1/* REST routes -- authenticate() first, then match + dispatch.
 *
 * authenticate() runs IN this Lambda (never an API Gateway JWT authorizer) so
 * the 401/403 header shapes are ours. The client bearer token is only ever
 * passed to core's authenticate(); it is NEVER forwarded to Kiro or logged.
 */

import { authenticate, ForbiddenError, type Principal, UnauthorizedError } from "@nikovirtala/core";
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from "aws-lambda";
import type { ApiContext } from "./context.ts";
import { dispatchFacade, isFacadePath } from "./facade.ts";
import { type HttpRequest, type HttpResponse, jsonResponse, parseEvent } from "./http.ts";
import { buildOpenApiDocument } from "./openapi.ts";
import { CapabilityUnavailableError, errorToProblem, NotFoundError } from "./problem.ts";
import {
  deleteSessionRoute,
  getCapabilities,
  getEvents,
  getSession,
  getTurn,
  listModels,
  listPermissions,
  listSessions,
  patchConfig,
  postAdoptSession,
  postAnswerPermission,
  postCancel,
  postLaunchSession,
  postTurn,
} from "./routes.ts";

const V1_PREFIX = "/v1";

type RouteHandler = (
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
) => Promise<HttpResponse>;

interface RouteDef {
  method: string;
  /** Path template under /v1, e.g. "/sessions/{id}/turns/{turnId}". */
  template: string;
  handler: RouteHandler;
}

const ROUTES: RouteDef[] = [
  { method: "GET", template: "/capabilities", handler: getCapabilities },
  { method: "GET", template: "/models", handler: listModels },
  { method: "GET", template: "/sessions", handler: listSessions },
  { method: "POST", template: "/sessions", handler: postLaunchSession },
  { method: "POST", template: "/sessions/adopt", handler: postAdoptSession },
  { method: "GET", template: "/sessions/{id}", handler: getSession },
  { method: "DELETE", template: "/sessions/{id}", handler: deleteSessionRoute },
  { method: "POST", template: "/sessions/{id}/turns", handler: postTurn },
  { method: "GET", template: "/sessions/{id}/turns/{turnId}", handler: getTurn },
  { method: "GET", template: "/sessions/{id}/events", handler: getEvents },
  { method: "POST", template: "/sessions/{id}/cancel", handler: postCancel },
  { method: "GET", template: "/sessions/{id}/permissions", handler: listPermissions },
  {
    method: "POST",
    template: "/sessions/{id}/permissions/{requestId}",
    handler: postAnswerPermission,
  },
  { method: "PATCH", template: "/sessions/{id}/config", handler: patchConfig },
];

/** Match a concrete path against a template, capturing `{param}` segments. */
function matchTemplate(template: string, path: string): Record<string, string> | null {
  const tParts = template.split("/").filter(Boolean);
  const pParts = path.split("/").filter(Boolean);
  if (tParts.length !== pParts.length) {
    return null;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < tParts.length; i++) {
    const t = tParts[i];
    const p = pParts[i];
    if (t.startsWith("{") && t.endsWith("}")) {
      params[t.slice(1, -1)] = decodeURIComponent(p);
    } else if (t !== p) {
      return null;
    }
  }
  return params;
}

/** Strip the /v1 base path. Returns null when the path is not under /v1. */
function stripV1(path: string): string | null {
  if (path === V1_PREFIX) {
    return "/";
  }
  if (path.startsWith(`${V1_PREFIX}/`)) {
    return path.slice(V1_PREFIX.length);
  }
  return null;
}

/**
 * authenticate() wrapper that also records the AuthFailures metric by reason.
 * Returns the Principal or throws the (already shaped) auth error.
 */
async function authenticateRequest(ctx: ApiContext, req: HttpRequest): Promise<Principal> {
  try {
    return await authenticate({ headers: req.headers }, ctx.auth, ctx.resourceMetadataUrl);
  } catch (err) {
    if (err instanceof UnauthorizedError) {
      const hasToken = Boolean(req.headers.authorization ?? req.headers.Authorization);
      ctx.obs.authFailure(hasToken ? "invalid_token" : "missing_token");
    } else if (err instanceof ForbiddenError) {
      ctx.obs.authFailure("insufficient_scope");
    }
    throw err;
  }
}

/** Route a parsed request to a response. Pure; the Lambda handler wraps it. */
export async function route(ctx: ApiContext, req: HttpRequest): Promise<HttpResponse> {
  try {
    // 1. Unauthenticated facade endpoints.
    if (isFacadePath(req.path)) {
      const res = await dispatchFacade(ctx, req);
      if (res) {
        return res;
      }
    }

    // 2. Public API description.
    if (req.path === "/openapi.json" && req.method === "GET") {
      return jsonResponse(200, buildOpenApiDocument(ctx.facade.config));
    }

    // 3. /mcp Streamable HTTP transport -- authenticated protected resource.
    if (req.path === "/mcp") {
      const principal = await authenticateRequest(ctx, req);
      if (!ctx.mcp) {
        // FEAT-006 not wired yet: the auth boundary is proven, the transport
        // is not available.
        throw new CapabilityUnavailableError("mcp.streamableHttp");
      }
      const result = await ctx.mcp.handle({
        principal,
        method: req.method,
        headers: req.headers,
        ...(req.body !== undefined ? { body: req.body } : {}),
      });
      return { status: result.status, headers: result.headers, body: result.body };
    }

    // 4. /v1 REST routes -- authenticated.
    const sub = stripV1(req.path);
    if (sub === null) {
      return errorToProblem(new NotFoundError());
    }

    for (const def of ROUTES) {
      if (def.method !== req.method) {
        continue;
      }
      const params = matchTemplate(def.template, sub);
      if (params) {
        const principal = await authenticateRequest(ctx, req);
        const reqWithParams: HttpRequest = { ...req, params };
        return await def.handler(ctx, reqWithParams, principal);
      }
    }

    // Path exists under /v1 but no method matched -> 404 (keeps shape simple).
    return errorToProblem(new NotFoundError());
  } catch (err) {
    return errorToProblem(err);
  } finally {
    ctx.obs.flush();
  }
}

/** Serialize an {@link HttpResponse} to the API Gateway v2 result shape. */
function toProxyResult(res: HttpResponse): APIGatewayProxyStructuredResultV2 {
  return { statusCode: res.status, headers: res.headers, body: res.body };
}

/**
 * Build the Lambda handler bound to a concrete {@link ApiContext}. The CDK
 * stack (FEAT-007) constructs the context from environment and wires this as
 * the function entry point.
 */
export function createHandler(ctx: ApiContext) {
  return async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
    const req = parseEvent(event);
    const res = await route(ctx, req);
    return toProxyResult(res);
  };
}
