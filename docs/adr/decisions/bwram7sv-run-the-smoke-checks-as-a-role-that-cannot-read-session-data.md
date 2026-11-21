# Run the smoke checks as a role that cannot read session data

## Context
The smoke checks run after every deploy, unattended, and what they print is kept in CloudWatch. kiro-remote's table, payload bucket and logs hold users' sessions, prompts and transcripts. A check that could read them could leak them into the build log, and a mistake in a check would then be a data exposure.

## Decision
The smoke checks (packages/pipeline/src/smoke/checks.ts) run as kiro-remote-deployment-smoke, which may describe the two stacks, read the functions' configuration, describe the facade client's branding and kiro-remote's secrets, and count a queue's messages, and nothing else: no table item, no object, no log line, no secret value, no user, no message, no key use. Every AWS call goes through the package's read-only runner. A test runs the checks against a fake account and fails when a call is not an action of the role, and the policy simulation refuses each of those reads beside every grant. What the checks cannot see from configuration they ask the public API over HTTP, without a token.

## Scope
packages/pipeline/src/smoke/ and the smoke role in packages/pipeline/src/pipeline-stack.ts.

## Consequences
- A deploy that breaks the API's contract, its OAuth metadata, a function's runtime or its tracing fails the run and rolls back.
- No check can look at a session or a log line, so a check of behaviour that only shows in data needs another way (a deployment task with its own role, or an end-to-end test outside the pipeline).
- A new AWS call in a check needs its action in the role, which the test enforces.
