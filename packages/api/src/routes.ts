/**
 * The /v1 route handlers. Each is a thin adapter over the core service
 * (writes) or the repository (reads): authenticate() has already run in the
 * router and produced the {@link Principal}; here we validate the body/query
 * with the core zod schema, gate on capabilities where required, call the core
 * function, and format the response. Every error bubbles to the router which
 * renders it as problem+json.
 *
 * Contract invariants enforced here:
 *   - writes enqueue a command (via the service) and return 202,
 *   - reads derive only from DynamoDB rows,
 *   - a route whose required extension is not advertised returns 501,
 *   - a POST without Idempotency-Key is 400 and replays return the stored body.
 */

import {
  AdoptSessionSchema,
  AnswerPermissionSchema,
  adoptSession,
  answerPermission,
  ConfigPatchSchema,
  CreateTurnSchema,
  cancelTurn,
  deleteSession,
  capabilities as deriveCapabilities,
  EventsQuerySchema,
  hasExtensionMethod,
  LaunchSessionSchema,
  ListSessionsQuerySchema,
  launchSession,
  type Principal,
  readEvents,
  sendPrompt,
  setConfig,
  getSession as svcGetSession,
  listSessions as svcListSessions,
} from "@nikovirtala/kiro-remote-core";
import type { ApiContext } from "./context.ts";
import {
  acceptedResponse,
  type HttpRequest,
  type HttpResponse,
  jsonResponse,
  noContentResponse,
} from "./http.ts";
import { requireIdempotencyKey, withIdempotency } from "./idempotency.ts";
import { CapabilityUnavailableError, PROBLEM_TYPE_BASE, UnprocessableError } from "./problem.ts";

/* -------------------------------------------------------------------------- */
/* Capability gating                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Assert the running agent advertises `method`, else 501 capability-unavailable.
 * Gated on capabilities() (CONFIG#CAPS), never on a CLI version.
 */
async function requireCapability(ctx: ApiContext, method: string): Promise<void> {
  const caps = await ctx.capabilities();
  if (!hasExtensionMethod(caps, method)) {
    throw new CapabilityUnavailableError(method);
  }
}

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

export async function getCapabilities(
  ctx: ApiContext,
  _req: HttpRequest,
  _principal: Principal,
): Promise<HttpResponse> {
  const caps = await ctx.repo.getCaps();
  const normalized = caps ? deriveCapabilities(caps.initializeResult) : null;
  const cliVersion = await ctx.kiroCliVersion();
  const { items } = await ctx.service.repo.listSessionsByUser(_principal.sub, { limit: 100 });
  const activeSessionCount = items.filter((s) =>
    ["provisioning", "running", "idle", "awaiting_permission"].includes(s.status),
  ).length;

  return jsonResponse(200, {
    capabilities: normalized ?? {
      extensionMethods: [],
      sessionSources: [],
      listScopes: [],
      executionTargets: [],
      configOptions: [],
      modes: [],
      models: [],
      replayMarking: false,
    },
    kiroCliVersion: cliVersion,
    activeSessionCount,
  });
}

export async function listModels(ctx: ApiContext): Promise<HttpResponse> {
  const models = await ctx.repo.getModels();
  return jsonResponse(200, {
    models: models?.models ?? [],
    source: models?.source ?? null,
  });
}

export async function listSessions(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const query = ListSessionsQuerySchema.parse(req.query);
  const result = await svcListSessions(ctx.service, principal, {
    limit: query.limit,
    ...(query.cursor ? { cursor: query.cursor } : {}),
    ...(query.status ? { status: query.status } : {}),
  });
  return jsonResponse(200, result);
}

export async function getSession(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const view = await svcGetSession(ctx.service, principal, req.params.id);
  return jsonResponse(200, view);
}

export async function getTurn(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  // Ownership is enforced by reading the session first (hides existence on 404).
  await svcGetSession(ctx.service, principal, req.params.id);
  const turn = await ctx.repo.getTurn(req.params.id, req.params.turnId);
  if (!turn) {
    return jsonResponse(404, {
      type: `${PROBLEM_TYPE_BASE}/turn-not-found`,
      title: "Turn Not Found",
      status: 404,
    });
  }
  return jsonResponse(200, {
    id: turn.id,
    sessionId: turn.sessionId,
    status: turn.status,
    stopReason: turn.stopReason,
    startedAt: turn.startedAt,
    endedAt: turn.endedAt,
    metering: turn.metering,
  });
}

