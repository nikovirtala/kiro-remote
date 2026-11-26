# The turn loop in detail

Read this when a poll does not behave as the main skill describes, or when you need
the event types.

## One poll, step by step

```text
after = 0
loop:
  r = kiro_wait_for_events { sessionId, after }
  after = r.nextCursor
  if r.turnStatus is null:      stop, the session failed or was deleted
  if r finished (see below):    break
kiro_get_transcript { sessionId }
```

`kiro_wait_for_events` is a real server-side long poll. The server re-reads the log
about once a second and returns at once when it finds an event newer than `after`;
otherwise it returns an empty page after 20 seconds with `nextCursor` equal to the
`after` you sent. It keeps waiting whatever the session status is. So a call is
slow only when nothing is happening, and a busy session answers quickly with
whatever it has: loop, do not sleep between calls.

`after` starts at `0` (the whole log) and is the `seq` of the last event you have
read. `kiro_wait_for_events` takes no `wait` argument and no idempotency key.

## What the answer holds

| Field                               | Use                                                                                             |
| ----------------------------------- | ----------------------------------------------------------------------------------------------- |
| `events`                            | At most 30, oldest first, each with `seq`, `turnId`, `type`, `rawType`, `payload`.              |
| `text`                              | The agent's message text from those events, cut at 8000 characters.                             |
| `nextCursor`                        | The `seq` of the last returned event, or `after` when there was none.                           |
| `turnStatus`                        | `provisioning`, `running`, `idle`, `awaiting_permission` or `null`.                             |
| `pendingPermissionCount`            | Always 0 on cloud sessions.                                                                     |
| `eventsTruncated`, `droppedEvents`  | More than 30 events were found. The cursor stops at the 30th, so the next call continues there. |
| `textTruncated`, `droppedTextChars` | The text was cut. The cursor does not go back for it: use `kiro_get_transcript`.                |

## Event types you will meet

| `type`                     | Meaning                                                                        |
| -------------------------- | ------------------------------------------------------------------------------ |
| `message.chunk`            | A piece of the agent's answer. `kiro_get_transcript` joins them per turn.      |
| `thought.chunk`            | Reasoning text. Not part of the transcript.                                    |
| `tool.call`, `tool.update` | The agent used a tool in its sandbox.                                          |
| `session.info`             | Housekeeping. `rawType: "turn_started"` marks a turn started by a GitHub wake. |
| `turn.completed`           | The turn ended normally. `stopReason` says how.                                |
| `turn.failed`              | The turn failed, or one command was refused (see `rawType` below).             |
| `raw`                      | Something unrecognised, kept as received. Skip it.                             |

`turn.failed` carries a `rawType`:

- `operation_rejected`: a command the cloud cannot do (cancel while running, steer
  while running, adopt). The running turn is **not** affected and keeps going.
  `payload.operation` and `payload.reason` say what was refused.
- `queued_prompt_failed`: a prompt you queued will not run. `payload.reason` is
  `session_deleted`, `session_failed` or `not_sent`. The prompt text is not included.
- anything else: the turn itself failed. The session returns to `idle` and accepts
  a new prompt.

## Reading the result

`kiro_get_transcript { sessionId }` returns `{ sessionId, turns: [{ turnId, text, trigger }] }`
in order. `trigger.source` is `"user"` for a turn you started and `"github"` for a turn a
GitHub event woke, with the webhook delivery ids. It reads the whole log each time and
includes the turn in progress with its text so far, so call it after the turn ended.
A turn with no text is omitted unless a GitHub wake started it.
