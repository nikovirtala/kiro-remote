/**
 * Minimal, framework-free HTTP shapes for the API Gateway HTTP API (payload
 * format 2.0) and the helpers to parse an event into them. The Lambda handler
 * adapts a raw {@link ApiGatewayProxyEventV2} into an {@link HttpRequest}; all
 * route handlers and the auth facade adapter work against these plain shapes so
 * they stay transport-agnostic and unit-testable without any AWS runtime.
 */

import type { APIGatewayProxyEventV2 } from "aws-lambda";

/** A parsed, framework-free view of an incoming request. */
export interface HttpRequest {
  method: string;
  /** Path WITHOUT the stage prefix and without a query string. */
  path: string;
  /** Raw query string parameters (first value wins; repeats comma-joined by APIGW). */
  query: Record<string, string>;
  /** Lower-cased header names mapped to their (first) value. */
  headers: Record<string, string>;
  /** Decoded raw request body, or undefined when absent. */
  body?: string;
  /** Path parameters captured by our own matcher (not API Gateway's). */
  params: Record<string, string>;
  /** The request host (from the Host / :authority header), no scheme. */
  host: string;
}

/** A framework-free HTTP response the Lambda adapter serializes. */
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Lower-case every header key and coerce values to strings. */
function normalizeHeaders(
  headers: Record<string, string | undefined> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) {
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      out[key.toLowerCase()] = value;
    }
  }
  return out;
}

/** Parse an API Gateway HTTP API v2 event into an {@link HttpRequest}. */
export function parseEvent(event: APIGatewayProxyEventV2): HttpRequest {
  const headers = normalizeHeaders(event.headers);
  const method = event.requestContext?.http?.method ?? "GET";
  const rawPath = event.requestContext?.http?.path ?? event.rawPath ?? "/";
  const body =
    event.body !== undefined && event.isBase64Encoded
      ? Buffer.from(event.body, "base64").toString("utf8")
      : (event.body ?? undefined);

  const query: Record<string, string> = {};
  if (event.queryStringParameters) {
    for (const [key, value] of Object.entries(event.queryStringParameters)) {
      if (value !== undefined) {
        query[key] = value;
      }
    }
  }

  const host = headers.host ?? headers[":authority"] ?? "";

  return {
    method,
    path: stripTrailingSlash(rawPath),
    query,
    headers,
    body,
    params: {},
    host,
  };
}

/** Remove a single trailing slash (but keep the root "/"). */
function stripTrailingSlash(path: string): string {
  if (path.length > 1 && path.endsWith("/")) {
    return path.slice(0, -1);
  }
  return path;
}

/** Build a JSON response with the given status and object body. */
export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** Build a 202 Accepted JSON response. */
export function acceptedResponse(
  body: unknown,
  extraHeaders: Record<string, string> = {},
): HttpResponse {
  return jsonResponse(202, body, extraHeaders);
}

/** Build an empty 204 No Content response. */
export function noContentResponse(extraHeaders: Record<string, string> = {}): HttpResponse {
  return { status: 204, headers: { ...extraHeaders }, body: "" };
}
