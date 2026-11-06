/**
 * Transport-agnostic HTTP request/response shapes for the OAuth facade
 * handlers. The handlers are pure functions of (request, deps) so they can be
 * driven by Lambda/API Gateway adapters in packages/api or by the in-process
 * tests here with zero network.
 */

/** A minimal, framework-free HTTP request. */
export interface FacadeRequest {
  method: string;
  /** Path without query string, e.g. "/oauth/authorize". */
  path: string;
  /** Parsed query-string parameters (first value wins for repeats). */
  query: Record<string, string>;
  /** Lower-cased header names mapped to their value. */
  headers: Record<string, string>;
  /** Raw request body (for POST form bodies). */
  body?: string;
}

/** A minimal, framework-free HTTP response. */
export interface FacadeResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** Build a JSON response with the given status and object body. */
export function jsonResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): FacadeResponse {
  return {
    status,
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify(body),
  };
}

/** Build a 302 redirect response to the given absolute URL. */
export function redirectResponse(location: string): FacadeResponse {
  return {
    status: 302,
    headers: { location, "cache-control": "no-store" },
    body: "",
  };
}

/**
 * Build a minimal HTML error page. Used ONLY for errors that occur before the
 * client's redirect_uri has been validated, so we never redirect to an
 * attacker-controlled URI.
 */
export function errorPageResponse(
  status: number,
  error: string,
  description: string,
): FacadeResponse {
  const safe = (s: string) =>
    s.replace(/[&<>"']/g, (c) => {
      switch (c) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: `<!doctype html><html><head><meta charset="utf-8"><title>Authorization error</title></head><body><h1>${safe(error)}</h1><p>${safe(description)}</p></body></html>`,
  };
}

/** Parse an application/x-www-form-urlencoded body into a flat record. */
export function parseForm(body: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!body) {
    return out;
  }
  const params = new URLSearchParams(body);
  for (const [key, value] of params.entries()) {
    if (!(key in out)) {
      out[key] = value;
    }
  }
  return out;
}