export async function getEvents(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const query = EventsQuerySchema.parse(normalizeEventsQuery(req.query));
  // Long-polls up to query.wait seconds; turnStatus comes from the session row
  // so a long-poller knows when to stop.
  const page = await readEvents(ctx.service, principal, req.params.id, query);
  return jsonResponse(200, page);
}

export async function listPermissions(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  await svcGetSession(ctx.service, principal, req.params.id);
  const status = req.query.status === "pending" ? "pending" : undefined;
  const perms = await ctx.repo.queryPermissions(req.params.id, status ? { status } : {});
  return jsonResponse(200, {
    permissions: perms.map((p) => ({
      requestId: p.requestId,
      toolCallId: p.toolCallId,
      toolCall: p.toolCall,
      options: p.options,
      consent: p.consent,
      status: p.status,
      answer: p.answer,
    })),
  });
}

/* -------------------------------------------------------------------------- */
/* Writes                                                                     */
/* -------------------------------------------------------------------------- */

export async function postLaunchSession(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const key = requireIdempotencyKey(req);
  const body = LaunchSessionSchema.parse(parseJsonBody(req));
  return withIdempotency(ctx.repo, principal.sub, key, async () => {
    const view = await launchSession(ctx.service, principal, body);
    // Launch enqueues a turn as part of its command; expose the launch path.
    ctx.obs.sessionLaunched("launch");
    ctx.obs.info("session launched", { sessionId: view.id });
    return acceptedResponse({ sessionId: view.id, turnId: view.activeTurnId });
  });
}

export async function postAdoptSession(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const key = requireIdempotencyKey(req);
  const body = AdoptSessionSchema.parse(parseJsonBody(req));
  return withIdempotency(ctx.repo, principal.sub, key, async () => {
    const view = await adoptSession(ctx.service, principal, body);
    ctx.obs.sessionLaunched("adopt");
    ctx.obs.info("session adopted", { sessionId: view.id });
    return acceptedResponse(view);
  });
}

export async function deleteSessionRoute(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const key = requireIdempotencyKey(req);
  return withIdempotency(ctx.repo, principal.sub, key, async () => {
    await deleteSession(ctx.service, principal, req.params.id);
    return acceptedResponse({ sessionId: req.params.id, status: "deleting" });
  });
}

export async function postTurn(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const key = requireIdempotencyKey(req);
  const body = CreateTurnSchema.parse(parseJsonBody(req));
  return withIdempotency(ctx.repo, principal.sub, key, async () => {
    const turn = await sendPrompt(ctx.service, principal, req.params.id, {
      prompt: body.prompt,
      whenBusy: body.whenBusy,
    });
    return acceptedResponse(turn);
  });
}

export async function postCancel(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const key = requireIdempotencyKey(req);
  return withIdempotency(ctx.repo, principal.sub, key, async () => {
    await cancelTurn(ctx.service, principal, req.params.id);
    return acceptedResponse({ sessionId: req.params.id, status: "cancelling" });
  });
}

export async function postAnswerPermission(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  const key = requireIdempotencyKey(req);
  const body = AnswerPermissionSchema.parse(parseJsonBody(req));
  return withIdempotency(ctx.repo, principal.sub, key, async () => {
    try {
      await answerPermission(ctx.service, principal, req.params.id, req.params.requestId, body);
    } catch (err) {
      // A non-offered optionId is a 422, not a generic 409.
      if (
        err instanceof Error &&
        err.name === "InvalidStateError" &&
        err.message.includes("optionId not offered")
      ) {
        throw new UnprocessableError(err.message, "option-not-offered");
      }
      throw err;
    }
    return acceptedResponse({ requestId: req.params.requestId, status: "answered" });
  });
}

export async function patchConfig(
  ctx: ApiContext,
  req: HttpRequest,
  principal: Principal,
): Promise<HttpResponse> {
  // model/effort are config options; mode is a mode change. Gate the config
  // option path on the advertised extension method.
  const body = ConfigPatchSchema.parse(parseJsonBody(req));
  if (body.model !== undefined || body.effort !== undefined) {
    await requireCapability(ctx, "_kiro/setConfigOption");
  }
  await setConfig(ctx.service, principal, req.params.id, body);
  return acceptedResponse({ sessionId: req.params.id, status: "configuring" });
}

export { noContentResponse };

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function parseJsonBody(req: HttpRequest): unknown {
  if (!req.body || req.body.trim() === "") {
    return {};
  }
  return JSON.parse(req.body);
}

/** API Gateway joins repeated query params with commas; split `types`. */
function normalizeEventsQuery(query: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...query };
  if (typeof query.types === "string" && query.types.length > 0) {
    out.types = query.types.split(",").filter(Boolean);
  }
  return out;
}
