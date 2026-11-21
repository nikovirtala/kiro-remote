import type * as iam from "aws-cdk-lib/aws-iam";
import { TASK_ROLE_PREFIX } from "./names.ts";

/**
 * The roles deployment tasks run as (`tasks/`, AGENTS.md). A task declares one in its `--needs`; the
 * pipeline's runner assumes it, and no task runs as the deploy role. They live in the pipeline stack,
 * not the service stack, so they survive a destroy of the service and widen nothing in its trust.
 *
 * Each role is scoped to the names its task touches, with no wildcard on an action family. A pull
 * request that adds a task adds its role here, its cases (with a refusal beside every grant) to
 * `scripts/simulate-pipeline-policy.ts`, and runs the simulator. There is no task yet.
 */
export interface TaskRoleDef {
  /** Always `kiro-remote-deployment-task-<name>`. */
  readonly name: string;
  readonly description: string;
  readonly statements: (where: { account: string; region: string }) => iam.PolicyStatement[];
}

export const TASK_ROLES: readonly TaskRoleDef[] = [];

export function isTaskRoleName(name: string): boolean {
  return (
    name.startsWith(TASK_ROLE_PREFIX) && /^[a-z0-9-]+$/.test(name.slice(TASK_ROLE_PREFIX.length))
  );
}
