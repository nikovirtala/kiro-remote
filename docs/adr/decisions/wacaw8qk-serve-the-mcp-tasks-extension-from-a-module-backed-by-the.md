# Serve the MCP Tasks extension from a module backed by the turn records

## Context
A Kiro turn takes seconds to minutes, so an MCP client drives it with kiro_wait_for_events and kiro_get_transcript, a loop that every model has to be taught (the instructions, the skill) and that it gets wrong by trial. The Tasks extension (io.modelcontextprotocol/tasks, SEP-2663) lets a tool call answer with a task handle that the client polls (tasks/get) on its own, so the model receives the turn's final answer as the tool result. Claude (web) and Claude Code support it. @modelcontextprotocol/server 2.4.0 has no ext/tasks: the SDK's server helper is typescript-sdk PR #2782, open and unreleased, and its InMemoryTaskStore keeps tasks in the process, which the stateless API Lambda cannot. The wire schemas and a requester are published as @modelcontextprotocol/ext-tasks 0.2.3. On 2.4.0 the per-request client capabilities reach a tools/call handler as ctx.mcpReq.envelope, and a tools/call result with resultType "task" passes the encoder unchanged, so no SDK patch is needed. A prompt sent with whenBusy "queue" has a stored row (the queued prompt) before kiro_send_prompt answers; one sent with steer or reject to an idle session is only a command on its way to the bridge, which writes the turn row later.

## Decision
packages/mcp/src/tasks/ holds a hand-written TasksExtension and TaskStore that follow PR #2782 (same names, the store's four methods create, get, update and cancel), marked in its header as replaceable by the SDK's ext/tasks. The wire schemas come from @modelcontextprotocol/ext-tasks/core/v2. The store (TurnTaskStore) keeps no state: a task id encodes the session id, the turn id, the creation time and the TTL, and every read goes to the records GET /sessions/{id}/turns/{turnId} reads (the turn row, or the queued prompt), as the caller, so ownership of the session is the access check and another user's task is "Task not found". kiro_send_prompt answers with a task when the request declares the extension and the prompt left a stored record (whenBusy "queue"); otherwise it answers as before, byte for byte. The extension serves tasks/get, tasks/update and tasks/cancel on 2026-07-28 only (-32021 when the request did not declare it, -32601 on the 2025 era). It attaches through the McpExtension interface of the one server factory, which gains an optional afterToolCall hook where 2.4.0 has no tools/call middleware. KiroRemoteClient gains getTurn for the store. A completed task's result is the turn's final text, read with the code behind kiro_get_transcript. Handles carry pollIntervalMs 5000 and ttlMs 24 hours. notifications/tasks are not sent.

Options considered:
1. Wait for the SDK's ext/tasks. Nothing to maintain, but the PR is open with no date, and its in-memory store would still have to be replaced by one that reads the turn records.
2. Hand-write the extension now to the SDK design, backed by the turn records (chosen). The swap when the SDK ships is the import and the store wiring.
3. A table of tasks in DynamoDB written by the tool call. It duplicates the turn row, adds a write to the call and a second source of truth for the turn's status.
4. Keep tasks in the Lambda's memory (the SDK's InMemoryTaskStore). A later poll reaches a different invocation and finds nothing.
5. Hold the tool call open until the turn ends, with no task. A Lambda invocation ends at 29 seconds and a turn can take minutes.

## Scope
packages/mcp/src/tasks, the McpExtension interface and server factory in packages/mcp/src/extensions.ts and server.ts, KiroRemoteClient.getTurn in packages/api/src/mcp-seam.ts with its two implementations, getTurnState in packages/core/src/service/index.ts, and the e2e Tasks steps. It does not change the 19 tools or their schemas.

## Consequences
- A client with Tasks gets the answer of a follow-up as the tool result and does not run the wait and transcript loop; every other client is unchanged.
- No new table, role or permission: tasks/get reads what the API Lambda already reads.
- A steer or reject prompt to an idle session, and kiro_launch_session, answer without a task (the first has no stored record yet, the second no turn id), so a Tasks client should send follow-ups with whenBusy "queue". Making them durable needs a core change.
- The task is a failed task when a turn fails, which the spec reserves for protocol-level errors; a tool execution error is completed with isError. Flipping this is one function (taskForTurn).
- The stdio server reads through the REST API, which hides a deleted session, so there such a task is "Task not found" where /mcp says failed with session_deleted.
- The 2025-era initialize lists the extension under capabilities.extensions, as it does for Skills; nothing else changes for that era.
- The module is a copy of an unreleased design and is replaced when the SDK ships it.
