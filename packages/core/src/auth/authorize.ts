/**
 * The single authorization decision point.
 *
 * Scope-per-action mapping:
 *   - read                                   -> sessions:read
 *   - launch/prompt/steer/cancel/config/     -> sessions:write
 *     permission-answers
 *   - delete                                 -> sessions:delete
 *
 * Ownership: a session is visible only to its `createdBy` sub. An adopted
 * session takes the adopter's sub, so the same owner check applies uniformly.
 */

import { ForbiddenError, insufficientScope, type Principal } from "./authenticate.ts";

export type Action =
  | "read"
  | "launch"
  | "prompt"
  | "steer"
  | "cancel"
  | "config"
  | "answerPermission"
  | "delete";

/** The resource an action is performed against (a session the caller owns). */
export interface Resource {
  /** The owning sub of the target session, when the action targets one. */
  createdBy?: string;
}

const SCOPE_FOR_ACTION: Record<Action, string> = {
  read: "sessions:read",
  launch: "sessions:write",
  prompt: "sessions:write",
  steer: "sessions:write",
  cancel: "sessions:write",
  config: "sessions:write",
  answerPermission: "sessions:write",
  delete: "sessions:delete",
};

/** Scope required for an action. Exposed for tests and callers. */
export function requiredScope(action: Action): string {
  return SCOPE_FOR_ACTION[action];
}

/**
 * Throw {@link ForbiddenError} unless the principal holds the action's scope
 * and (when a resource is given) owns it. Returns void on success.
 */
export function authorize(principal: Principal, action: Action, resource?: Resource): void {
  const needed = SCOPE_FOR_ACTION[action];
  if (!principal.scopes.includes(needed)) {
    throw insufficientScope(needed);
  }
  if (resource?.createdBy !== undefined && resource.createdBy !== principal.sub) {
    // Owned by someone else: deny without leaking existence via scope hint.
    throw new ForbiddenError();
  }
}
