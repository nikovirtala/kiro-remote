# What a cloud session does not do

Every session this server launches is a Kiro cloud session. All the tools exist, but
some have nothing to act on there. A refused command is not reported in the call:
read the event log to see it.

| Tool                     | On a cloud session                                                                                                                                                                           |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kiro_set_config`        | Logged and ignored. The call answers `status: "configuring"`. Pick `model`, `effort` and `mode` at launch instead.                                                                           |
| `kiro_list_permissions`  | Always an empty list.                                                                                                                                                                        |
| `kiro_answer_permission` | Nothing to answer. Cloud turns never ask for permission.                                                                                                                                     |
| `kiro_cancel_turn`       | Answers `status: "cancelling"`, but a running turn is not stopped: a `turn.failed` event with `rawType: "operation_rejected"` follows and the turn runs to its end. Idle session: no effect. |
| `kiro_adopt_session`     | Rejected by the bridge (an `operation_rejected` event). Do not use it.                                                                                                                       |
| `kiro_list_models`       | Returns no models. That is expected; do not retry.                                                                                                                                           |
| `kiro_send_prompt`       | Default `whenBusy: "steer"` fails on a busy session with `steer_unsupported`. Use `"queue"`.                                                                                                 |

Because a cloud session takes no prompt while a turn runs, the way to stop a
runaway turn is not `kiro_cancel_turn`. Let it end, or delete the session.

## Failures a tool call reports

A tool that fails returns an error result (`isError: true`) with a short message:

- The repository is not on the server's allow list: the launch is refused.
- You already have 10 active sessions (`provisioning`, `running`, `idle`): the launch
  is refused. Delete sessions you are done with and launch again.
- `session not found`: the id is wrong, belongs to someone else, or the session was deleted.
- `steer_unsupported` or `whenBusy=reject`: the session is busy. Send with `"queue"`.
- This idempotency key was already used for a different request: use a new key.

A token that lacks a tool's scope gets a protocol error with `insufficient_scope`
instead, naming the scope. That is not retryable by you: report which scope is missing.
