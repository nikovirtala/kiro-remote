---
name: kiro-remote-sessions
description: Hand coding work on a GitHub repository to a Kiro cloud session through the kiro_* tools of this server. Use when asked to start a Kiro session, delegate a coding task to Kiro, check on, follow up with or read the result of a Kiro session, link or wait for its pull requests, or delete it. Covers the launch, wait and transcript loop, cloud-session limits, safe retries and pull request linking.
---

# Handing coding work to a Kiro cloud session

A Kiro cloud session is an agent working in its own sandbox on one or more GitHub
repositories. It works on its own time: you launch it, poll its event log and read
what it wrote. Nothing is pushed to you, so you must poll.

## The loop

1. **Launch.** `kiro_launch_session { prompt, repos: ["owner/name"], title?, idempotencyKey }`.
   Write the prompt as a complete task: the agent has no other context. The answer
   is `{ sessionId, turnId: null }`. There is no turn yet, and the session's
   status is `provisioning` while the sandbox starts. Keep `sessionId`.
2. **Wait.** `kiro_wait_for_events { sessionId, after: 0 }`. The server holds the
   request until at least one event newer than `after` exists, or about 20 seconds
   pass and it returns an empty page. Pass the answer's `nextCursor` as the next
   `after` and call again. Never reuse an old cursor: you would read events twice.
3. **Read.** `kiro_get_transcript { sessionId }` returns the agent's text, one entry
   per turn. Use it for the answer; use the events to know when it is ready.

Repeat step 2 until the work has finished (below), then read the transcript.

### What `turnStatus` says

Every wait answer carries `turnStatus`:

| `turnStatus`          | Meaning                                                         | You do                        |
| --------------------- | --------------------------------------------------------------- | ----------------------------- |
| `provisioning`        | The sandbox is starting; no turn has run yet.                   | Keep waiting.                 |
| `running`             | A turn is running.                                              | Keep waiting.                 |
| `idle`                | No turn is running; the session accepts a prompt.               | Read, then decide.            |
| `awaiting_permission` | Cloud turns never ask for permission, so you should not see it. | Treat as `running`.           |
| `null`                | The session has `failed` or was `deleted`.                      | Stop; see `kiro_get_session`. |

The work is finished when `turnStatus` is `idle` **and** you have seen a
`turn.completed` event (the agent finished) or a `turn.failed` event (the turn
failed). `idle` alone is not enough: right after you send a prompt the session can still
read `idle` until the bridge has picked the prompt up. A `turn.failed` event whose `rawType` is `operation_rejected` or
`queued_prompt_failed` refuses one command and does not end the running turn.

To wait without reading the agent's text, filter:
`kiro_wait_for_events { sessionId, after, types: ["turn.completed", "turn.failed"] }`.
The cursor then jumps to the last matching event, which is what you want.

### Limits of one wait

- At most **20 seconds** per call. An empty answer is normal: call again.
- At most **30 events** and **8000 characters** of `text` per answer, with
  `eventsTruncated` / `textTruncated` and the dropped counts.
- `nextCursor` follows the **events** returned. Text cut by the 8000 character cap
  is not offered again by the next wait. When `textTruncated` is true, read the
  full text with `kiro_get_transcript`.
- `kiro_get_transcript` also lists a turn that is still running, with the text so
  far. Do not treat it as final until the turn has ended.

See [the turn loop](references/turn-loop.md) for the event types and a worked poll.

## Follow-ups

`kiro_send_prompt { sessionId, prompt, whenBusy: "queue", idempotencyKey }`.

Always set `whenBusy: "queue"`. The default, `steer`, fails in the call on a busy
cloud session (`steer_unsupported`), because a running cloud turn takes no extra
prompt. With `queue` the prompt runs as its own turn after the one in front of it,
and the answer holds that turn's id. A session is busy while a turn runs and while
prompts are queued. `reject` refuses a busy session; use it only when you would
rather drop the prompt than wait. A queued prompt ends as a turn or as a visible
`turn.failed` event, and `kiro_get_session` lists the queue with each prompt's
status and failure reason.

### Clients that support Tasks

If your client supports the MCP Tasks extension, `kiro_send_prompt` with
`whenBusy: "queue"` answers with a task for the turn instead of `{ turn }`. The client
polls the task on its own, and the tool result you receive is the turn's final text
plus `structuredContent { sessionId, turnId, status }`: the same text
`kiro_get_transcript` gives for that turn. You then skip `kiro_wait_for_events` and
`kiro_get_transcript` for it. A turn that fails is a failed task whose error names
the reason. The wait and transcript loop is for clients without Tasks, and for
`kiro_launch_session`, whose answer is always `{ sessionId, turnId: null }`. A
`steer` or `reject` prompt has no stored record to follow, so it always answers
`{ turn }` and you read it with the loop.

## Retrying safely

Every tool that changes something takes `idempotencyKey` (1 to 128 characters from
`A-Z a-z 0-9 . _ ~ : -`). Make one key per logical call and send the **same** key on
every retry of it: the call then runs at most once in 24 hours and a retry returns
the first result. A new key for the same intent runs the call again, which launches
a second session or sends a second prompt. The same key with different arguments is
refused. A call that failed is not stored, so a retry with its key runs again.
Read-only tools take no key.

## Pull requests

The agent opens pull requests itself. Usually the session is linked to its PR
without your help; check `links` in `kiro_get_session`. To link one by hand use
`kiro_link_pull_request { sessionId, pr: "owner/repo#12" }`, and to wake a session
when a PR it depends on merges or closes use `kiro_wait_for_pull_request`. Both
need the server's GitHub feature; without it they fail with a capability-unavailable
error (HTTP 501 behind the tool).
See [pull requests](references/pull-requests.md).

## Cloud sessions: what does nothing

These tools exist but have no effect on a cloud session. Do not rely on them:
`kiro_set_config` (a logged no-op), `kiro_list_permissions` (always empty) and
`kiro_answer_permission` (nothing to answer: cloud turns never ask), `kiro_cancel_turn`
(refused while a turn runs; the turn finishes), `kiro_adopt_session` (rejected) and
`kiro_list_models` (returns no models). Their calls can still answer success; the
refusal shows up later as a `turn.failed` event with `rawType: "operation_rejected"`.
See [cloud sessions](references/cloud-sessions.md).

## Cleaning up

`kiro_delete_session { sessionId, idempotencyKey }` answers `status: "deleting"`: the
deletion is asynchronous and the sandbox goes away afterwards. A user can have at
most 10 active sessions (`provisioning`, `running` or `idle`), and a launch beyond
that fails, so delete sessions you have read. Queued prompts of a deleted session
fail with reason `session_deleted`. Delete only sessions you launched for this task.
