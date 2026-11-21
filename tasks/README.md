# Deployment tasks

A deployment task is a one-off step that runs once, after a deploy of KiroRemoteStack has passed its
smoke checks: seeding a table, a first run, a migration of stored records. The pipeline runs the tasks
in this directory whose ids are not in the ledger (`kiro-remote-deployment-ledger`), in task order,
each with a dry run first, and stops at the first failure: the pipeline freezes and does **not** roll
back (a task moves data forward, and an older commit does not undo it). A task in the ledger never
runs again; deleting its file afterwards is tidying up. There is no task yet.

The runner is [`@nikovirtala/deployment`](https://github.com/nikovirtala/ark/tree/main/packages/deployment);
`deploy.toml` at the repository root says where this directory is.

## A task is a file

Named by a task number and a slug, `<n>[.<m>]-<slug>[.<ext>]`, for example `1-seed-capabilities.ts`
or `2.1-backfill-ttl`. A file that does not match the rule fails the run, so a task is never skipped
by a typo.

## The protocol

A task is any executable that answers three flags:

| Flag        | Prints                                                                     | Exit                |
| ----------- | -------------------------------------------------------------------------- | ------------------- |
| `--needs`   | one JSON line: `{"role": "...", "description": "...", "outputs": ["..."]}` | 0                   |
| `--dry-run` | what the run would do, changing nothing; a last line `{"summary": "..."}`  | non-zero on failure |
| `--run`     | anything, then a last line `{"summary": "..."}`                            | non-zero on failure |

It runs in the repository root with its declared role's keys in its environment, the commit in
`DEPLOY_TASK_COMMIT` and the stack outputs it declared, as JSON, in `DEPLOY_TASK_OUTPUTS`.

A TypeScript module is a task too, run by the package's shim in its own process:

```ts
// tasks/1-seed-capabilities.ts
export const needs = {
  role: "kiro-remote-deployment-task-seed-capabilities", // the role it runs as, never the deploy role
  description: "Seeds the engine capabilities record.",
  outputs: ["ApiUrl"], // KiroRemoteStack outputs it reads, given as ctx.outputs
};
export async function dryRun(ctx) {
  return { summary: "would write 1 record" };
}
export async function run(ctx) {
  return { summary: "wrote 1 record" };
} // counts and names, never data
```

## The rules

- **Idempotent.** Running it twice, or after a half-done attempt, ends in the same state.
- **A dry run** that changes nothing and says what the run would do.
- **Least privilege.** The role is `kiro-remote-deployment-task-<name>`, defined in
  `packages/pipeline/src/task-roles.ts` with the names the task touches and no wildcard action. It
  trusts the pipeline's runner only. The pull request adds the role, its cases (with a refusal beside
  every grant) to `packages/pipeline/scripts/simulate-pipeline-policy.ts`, and runs the simulation.
- **No data in the summary.** What the task prints stays in the build's CloudWatch log group; the
  summary, the ledger, the notification and the GitHub deployment hold counts and names only.
- **Tested** with a fake executor, and its dry run against what can be read. The first run in the
  account is the proof of the rest.

By hand, `./scripts/pipeline.sh dry-run <id>` and `./scripts/pipeline.sh run <id>` run one task with
your credentials, and `./scripts/pipeline.sh forget <id>` puts a done task back to pending (after a
destroy and redeploy of the service: the ledger outlives the stack).
