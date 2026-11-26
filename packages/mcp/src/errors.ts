/**
 * Errors both the tools and the extensions raise, in one module so neither has to
 * import the other.
 */

import { ProtocolError, ProtocolErrorCode } from "@modelcontextprotocol/server";

/**
 * A ProtocolError subtype that carries the OAuth `insufficient_scope` error so the
 * JSON-RPC error payload is distinguishable from a generic tool failure.
 */
export class InsufficientScopeError extends ProtocolError {
  constructor(neededScope?: string) {
    super(ProtocolErrorCode.InvalidRequest, "insufficient_scope", {
      error: "insufficient_scope",
      ...(neededScope ? { scope: neededScope } : {}),
    });
    this.name = "InsufficientScopeError";
  }
}
