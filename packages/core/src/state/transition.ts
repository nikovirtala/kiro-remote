/**
 * The pure session/turn state machine.
 *
 * `transition(state, event)` is the ONLY place a session or turn changes
 * status. It is a pure function: same input, same output, no side effects. It
 * throws {@link IllegalTransitionError} on any move the contract forbids.
 *
 * The important contract rules enforced here:
 *  - A turn settles ONLY on the prompt response/error (`prompt.response` /
 *    `prompt.error`), never on a `turn_end` session_info_update.
 *  - `stopReason: "refusal"` maps a completing turn to `refused`.
 *  - A pending permission moves the session to `awaiting_permission` and back.
 */

import type { SessionStatus, TurnStatus } from "../domain.ts";

export interface MachineState {
  session: SessionStatus;
  /** Status of the active turn, or null when no turn is active. */
  turn: TurnStatus | null;
}

/**
 * Events that drive the machine. These are control-plane lifecycle signals,
 * distinct from the normalized stream events (which are append-only data).
 */
export type MachineEvent =
  | { kind: "provisioned" } // bridge reports the cloud session is live
  | { kind: "provision_failed" }
  | { kind: "prompt.sent" } // session/prompt dispatched -> turn running
  | { kind: "prompt.queued" } // prompt accepted but queued behind active turn
  | { kind: "prompt.response"; stopReason?: string } // the ONLY turn settler
  | { kind: "prompt.error" }
  | { kind: "cancel.requested" }
  | { kind: "permission.requested" }
  | { kind: "permission.answered" }
  | { kind: "turn_end" } // session_info_update turn_end: must NOT settle a turn
  | { kind: "deleted" };

export class IllegalTransitionError extends Error {
  readonly from: MachineState;
  readonly event: MachineEvent;

  constructor(from: MachineState, event: MachineEvent) {
    super(
      `illegal transition: cannot apply "${event.kind}" from session=${from.session} turn=${from.turn ?? "none"}`,
    );
    this.name = "IllegalTransitionError";
    this.from = from;
    this.event = event;
  }
}

function illegal(state: MachineState, event: MachineEvent): never {
  throw new IllegalTransitionError(state, event);
}

/** Map a stopReason to the settled turn status. */
function settledTurnStatus(stopReason: string | undefined): TurnStatus {
  if (stopReason === "refusal") {
    return "refused";
  }
  if (stopReason === "cancelled") {
    return "cancelled";
  }
  return "completed";
}

/**
 * Apply one event to the machine, returning the next state. Pure and total:
 * either returns a valid next state or throws.
 */
export function transition(state: MachineState, event: MachineEvent): MachineState {
  // Terminal states accept nothing further.
  if (state.session === "deleted" || state.session === "failed") {
    illegal(state, event);
  }

  switch (event.kind) {
    case "provisioned": {
      if (state.session !== "provisioning") {
        illegal(state, event);
      }
      return { session: "idle", turn: null };
    }

    case "provision_failed": {
      if (state.session !== "provisioning") {
        illegal(state, event);
      }
      return { session: "failed", turn: null };
    }

    case "prompt.sent": {
      // A new turn may only start when the session is idle and no turn runs.
      if (state.session !== "idle" || state.turn !== null) {
        illegal(state, event);
      }
      return { session: "running", turn: "running" };
    }

    case "prompt.queued": {
      // Queue a prompt only while a turn is already active.
      if (state.session !== "running" || state.turn !== "running") {
        illegal(state, event);
      }
      return state;
    }

    case "prompt.response": {
      // The ONLY settler. Requires an active (running) turn.
      if (state.turn !== "running" || state.session !== "running") {
        illegal(state, event);
      }
      return { session: "idle", turn: settledTurnStatus(event.stopReason) };
    }

    case "prompt.error": {
      if (state.turn !== "running" || state.session === "idle") {
        illegal(state, event);
      }
      return { session: "idle", turn: "failed" };
    }

    case "cancel.requested": {
      // Cancel is legal while a turn is running or a permission is pending.
      if (state.turn !== "running") {
        illegal(state, event);
      }
      // The turn stays running until the prompt response settles it as
      // cancelled; cancel only requests. Session returns to running posture
      // (if awaiting permission) so the prompt can resolve.
      return { session: "running", turn: "running" };
    }

    case "permission.requested": {
      if (state.turn !== "running") {
        illegal(state, event);
      }
      return { session: "awaiting_permission", turn: "running" };
    }

    case "permission.answered": {
      if (state.session !== "awaiting_permission" || state.turn !== "running") {
        illegal(state, event);
      }
      return { session: "running", turn: "running" };
    }

    case "turn_end": {
      // A turn_end info update must NOT settle the turn. The machine state is
      // intentionally unchanged; only prompt.response/prompt.error settle.
      return state;
    }

    case "deleted": {
      return { session: "deleted", turn: null };
    }

    default: {
      // Exhaustiveness guard.
      return illegal(state, event as MachineEvent);
    }
  }
}

/** The initial state for a freshly launched session. */
export function initialState(): MachineState {
  return { session: "provisioning", turn: null };
}
