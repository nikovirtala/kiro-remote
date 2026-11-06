/**
 * Reconnect planning.
 *
 * The migration guide is explicit: on reconnect, register the `session/update`
 * handler BEFORE calling `session/load`, re-send client-owned inputs
 * (cwd/additionalDirectories/mcpServers, which V3 does NOT persist), do NOT use
 * `noReplay` for remote sessions, and NEVER auto-resend the prompt even if
 * replay shows the prior turn completed.
 *
 * {@link planReconnect} returns a declarative, side-effect-free plan that the
 * bridge executes in order. Keeping it pure makes the "never resend a prompt"
 * guarantee unit-testable.
 */

import type { SessionInputs } from "./index.ts";

export interface ReconnectPlan {
  /** Register the session/update handler before loading (always true). */
  registerUpdateHandlerFirst: true;
  /** Re-send these client-owned inputs on load. */
  loadInputs: SessionInputs;
  /** Whether to request noReplay. Always false for remote sessions. */
  noReplay: boolean;
  /** Whether to resend the last prompt. ALWAYS false. */
  resendPrompt: false;
}

export interface ReconnectOptions {
  inputs: SessionInputs;
  /** "remote" sessions must not use noReplay and must receive live updates. */
  source: "local" | "remote";
}

export function planReconnect(opts: ReconnectOptions): ReconnectPlan {
  return {
    registerUpdateHandlerFirst: true,
    loadInputs: opts.inputs,
    // Remote loads skip the live update stream when noReplay is used, so never
    // set it for remote. Local reconnects also want current-state updates.
    noReplay: false,
    resendPrompt: false,
  };
}
