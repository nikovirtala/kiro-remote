# GitHub wake: pull request activity starts a new turn

When a Kiro cloud session opens a pull request and then waits (usually for
you), GitHub activity on that PR can wake the session with a new turn: the PR
was merged or closed, changes were requested, you commented, or checks failed.
The agent then continues the work, or wraps up.

The feature is **optional and off by default**. Without `GITHUB_APP_SECRET_ARN`
nothing is deployed for it: no webhook route, queues, functions or schedule.

kiro-remote never opens PRs itself. Kiro's agent does, through Kiro's own GitHub
app. kiro-remote only does two things:

1. **Link** the PR to the session that opened it.
2. **Turn GitHub events into prompts**, at a time the session can accept them.

## How it works

```text
GitHub ──webhook──▶ POST /github/webhook ──▶ GitHub queue ──▶ GitHub consumer
         (signature)  verify · dedupe · store   (DLQ)          route() · link · inbox
                                                                    │
bridge: a turn settles ──▶ harvest request ─────────────────────────┤
        │                                                           ▼
        └──────────▶ drainInbox(sessionId) ◀────────────── Inbox (per session)
                          │ idle? one prompt turn for all pending items
                          ▼
                    FIFO command queue ──▶ bridge ──▶ wake turn
```

- **Webhook ingress** (`packages/github/src/ingress.ts`) verifies
  `X-Hub-Signature-256` over the raw body with a constant-time compare, drops
  repos outside `ALLOWED_REPOS`, claims the delivery id (`GHDLV#<id>`, 7 day
  TTL), stores the raw delivery (an S3 pointer above 64 KB), enqueues its id and
  returns 202. A duplicate delivery is a no-op 202.
- **Consumer** (`packages/github/src/consumer.ts`) turns a stored delivery into
  actions with one pure function, `route(event, links, config)`, and applies
  them.
- **Inbox**: wake items are typed rows per session (`SESSION#<id>` /
  `INBOX#<ulid>`). GitHub is the first producer; scheduled launches, issue
  assignment or Slack can write the same rows later.
