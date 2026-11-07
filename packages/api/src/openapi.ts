/**
 * GET /openapi.json: an OpenAPI 3.1 document generated from the SAME core zod
 * objects that validate requests and that drive the MCP tool input schemas.
 *
 * Security: a single OAuth 2.1 `authorizationCode` scheme whose endpoints are
 * the facade's. Each operation declares the scope(s) it needs, derived from
 * authorize()'s action->scope mapping via {@link requiredScope} so the document
 * can NEVER drift from the enforced authorization (a test asserts this parity).
 */

import { type FacadeConfig, facadeEndpoints } from "@nikovirtala/auth";
import {
  type Action,
  AdoptSessionSchema,
  AnswerPermissionSchema,
  ConfigPatchSchema,
  CreateTurnSchema,
  EventSchema,
  EventsQuerySchema,
  type JsonSchema,
  LaunchSessionSchema,
  ListSessionsQuerySchema,
  requiredScope,
  SessionSchema,
  TurnSchema,
  toOpenApiSchema,
} from "@nikovirtala/core";

/** The resource-server scope identifier prefix advertised in the scheme. */
function scopedName(resourceIdentifier: string, scope: string): string {
  return `${resourceIdentifier}/${scope}`;
}

/** Build the per-operation security requirement for an action. */
function securityFor(resourceIdentifier: string, action: Action): Array<Record<string, string[]>> {
  return [{ oauth2: [scopedName(resourceIdentifier, requiredScope(action))] }];
}

/** An OpenAPI operation object (only the fields we populate). */
interface Operation {
  operationId: string;
  summary: string;
  security?: Array<Record<string, string[]>>;
  requestBody?: unknown;
  parameters?: unknown[];
  responses: Record<string, unknown>;
}

function jsonBody(schema: JsonSchema, required = true): unknown {
  return { required, content: { "application/json": { schema } } };
}

function jsonResponseSpec(description: string, schema?: JsonSchema): unknown {
  return {
    description,
    ...(schema ? { content: { "application/json": { schema } } } : {}),
  };
}

const PROBLEM_RESPONSE = {
  description: "Error (RFC 9457 problem+json)",
  content: {
    "application/problem+json": {
      schema: {
        type: "object",
        properties: {
          type: { type: "string" },
          title: { type: "string" },
          status: { type: "integer" },
          detail: { type: "string" },
        },
        required: ["type", "title", "status"],
      },
    },
  },
};

const ACCEPTED_LAUNCH = {
  type: "object",
  properties: { sessionId: { type: "string" }, turnId: { type: ["string", "null"] } },
  required: ["sessionId"],
};

