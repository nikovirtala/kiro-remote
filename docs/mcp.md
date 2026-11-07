# Using the MCP server

kiro-remote exposes an MCP server two ways, both backed by the same REST API and
the same `KiroRemoteClient` interface:

- **stdio** — the `kiro-remote mcp` command, which speaks MCP over stdio and calls
  the REST API with _your_ OAuth token (refreshing it silently).
- **Streamable HTTP** — mounted at `<host>/mcp`, a protected resource that
  requires the same Cognito bearer.

Both surfaces expose the same **14 tools**.

## The `kiro-remote` CLI

The CLI lives in `packages/mcp` (private workspace package `@nikovirtala/kiro-remote-mcp`, bin
name `kiro-remote`, entry
[`packages/mcp/src/cli.ts`](../packages/mcp/src/cli.ts)). Commands:

| Command              | What it does                                                                                                                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kiro-remote login`  | OAuth authorization-code + PKCE against the facade (CIMD `client_id` `https://<host>/oauth/clients/cli.json`, loopback redirect on an ephemeral port). Stores tokens in the OS keychain with a `0600` file fallback. |
| `kiro-remote logout` | Revoke the refresh token and clear stored tokens.                                                                                                                                                                    |
| `kiro-remote whoami` | Print the caller's `sub` and scopes.                                                                                                                                                                                 |
| `kiro-remote mcp`    | Run the stdio MCP transport over the REST API, refreshing tokens silently.                                                                                                                                           |

### Required environment variable

The CLI needs exactly one variable:

- **`KIRO_REMOTE_URL`** — the facade / REST API public base URL (the same value as
  the stack's `publicBaseUrl`). If it is unset, the CLI exits with code **2**.

No secret is ever passed on the command line.

### Running the CLI from the workspace

The package is a private workspace package, so run its bin through pnpm:

```bash
export KIRO_REMOTE_URL=https://<host>

# Log in once (opens managed login in your browser, enrolls/uses MFA).
mise exec -- pnpm --filter @nikovirtala/kiro-remote-mcp exec kiro-remote login

# Confirm who you are.
mise exec -- pnpm --filter @nikovirtala/kiro-remote-mcp exec kiro-remote whoami
```

(If you manage Node/pnpm yourself, drop the `mise exec --` prefix.)

## Wiring stdio into an MCP client

After `kiro-remote login` has stored your tokens, register `kiro-remote mcp` as a
**stdio** MCP server in your client, with `KIRO_REMOTE_URL` set in its environment.
The exact file differs per client; the shape is the same. For example, a
Claude Desktop-style `mcpServers` entry:

```json
{
  "mcpServers": {
    "kiro-remote": {
      "command": "mise",
      "args": [
        "exec",
        "--",
        "pnpm",
        "--filter",
        "@nikovirtala/kiro-remote-mcp",
        "exec",
        "kiro-remote",
        "mcp"
      ],
      "env": {
        "KIRO_REMOTE_URL": "https://<host>"
      }
    }
  }
}
```

Set `command`/`args` to whatever invokes `kiro-remote mcp` in your environment (the
pnpm form above works from the workspace; a globally linked `kiro-remote` binary
would simply be `"command": "kiro-remote", "args": ["mcp"]`). The server reads your
stored tokens and refreshes them silently, so you do not pass any secret in the
config.

## Using Streamable HTTP directly

If your MCP client speaks Streamable HTTP, point it at `<host>/mcp`. That endpoint
is a protected resource: it requires `Authorization: Bearer <token>` (the same
Cognito access token as the REST API) and advertises its OAuth requirements via the
`/.well-known/oauth-protected-resource/mcp` document.

## The 14 tools

Stable order, with annotations `RO` = `readOnlyHint`, `DESTRUCTIVE` =
`destructiveHint` (from [`packages/mcp/src/tools.ts`](../packages/mcp/src/tools.ts)):

| #   | Tool                     | Annotation  | What it does                                                              |
| --- | ------------------------ | ----------- | ------------------------------------------------------------------------- |
| 1   | `kiro_capabilities`      | RO          | Advertised capabilities, `kiro-cli` version, your active session count.   |
| 2   | `kiro_list_models`       | RO          | Model ids the agent advertises.                                           |
| 3   | `kiro_launch_session`    | —           | Launch a session against one or more repos with an initial prompt.        |
| 4   | `kiro_list_sessions`     | RO          | List your sessions, newest first, with status filter + cursor.            |
| 5   | `kiro_adopt_session`     | —           | Adopt an existing Kiro cloud session.                                     |
| 6   | `kiro_get_session`       | RO          | Fetch one session you own.                                                |
| 7   | `kiro_send_prompt`       | —           | Send a prompt; steer/queue/reject when busy.                              |
| 8   | `kiro_wait_for_events`   | RO          | Long-poll the event log (see limits below).                               |
| 9   | `kiro_get_transcript`    | RO          | The assistant's final text per completed turn.                            |
| 10  | `kiro_list_permissions`  | RO          | List permission requests (optionally by status).                          |
| 11  | `kiro_answer_permission` | —           | Answer a pending request with an offered `optionId` (+ optional consent). |
| 12  | `kiro_set_config`        | —           | Change a session's `model` / `effort` / `mode`.                           |
| 13  | `kiro_cancel_turn`       | DESTRUCTIVE | Cancel the active turn.                                                   |
| 14  | `kiro_delete_session`    | DESTRUCTIVE | Permanently delete a session and its cloud sandbox.                       |

### `kiro_wait_for_events` limits

The poller is tuned so an agent can poll cheaply: it waits at most **25 seconds**,
returns at most **30 events** and **8000 characters** of text (reporting any
truncation), and includes `nextCursor`, `turnStatus`, and the pending-permission
count.

### `kiro_get_transcript`

Returns the assistant's **final** text for each completed turn (not the raw event
stream), which is usually what you want to read back.

## Scopes and secrets

MCP calls use your Cognito OAuth token and are gated by the same scopes as the REST
API (`sessions:read` / `sessions:write` / `sessions:delete`). The `ksk_`
`KIRO_API_KEY` is never used here; it is only the bridge's credential for
`kiro-cli` inside the deployed container.
