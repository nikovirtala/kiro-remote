/**
 * @nikovirtala/kiro-remote-cdk
 *
 * The reusable KiroRemote construct (the whole control plane as one resource
 * graph) and the KiroRemoteAuth construct (re-exported from @nikovirtala/kiro-remote-auth).
 * Consumers import them via the `./cdk` subpath export:
 *
 *   import { KiroRemote, KiroRemoteAuth } from "kiro-remote/cdk";
 *
 * `bin/app.ts` is a thin consumer that instantiates the stack with props.
 */

export const PACKAGE_NAME = "@nikovirtala/kiro-remote-cdk";

// Re-export the standalone Cognito facade construct for direct reuse.
export {
  KiroRemoteAuth,
  type KiroRemoteAuthProps,
  type PreRegisteredClientProps,
} from "@nikovirtala/kiro-remote-auth";
export {
  DEFAULT_CIMD_ALLOWED_HOST,
  DEFAULT_EVENT_TTL_DAYS,
  DEFAULT_MAX_CLOUD_SESSIONS,
  DEFAULT_PERMISSION_TIMEOUT,
  KiroRemote,
  type KiroRemoteProps,
} from "./construct.ts";
export { applyAwsSolutionsChecks, suppressIntentionalFindings } from "./nag.ts";
export { KiroRemoteStack, type KiroRemoteStackProps } from "./stack.ts";