- **`drainInbox(sessionId)`** (`packages/core/src/service/inbox.ts`) is the
  only code that turns inbox items into a turn. A cloud session rejects a
  mid-turn steer and `whenBusy=queue`
  ([details](./deploy.md#operations-cloud-sessions-do-not-support)), so a wake
  **never** goes into a busy session: it waits as `pending`. The drain runs
  from the consumer (when the session is idle) and from the bridge **every time
  a turn settles** (live, failed, or a catch-up finishing), through one helper
  (`packages/bridge/src/settle.ts`).
- A drain takes all due pending items, oldest first, folds them into **one**
  prompt turn and marks them `delivered` with the turn id. It takes an
  optimistic lock on the session's META row, and `sendPrompt` bumps the same
  version, so a manual prompt that lands first wins and the drain runs again
  after that turn. Items for a `failed` or `deleted` session are dropped, with
  the reason recorded (`dropReason`).
- A wake turn is launch-class: if you already have `MAX_CLOUD_SESSIONS` (10)
  _other_ sessions running, the items stay pending and the next drain retries.

## Linking a PR to a session

A PR links to **at most one** session; a conflicting second link is refused and
never overwrites. There is **no matching on branch names or titles**, ever.

| Method    | When                                                                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `harvest` | After each turn settles, the consumer scans that turn's `tool.call`, `tool.update` and `message.chunk` events for `https://github.com/<owner>/<repo>/pull/<n>`.                                 |
| `trailer` | The launch prompt asks the agent to put `Kiro-Remote-Session: <sessionId>` in the PR body; `pull_request.opened`/`edited` parse it.                                                             |
| `manual`  | `POST /v1/sessions/{id}/links`, `kiro_link_pull_request`. Remove with `DELETE /v1/sessions/{id}/links/{owner}/{repo}/{n}`, `kiro_unlink_pull_request`. `GET /v1/sessions/{id}` lists `links[]`. |

A harvested URL becomes a link only if **all** of these hold. Each rejected
candidate is recorded on the session as a `session.info` event
(`rawType: "pr_link_rejected"`, with `reason`):

- `repo_not_in_session`: owner/repo is in the session's `repos[]`
- `pr_not_found`: the PR exists (read with an installation token)
- `created_before_session`: the PR was created after the session was
- `already_linked`: it is not linked to another session

A trailer is accepted only if the named session exists and is not deleted, the PR's
repo is in its `repos[]`, the PR was created after the session, and (when
`GITHUB_AGENT_LOGINS` is set) the PR is authored by the agent. A forged trailer
fails one of these and is logged (`trailer_rejected`) and counted, never linked.

A delivery for an unlinked PR is stored as **unmatched**. `GET
/v1/github/unmatched?limit=20` (`sessions:read`) lists the recent ones for repos
matching `ALLOWED_REPOS`, so you can link them by hand.

> **Audit status.** Which method is primary depends on whether the PR URL shows
> up in the event log. That audit could **not** be completed: see
> [the audit](#the-link-method-audit). Until it is, both methods are on and the
> trailer is **on by default** (`GITHUB_PR_TRAILER=on`). To turn the trailer off
> set `GITHUB_PR_TRAILER=off`; the launch prompt then gets no extra line.

## What wakes a session

Every wake prompt starts with one fixed header line, so the agent and the
transcript know why the turn started:

```text
[GitHub webhook] This turn was started by GitHub, not by the user: <event> on <owner>/<repo>#<n> (delivery <id>).
```

| Event                                                                                              | Wake                                                                                                                  |
| -------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pull_request.closed`, merged                                                                      | "PR #n was merged into `<base>` at `<sha>`. Finish any remaining work and summarise what's left, or say you're done." |
| `pull_request.closed`, not merged                                                                  | "PR #n was closed without merging."                                                                                   |
| `pull_request_review.submitted`: `changes_requested` or `commented`                                | Who and which state. A trusted reviewer's review body and inline comments are also quoted.                            |
| `issue_comment.created` on a linked PR                                                             | Who commented. A trusted commenter's text is quoted. Bots and the Kiro agent's own identity are ignored.              |
| `check_suite.completed` / `workflow_run.completed`, `failure` or `timed_out`, on the PR's head sha | The failing check names and URLs. **Debounced 2 minutes per PR**: one wake for the whole batch.                       |
| everything else                                                                                    | No wake. The delivery is kept (7 days), and `pull_request.*` refreshes the link's `prState` and `headSha`.            |

**Untrusted text is never forwarded.** For anyone outside `GITHUB_TRUSTED_LOGINS`
(default: the owner of the repo the event is about, which is the App's
installation owner) the prompt states only the structured fact. Trusted text is
quoted as data between `<<<BEGIN GITHUB QUOTE>>>` and `<<<END GITHUB QUOTE>>>`,
capped at 8,000 characters in total, with the markers stripped from the text. Check
names are shown as one bounded line each, because workflow names are written by
whoever can push.

`autoCloseOnMerge` (`GITHUB_AUTO_CLOSE_ON_MERGE`, `off` or `after_turn`,
default `off`): after the post-merge turn **completes**, the session is deleted
to free a slot. Never on closed-unmerged, and not if that turn failed.

## Registering the GitHub App

You register a **private** GitHub App on your own account, by hand. The App only
**reads**: it has no write permission anywhere.

1. GitHub → your profile picture → **Settings** → **Developer settings** →
   **GitHub Apps** → **New GitHub App**.
2. **GitHub App name**: for example `kiro-remote-<your-login>` (unique on GitHub,
   at most 34 characters).
3. **Homepage URL**: `https://github.com/nikovirtala/kiro-remote` (any URL).
4. **Callback URL**, **Setup URL**: leave empty. No user tokens are used, so leave
   **Request user authorization (OAuth) during installation** and **Enable Device
   Flow** unticked.
5. **Webhook**: tick **Active**.
   - **Webhook URL**: `https://<host>/github/webhook` (the `PUBLIC_BASE_URL` of
     your stack).
   - **Webhook secret**: a long random string. Generate one with
     `openssl rand -hex 32` and keep it for the secret below.
   - **SSL verification**: **Enable SSL verification**.
6. **Repository permissions**: set exactly these to **Read-only**, and leave
   every other permission at **No access**:
   - **Metadata**: Read-only (mandatory, GitHub sets it)
   - **Pull requests**: Read-only
   - **Issues**: Read-only
   - **Checks**: Read-only
   - **Actions**: Read-only

   Account and organization permissions: **No access**.
7. **Subscribe to events**: tick exactly `Pull request`, `Pull request review`,
   `Issue comment`, `Check suite`, `Workflow run`.
8. **Where can this GitHub App be installed?**: **Only on this account**.
9. **Create GitHub App**.
10. On the App's page, note the **App ID**, then **Generate a private key**. A
    `.pem` file downloads.
11. **Install App** (left sidebar) → your account → **Only select repositories**,
    and pick only the repositories that match your `ALLOWED_REPOS`. Events from
    other repos are dropped at the webhook, but do not install it there.

> Why Pull requests, Issues, Checks and Actions? `pull_request` and
> `pull_request_review` need _Pull requests_; `issue_comment` is delivered under
> _Issues_ or _Pull requests_; `check_suite` needs _Checks_; `workflow_run` needs
> _Actions_. They are all read-only, so the App cannot change anything.

### The secret

Create one Secrets Manager secret in the stack's region and account, with this
JSON (the key is the whole PEM; newlines may be real or `\n`):

```bash
aws secretsmanager create-secret \
  --region "$AWS_REGION" --name kiro-remote/github-app \
  --secret-string "$(jq -n \
      --arg appId '<App ID>' \
      --arg privateKey "$(cat path/to/app.private-key.pem)" \
      --arg webhookSecret '<the webhook secret from step 5>' \
      '{appId: $appId, privateKey: $privateKey, webhookSecret: $webhookSecret}')"
```

Then set the full ARN in `deploy.env` and redeploy:

```bash
GITHUB_APP_SECRET_ARN=arn:aws:secretsmanager:<region>:<account>:secret:kiro-remote/github-app-AbCdEf
# optional:
GITHUB_TRUSTED_LOGINS=your-login          # default: the repo owner
GITHUB_AGENT_LOGINS=                      # the Kiro agent's GitHub login(s), if you know them
GITHUB_PR_TRAILER=on                      # on (default) | off
GITHUB_AUTO_CLOSE_ON_MERGE=off            # off (default) | after_turn
```

Only the webhook function and the consumer function can read the secret. The
bridge, the API and the OAuth functions cannot.

Installation tokens are minted on demand from the App's JWT by
`@octokit/auth-app` (no hand-rolled JWTs), cached in memory until 5 minutes
before they expire, and never logged. A rotated secret is picked up within
5 minutes.

After the deploy, GitHub's App page → **Advanced** → **Recent Deliveries** shows
the ping and every later delivery. A `202` is a good response.

## Missed deliveries

GitHub does not retry failed webhook deliveries. Every 15 minutes the consumer
lists the App's recent deliveries, picks those that failed and have not since
succeeded, and asks GitHub to redeliver up to 50
([handling failed deliveries](https://docs.github.com/en/webhooks/using-webhooks/handling-failed-webhook-deliveries)).
A redelivery keeps its `X-GitHub-Delivery` id, so dedupe still applies when it
arrives. A delivery the ingress stored but the consumer could not process goes to
the DLQ after 5 attempts and is not redelivered (its id is already claimed):
investigate the DLQ.

## Metrics

Namespace `KiroRemote/GitHub` (webhook, consumer): `WebhooksReceived`,
`WebhooksRejectedSignature`, `WebhooksDuplicate`, `WebhooksDropped`
(`reason=repo_not_allowed`), `WebhooksUnmatched`, `LinksCreated` (by `method`),
`LinksRejected` (by `reason`), `WakesDelivered`, `WakesDropped` (by `reason`),
`Redelivered`. The bridge also emits `WakesDelivered` and `WakesDropped` as it
settles turns.

## Where it shows up

- `GET /v1/sessions/{id}`: `links[]` (`pr`, `linkedBy`, `prState`, `headSha`).
- `GET /v1/sessions/{id}/turns/{turnId}`: `trigger` (`{ source: "user" | "github", deliveryIds }`).
- `GET /v1/sessions/{id}/events`: a wake turn begins with a `session.info` event,
  `rawType: "turn_started"`, whose payload has the trigger.
- `kiro_get_transcript`: every turn has a `trigger`.

## The link-method audit

The plan was to run one real cloud turn on `KIRO_API_E2E_REPO` that opens a
throwaway PR, and count where the PR URL appears in the event log. That decides
which link method is primary.

**It was attempted twice and could not complete.** The cloud session's GitHub
connection could not see the e2e repo (`git clone` answered "repository not
found", `gh api` answered 404, and the account's repository list did not contain
it). No PR was created, so there is no measurement of the PR URL's location, of
whether the agent writes the requested trailer, or of the head branch name and
author login. Both sessions were deleted. Nothing was guessed, and no other repo
was used.

What the two real turns did show, and what the code relies on:

| Event type      | Field that carries command/URL text                                     |
| --------------- | ----------------------------------------------------------------------- |
| `tool.call`     | `payload.rawInput.command` (the command the agent runs)                 |
| `tool.update`   | `payload.rawOutput.output` (the command's output) and `payload.content` |
| `message.chunk` | `content.text`, in many small chunks (48 raw, 2 after coalescing)       |

So the extractor scans tool events whole and joins runs of adjacent
`message.chunk` events, because a URL can straddle a chunk boundary. The
recorded shape is in
[`packages/core/test/fixtures/audit-turn-no-pr.redacted.json`](../packages/core/test/fixtures/audit-turn-no-pr.redacted.json).
A fixture with a PR URL in each field is **synthetic**
(`pr-url-events.synthetic.json`) and is labelled as such.

**To finish the audit**, point `KIRO_API_E2E_REPO` at an `owner/name` repo the
Kiro GitHub connection can write to, and run the opt-in scenario below: its
`gh-link` step reports `linkedBy`, which is the method that worked.

## Live end-to-end scenario (opt-in)

Needs a deployed stack with the App installed on the e2e repo, `kiro-remote
login`, and the GitHub CLI logged in as a **trusted** login.

```bash
KIRO_REMOTE_URL=https://<host> KIRO_API_E2E_REPO=<owner>/<name> \
KIRO_API_E2E_GITHUB=1 [KIRO_API_E2E_GITHUB_AUTOCLOSE=1] \
  pnpm e2e
```

Steps (after the normal ones): `gh-launch` (the agent opens a docs-only PR),
`gh-link` (the PR is linked; reports the method), `gh-review-wake` (posts a review
comment as the trusted login and waits for the wake turn; reports review-to-turn
latency), `gh-merge-wake` (merges the PR and waits for the post-merge wake turn;
with `KIRO_API_E2E_GITHUB_AUTOCLOSE=1`, also that the session is deleted), and
`gh-cleanup` (closes the PR, deletes its branch; the session is deleted by the
harness cleanup). Set `GITHUB_AUTO_CLOSE_ON_MERGE=after_turn` on the stack for the
auto-close check.

## Out of scope (next steps)

Issue-driven launches ("label an issue `kiro` and a session starts"), GitLab,
write permissions for the App, posting status back to the PR, a web UI for links
and wake reasons.
