# Kiro Remote

Kiro Remote is a personal AWS control plane that launches and drives [Kiro Web](https://kiro.dev/web/) agentic coding sessions through an MCP server and a REST API, using the engine bundled with `kiro-cli` over ACP.

## Drive a hosted coding agent from your chat

The part I'm most excited about: the MCP server lets a chat client such as Claude connect to your own deployment and hand real coding work to a Kiro Web agent, right from the conversation. No switch to Claude Code needed. From the chat you can:

- launch a repo-scoped Kiro Web session with an initial prompt (`kiro_launch_session`),
- send follow-up prompts and long-poll progress (`kiro_send_prompt`, `kiro_wait_for_events`),
- read back each turn's final answer (`kiro_get_transcript`),
- and list and delete sessions (`kiro_list_sessions`, `kiro_delete_session`). Some tools (for example cancelling a running turn) are not supported on cloud sessions; see [the MCP guide](./docs/mcp.md#the-16-tools).

Optionally, GitHub activity on a pull request the agent opened (merged, closed, changes requested, a comment from you, failing checks) can wake the session with a new turn: see [GitHub wake](./docs/github.md).

You deploy it once into your own AWS account. After that, you (and the MCP clients you authorize) can do all of the above either over the REST API or through the 16 MCP tools. Both MCP transports expose the same tools.

Remote MCP clients connect to `<host>/mcp` over Streamable HTTP and sign in through the bundled OAuth 2.1 facade (Dynamic Client Registration is supported, which is what a client's "Register automatically" option uses). Local clients can run the stdio `kiro-remote mcp` command instead. See [Using the MCP server](./docs/mcp.md).

How sign-in works:

- The user pool is invite-only, and users sign in with a passkey.
- The email-code factor used to bootstrap the first passkey stays usable afterwards. Cognito cannot enforce passkey-only sign-in.

The API and OAuth callback Lambdas run on the Node 26 runtime, which AWS lists as public preview (the bridge Lambdas are container images). See [Registering a user](./docs/users.md), [SECURITY.md](./SECURITY.md) and [Toolchain](#toolchain).

## Quick start

1. [Deploy the control plane](./docs/deploy.md) into your AWS account (needs your Kiro API key).
2. [Invite a user](./docs/users.md) with `scripts/invite-user.sh` (sign-up is operator driven; you then add a passkey).
3. Connect an MCP client: [Using the MCP server](./docs/mcp.md), or try the [REST API](./docs/rest-api.md) with `curl`.

## What's in the box?

- **MCP server** (`packages/mcp`) exposed in two ways: a Streamable HTTP transport mounted at `<host>/mcp` and a stdio transport via the `kiro-remote` CLI.
- **REST API** (`packages/api`) served by API Gateway + Lambda at base path `/v1`, with an OAuth 2.1 facade in front of Cognito and an OpenAPI 3.1 contract at `/openapi.json`.
- **Bridge** (`packages/bridge`) two container-image Lambda functions (arm64) built from one image: an SQS consumer that launches and drives Kiro Web sessions over the Agent Client Protocol (ACP) against kiro-cli's bundled engine, and a publisher that records the engine's capabilities. See the [direct-engine path](./docs/deploy.md#how-the-lambda-path-drives-cloud-sessions-direct-engine) for detail.
- **CDK app** (`packages/cdk`) one `KiroRemoteStack` wiring DynamoDB, S3, SQS, Cognito, the Lambda bridge, and the API (with native stage throttling).
- **GitHub wake** (`packages/github`, optional) a read-only GitHub App's webhook ingress, the event router and the PR-link logic. Off unless you set `GITHUB_APP_SECRET_ARN`.
- **Auth facade** (`packages/auth`), shared schemas/domain (`packages/core`), and a live end-to-end harness (`e2e`).

## Documentation

Operator and user guides live under [`docs/`](./docs/):

- [Overview and what to do next](./docs/README.md)
- [Deploying the control plane](./docs/deploy.md)
- [Running the tests](./docs/testing.md)
- [Registering a user](./docs/users.md)
- [Trying the REST API](./docs/rest-api.md)
- [Using the MCP server](./docs/mcp.md)
- [GitHub wake (optional)](./docs/github.md)

## Getting help

For bugs, questions, and feature requests, open a [GitHub issue](https://github.com/nikovirtala/kiro-remote/issues). For anything not suited to a public issue, email the maintainer at [niko.virtala@hey.com](mailto:niko.virtala@hey.com). Security-sensitive reports should go there privately rather than to a public issue; see [SECURITY.md](./SECURITY.md).

## Toolchain

Node 26.13.0 and pnpm 12.18.0, pinned in [`.mise.toml`](./.mise.toml). TypeScript runs directly via Node's native type stripping (no compile step). The API and OAuth callback Lambdas target the matching Node 26 runtime (`nodejs26.x`; the bridge Lambdas are container images), which AWS still lists as **public preview** (not SLA/Support-covered; GA targeted ~Nov 2026). See [`docs/deploy.md`](./docs/deploy.md) for the exact setup commands and the full runtime/preview note.

## License

MIT.
