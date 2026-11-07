/**
 * Commands enqueued to the SQS FIFO queue. The bridge consumes these; every
 * command carries the caller `sub` and is grouped by `sessionId`
 * (MessageGroupId) so a session's commands are processed in order.
 */

export interface CommandBase {
  /** Cognito sub of the caller who issued the command. */
  sub: string;
  /** Session the command targets (the FIFO MessageGroupId). */
  sessionId: string;
  /** Idempotency / dedupe id (the FIFO MessageDeduplicationId). */
  commandId: string;
}

export interface LaunchCommand extends CommandBase {
  kind: "launch";
  prompt: string;
  repos: string[];
  title?: string;
  mode?: string;
  model?: string;
  effort?: string;
}

export interface PromptCommand extends CommandBase {
  kind: "prompt";
  turnId: string;
  prompt: string;
  whenBusy: "steer" | "queue" | "reject";
}

export interface SteerCommand extends CommandBase {
  kind: "steer";
  content: string;
}

export interface CancelCommand extends CommandBase {
  kind: "cancel";
}

export interface AnswerPermissionCommand extends CommandBase {
  kind: "answerPermission";
  requestId: string;
  optionId: string;
  consent?: { scope: string; resource: string; workspaceRoot: string };
}

export interface SetConfigCommand extends CommandBase {
  kind: "setConfig";
  model?: string;
  effort?: string;
  mode?: string;
}

export interface DeleteCommand extends CommandBase {
  kind: "delete";
}

export interface AdoptCommand extends CommandBase {
  kind: "adopt";
  /** The existing Kiro session id to load into this control-plane session. */
  kiroSessionId: string;
}

export type Command =
  | LaunchCommand
  | PromptCommand
  | SteerCommand
  | CancelCommand
  | AnswerPermissionCommand
  | SetConfigCommand
  | DeleteCommand
  | AdoptCommand;

/** Abstraction over the SQS FIFO queue so the service stays pure and testable. */
export interface CommandQueue {
  enqueue(command: Command): Promise<void>;
}
