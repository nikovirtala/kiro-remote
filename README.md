# kiro-remote

A personal AWS control plane (CDK) that wraps `kiro-cli` to launch and drive Kiro
cloud sessions through a REST API and an MCP server.

You deploy it once into your own AWS account. After that you (and the MCP clients
you authorize) can launch repo-scoped Kiro cloud sessions, send prompts, stream
events, answer permission prompts, and manage sessions, either over the REST API
or through the 14 MCP tools exposed by the bundled `kiro-remote` CLI.

## What's in the box

- **REST API** (`packages/api`) served by API Gateway + Lambda at base path `/v1`,
  with an OAuth 2.1 facade in front of Cognito and an OpenAPI 3.1 contract at
  `/openapi.json`.
- **MCP server** (`packages/mcp`) exposed two ways: a stdio transport via the
  `kiro-remote` CLI, and a Streamable HTTP transport mounted at `<host>/mcp`.
- **Bridge** (`packages/bridge`) an ECS Fargate (Graviton/arm64) service that runs
  `kiro-cli` to launch and drive Kiro cloud sessions: it provisions each cloud
  session (a Space in app.kiro.dev) and runs every turn via
  `kiro-cli chat --cloud`, while negotiating capabilities over the Agent Client
  Protocol. See the
  [chat-only cloud path](./docs/deploy.md#how-the-bridge-drives-cloud-sessions-chat-only--cloud-only)
  for detail.
- **CDK app** (`packages/cdk`) one `KiroRemoteStack` wiring DynamoDB, S3, SQS,
  Cognito, the Fargate bridge, and the API (with native stage throttling).
- **Auth facade** (`packages/auth`), shared schemas/domain (`packages/core`), and a
  live end-to-end harness (`e2e`).

## Documentation

Operator and user guides live under [`docs/`](./docs/):

- [Overview and what to do next](./docs/README.md)
- [Deploying the control plane](./docs/deploy.md)
- [Running the tests](./docs/testing.md)
- [Registering a user](./docs/users.md)
- [Trying the REST API](./docs/rest-api.md)
- [Using the MCP server](./docs/mcp.md)

## Getting help

For bugs, questions, and feature requests, open a
[GitHub issue](https://github.com/nikovirtala/kiro-remote/issues). For anything
not suited to a public issue, email the maintainer at
[niko.virtala@hey.com](mailto:niko.virtala@hey.com). Security-sensitive reports
should go there privately rather than to a public issue; see
[SECURITY.md](./SECURITY.md).

## Toolchain

Node 26.13.0 and pnpm 12.18.0, pinned in [`.mise.toml`](./.mise.toml). TypeScript
runs directly via Node's native type stripping (no compile step). See
[`docs/deploy.md`](./docs/deploy.md) for the exact setup commands.

## License

MIT.
