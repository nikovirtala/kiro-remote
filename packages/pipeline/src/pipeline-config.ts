import type { Node } from "constructs";

/**
 * Deploy-time configuration of the pipeline stack: CDK context with defaults, so `cdk synth` runs
 * with no account (what the tests and CI do). The pipeline stack is deployed by hand once (the
 * bootstrap), so the settings without a default are checked by `scripts/pipeline.sh bootstrap`.
 */
export interface PipelineConfig {
  /**
   * ARN of the CodeConnections connection to GitHub. A person creates it and finishes its handshake
   * in the console (CloudFormation can only create it PENDING). Empty = a placeholder ARN, for the
   * credential-free synth: the bootstrap refuses to deploy without a real one. Context:
   * `pipelineConnectionArn`.
   */
  readonly connectionArn: string;
  /** `owner/repo`. Context: `pipelineRepository`. */
  readonly repository: string;
  /** The branch whose pushes deploy. Context: `pipelineBranch`. */
  readonly branch: string;
  /** Who gets the notifications of a failed run. Empty = none subscribed. Context: `pipelineAlarmEmail`. */
  readonly alarmEmail: string;
  /** Minutes CloudFormation watches the rollback-trigger alarms after a deploy (0 to 180). Context: `pipelineMonitoringMinutes`. */
  readonly monitoringMinutes: number;
}

export const PLACEHOLDER_CONNECTION_ARN =
  "arn:aws:codeconnections:eu-north-1:000000000000:connection/00000000-0000-0000-0000-000000000000";
export const DEFAULT_MONITORING_MINUTES = 10;

function str(node: Node, key: string, fallback: string): string {
  const v = node.tryGetContext(key) as unknown;
  if (v === undefined || v === null || String(v).trim() === "") return fallback;
  return String(v).trim();
}

export function readPipelineContext(node: Node): PipelineConfig {
  const minutes = Number(
    str(node, "pipelineMonitoringMinutes", String(DEFAULT_MONITORING_MINUTES)),
  );
  return {
    connectionArn: str(node, "pipelineConnectionArn", PLACEHOLDER_CONNECTION_ARN),
    repository: str(node, "pipelineRepository", "nikovirtala/kiro-remote"),
    branch: str(node, "pipelineBranch", "main"),
    alarmEmail: str(node, "pipelineAlarmEmail", ""),
    monitoringMinutes:
      Number.isInteger(minutes) && minutes >= 0 && minutes <= 180
        ? minutes
        : DEFAULT_MONITORING_MINUTES,
  };
}