/** Build the complete OpenAPI 3.1 document. */
export function buildOpenApiDocument(config: FacadeConfig): Record<string, unknown> {
  const ri = config.mcpResource;
  const ep = facadeEndpoints(config);

  const sessionSchema = toOpenApiSchema(SessionSchema);
  const turnSchema = toOpenApiSchema(TurnSchema);
  const eventSchema = toOpenApiSchema(EventSchema);

  const idempotencyHeader = {
    name: "Idempotency-Key",
    in: "header",
    required: true,
    schema: { type: "string" },
    description: "Required on every POST; stored 24h per subject for replay-safe retries.",
  };

  const errorResponses = {
    "400": PROBLEM_RESPONSE,
    "401": PROBLEM_RESPONSE,
    "403": PROBLEM_RESPONSE,
    "404": PROBLEM_RESPONSE,
    "409": PROBLEM_RESPONSE,
    "422": PROBLEM_RESPONSE,
    "429": PROBLEM_RESPONSE,
    "501": PROBLEM_RESPONSE,
  };

  const paths: Record<string, Record<string, Operation>> = {
    "/capabilities": {
      get: {
        operationId: "getCapabilities",
        summary: "Advertised capabilities, kiro-cli version, and active session count.",
        security: securityFor(ri, "read"),
        responses: { "200": jsonResponseSpec("Capabilities snapshot"), ...errorResponses },
      },
    },
    "/models": {
      get: {
        operationId: "listModels",
        summary: "Models offered by the running agent.",
        security: securityFor(ri, "read"),
        responses: { "200": jsonResponseSpec("Model list"), ...errorResponses },
      },
    },
    "/sessions": {
      get: {
        operationId: "listSessions",
        summary: "List the caller's sessions.",
        security: securityFor(ri, "read"),
        parameters: queryParams(toOpenApiSchema(ListSessionsQuerySchema)),
        responses: {
          "200": jsonResponseSpec("Session page", {
            type: "object",
            properties: {
              sessions: { type: "array", items: sessionSchema },
              cursor: { type: "string" },
            },
            required: ["sessions"],
          }),
          ...errorResponses,
        },
      },
      post: {
        operationId: "launchSession",
        summary: "Launch a new cloud session (enqueues a command).",
        security: securityFor(ri, "launch"),
        parameters: [idempotencyHeader],
        requestBody: jsonBody(toOpenApiSchema(LaunchSessionSchema)),
        responses: { "202": jsonResponseSpec("Accepted", ACCEPTED_LAUNCH), ...errorResponses },
      },
    },
    "/sessions/adopt": {
      post: {
        operationId: "adoptSession",
        summary: "Adopt an existing Kiro cloud session.",
        security: securityFor(ri, "launch"),
        parameters: [idempotencyHeader],
        requestBody: jsonBody(toOpenApiSchema(AdoptSessionSchema)),
        responses: { "202": jsonResponseSpec("Accepted", sessionSchema), ...errorResponses },
      },
    },
    "/sessions/{id}": {
      get: {
        operationId: "getSession",
        summary: "Fetch one session.",
        security: securityFor(ri, "read"),
        parameters: [pathParam("id")],
        responses: { "200": jsonResponseSpec("Session", sessionSchema), ...errorResponses },
      },
      delete: {
        operationId: "deleteSession",
        summary: "Permanently delete a session and its cloud sandbox.",
        security: securityFor(ri, "delete"),
        parameters: [pathParam("id")],
        responses: { "202": jsonResponseSpec("Accepted"), ...errorResponses },
      },
    },
    "/sessions/{id}/turns": {
      post: {
        operationId: "createTurn",
        summary: "Send a prompt as a new turn (enqueues a command).",
        security: securityFor(ri, "prompt"),
        parameters: [pathParam("id"), idempotencyHeader],
        requestBody: jsonBody(toOpenApiSchema(CreateTurnSchema)),
        responses: { "202": jsonResponseSpec("Accepted", turnSchema), ...errorResponses },
      },
    },
    "/sessions/{id}/turns/{turnId}": {
      get: {
        operationId: "getTurn",
        summary: "Fetch one turn.",
        security: securityFor(ri, "read"),
        parameters: [pathParam("id"), pathParam("turnId")],
        responses: { "200": jsonResponseSpec("Turn", turnSchema), ...errorResponses },
      },
    },
    "/sessions/{id}/events": {
      get: {
        operationId: "getEvents",
        summary: "Long-poll the session's cursor-ordered event log.",
        security: securityFor(ri, "read"),
        parameters: [pathParam("id"), ...queryParams(toOpenApiSchema(EventsQuerySchema))],
        responses: {
          "200": jsonResponseSpec("Events page", {
            type: "object",
            properties: {
              events: { type: "array", items: eventSchema },
              nextCursor: { type: "integer" },
              turnStatus: { type: ["string", "null"] },
            },
            required: ["events", "nextCursor"],
          }),
          ...errorResponses,
        },
      },
    },
    "/sessions/{id}/cancel": {
      post: {
        operationId: "cancelTurn",
        summary: "Cancel the active turn (enqueues a command).",
        security: securityFor(ri, "cancel"),
        parameters: [pathParam("id"), idempotencyHeader],
        responses: { "202": jsonResponseSpec("Accepted"), ...errorResponses },
      },
    },
    "/sessions/{id}/permissions": {
      get: {
        operationId: "listPermissions",
        summary: "List the session's permission requests.",
        security: securityFor(ri, "read"),
        parameters: [
          pathParam("id"),
          { name: "status", in: "query", required: false, schema: { type: "string" } },
        ],
        responses: {
          "200": jsonResponseSpec("Permissions", {
            type: "object",
            properties: { permissions: { type: "array", items: { type: "object" } } },
            required: ["permissions"],
          }),
          ...errorResponses,
        },
      },
    },
    "/sessions/{id}/permissions/{requestId}": {
      post: {
        operationId: "answerPermission",
        summary: "Answer a pending permission request (enqueues a command).",
        security: securityFor(ri, "answerPermission"),
        parameters: [pathParam("id"), pathParam("requestId"), idempotencyHeader],
        requestBody: jsonBody(toOpenApiSchema(AnswerPermissionSchema)),
        responses: { "202": jsonResponseSpec("Accepted"), ...errorResponses },
      },
    },
    "/sessions/{id}/config": {
      patch: {
        operationId: "setConfig",
        summary: "Change session model/effort/mode (enqueues a command).",
        security: securityFor(ri, "config"),
        parameters: [pathParam("id")],
        requestBody: jsonBody(toOpenApiSchema(ConfigPatchSchema)),
        responses: { "202": jsonResponseSpec("Accepted"), ...errorResponses },
      },
    },
  };

  return {
    openapi: "3.1.0",
    info: { title: "kiro-remote control plane", version: "1.0.0" },
    servers: [{ url: `${config.publicBaseUrl.replace(/\/+$/, "")}/v1` }],
    components: {
      securitySchemes: {
        oauth2: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: ep.authorizationEndpoint,
              tokenUrl: ep.tokenEndpoint,
              refreshUrl: ep.tokenEndpoint,
              scopes: {
                [scopedName(ri, "sessions:read")]: "Read sessions, turns, and events",
                [scopedName(ri, "sessions:write")]:
                  "Launch, prompt, steer, cancel, configure, and answer permissions",
                [scopedName(ri, "sessions:delete")]: "Delete sessions",
              },
            },
          },
        },
      },
    },
    security: [{ oauth2: [] }],
    paths,
  };
}

function pathParam(name: string): unknown {
  return { name, in: "path", required: true, schema: { type: "string" } };
}

/** Flatten a JSON Schema object's properties into OpenAPI query parameters. */
function queryParams(schema: JsonSchema): unknown[] {
  const props = (schema.properties as Record<string, JsonSchema> | undefined) ?? {};
  const required = new Set((schema.required as string[] | undefined) ?? []);
  return Object.entries(props).map(([name, propSchema]) => ({
    name,
    in: "query",
    required: required.has(name),
    schema: propSchema,
  }));
}
