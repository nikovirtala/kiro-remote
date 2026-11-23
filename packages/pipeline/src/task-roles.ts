import * as iam from "aws-cdk-lib/aws-iam";
import { SERVICE_NAME_PREFIX, TASK_ROLE_PREFIX } from "./names.ts";

/**
 * The roles deployment tasks run as (`tasks/`, AGENTS.md). A task declares one in its `--needs`; the
 * pipeline's runner assumes it, and no task runs as the deploy role. They live in the pipeline stack,
 * not the service stack, so they survive a destroy of the service and widen nothing in its trust.
 *
 * Each role is scoped to the names its task touches, with no wildcard on an action family. A pull
 * request that adds a task adds its role here, its cases (with a refusal beside every grant) to
 * `scripts/simulate-pipeline-policy.ts`, and runs the simulator.
 */
export interface TaskRoleDef {
  /** Always `kiro-remote-deployment-task-<name>`. */
  readonly name: string;
  readonly description: string;
  readonly statements: (where: { account: string; region: string }) => iam.PolicyStatement[];
}

/** The service table, as CloudFormation names it (`<stack>-KiroRemoteTable<hash>-<suffix>`). */
const serviceTable = ({ account, region }: { account: string; region: string }): string =>
  `arn:aws:dynamodb:${region}:${account}:table/${SERVICE_NAME_PREFIX}KiroRemoteTable*`;

export const TASK_ROLES: readonly TaskRoleDef[] = [
  {
    name: `${TASK_ROLE_PREFIX}index-sweep`,
    description:
      "Task 1: gives the open waits and linked PRs that predate GSI2 their index keys. It scans GSI1 for keys and updates those items; it reads no item and touches no other table.",
    statements: (where) => [
      // The scan asks for keys only (ProjectionExpression), and runs on the index, never the table.
      new iam.PolicyStatement({
        sid: "ScanTheIndexForKeys",
        actions: ["dynamodb:Scan"],
        resources: [`${serviceTable(where)}/index/GSI1`],
      }),
      new iam.PolicyStatement({
        sid: "AddTheIndexKeys",
        actions: ["dynamodb:UpdateItem"],
        resources: [serviceTable(where)],
      }),
    ],
  },
];

export function isTaskRoleName(name: string): boolean {
  return (
    name.startsWith(TASK_ROLE_PREFIX) && /^[a-z0-9-]+$/.test(name.slice(TASK_ROLE_PREFIX.length))
  );
}
