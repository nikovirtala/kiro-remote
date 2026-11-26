# Pull requests: linking, waking and waiting

The agent in the session opens pull requests itself, with its own GitHub access.
These tools only connect a pull request to a session so that GitHub activity can wake
the session. They need the server's GitHub feature; without it each call fails with a
capability-unavailable error, and the rest of the skill still works.

## Linking

A session is linked to its pull request in three ways, and you rarely need the last:

- **Harvest.** After each turn the server scans the agent's output for a pull request
  URL in one of the session's repositories and links it.
- **Trailer.** The launch prompt asks the agent to put a `Kiro-Remote-Session: <id>` line
  in the pull request description, and the server links on that line.
- **By hand.** `kiro_link_pull_request { sessionId, pr, idempotencyKey }`, where `pr` is
  `owner/repo#12` or a GitHub pull request URL. The repository must be one of the
  session's repositories. The call does not check that the pull request exists, so
  check the number first. A pull request links to at most one session: linking one that
  belongs to another session fails. `kiro_unlink_pull_request` removes a link.

Check with `kiro_get_session`: `links` lists each `pr`, how it was linked (`linkedBy`)
and its `prState` (`open`, `closed`, `merged` or `unknown`). A link added by hand
starts as `unknown` until GitHub reports it.

## What wakes the session

A linked pull request that is merged or closed, a review that requests changes or
comments, a comment from a trusted person, failing checks (batched over 2 minutes) and
a conflict with its base branch each start a **new turn** on the session. The turn is
listed in `kiro_get_transcript` with `trigger.source: "github"`. A wake never enters a
busy session: it waits until the session is idle and the queue is empty. So after a
pull request merges, poll again; a new turn appears by itself.

`kiro_list_events { after, limit }` reads the account's change feed (links and waits
added or removed, and every wake with its cause). Start with `after: 0` and carry
`nextCursor`.

## Waiting for a pull request that is not the session's own

`kiro_wait_for_pull_request { sessionId, pr, idempotencyKey }` wakes the session once
when that pull request merges or closes. Use it when the session's work depends on a
pull request it does not own, such as a stacked change or another repository's change.
A pull request that is already merged or closed wakes the session at once. Any number of
sessions can wait for one pull request. `kiro_get_session` lists `waits`, and
`kiro_stop_waiting_for_pull_request` removes one. The wake is a turn like any other:
the agent is told the pull request merged or closed and decides what to do.

You cannot wait inside the session from here: the tool registers the wait and returns.
Keep polling the session's events to see the woken turn.
