# Kiro Remote

Have you ever wanted to command your hosted coding agent from the Claude chat conversation without changing the tool to Claude Code for instance? — If yes, then read on!

Kiro Remote is a personal AWS control plane that wraps `kiro-cli` to launch and drive [Kiro Web](https://kiro.dev/web/) agentic coding sessions through an MCP server and a REST API.

You deploy it once into your own AWS account. After that, you (and the MCP clients you authorize) can launch repo-scoped Kiro Web sessions, send prompts, stream events, and manage sessions, either over the REST API or through the 14 MCP tools exposed by the bundled `kiro-remote` CLI.

## What's in the box?

- **MCP server** (`packages/mcp`) exposed in two ways: a Streamable HTTP transport mounted at `<host>/mcp` and a stdio transport via the `kiro-remote` CLI.
- **REST API** (`packages/api`) served by API Gateway + Lambda at base path `/v1`,with an OAuth 2.1 facade in front of Cognito and an OpenAPI 3.1 contract at `/openapi.json`.
- **Bridge** (`packages/bridge`) two container-image Lambda functions (arm64) built from one image: an SQS consumer that launches and drives Kiro Web sessions over the Agent Client Protocol (ACP) against kiro-cli's bundled engine, and a publisher that records the engine's capabilities. See the [direct-engine path](./docs/deploy.md#how-the-lambda-path-drives-cloud-sessions-direct-engine) for detail.
- **CDK app** (`packages/cdk`) one `KiroRemoteStack` wiring DynamoDB, S3, SQS, Cognito, the Lambda bridge, and the API (with native stage throttling).
- **Auth facade** (`packages/auth`), shared schemas/domain (`packages/core`), and a live end-to-end harness (`e2e`).

## Documentation

Operator and user guides live under [`docs/`](./docs/):

- [Overview and what to do next](./docs/README.md)
- [Deploying the control plane](./docs/deploy.md)
- [Running the tests](./docs/testing.md)
- [Inviting a user and passkey sign-in](./docs/users.md)
- [Trying the REST API](./docs/rest-api.md)
- [Using the MCP server](./docs/mcp.md)

## Getting help

For bugs, questions, and feature requests, open a [GitHub issue](https://github.com/nikovirtala/kiro-remote/issues). For anything not suited to a public issue, email the maintainer at [niko.virtala@hey.com](mailto:niko.virtala@hey.com). Security-sensitive reports should go there privately rather than to a public issue; see [SECURITY.md](./SECURITY.md).

## Toolchain

Node 26.13.0 and pnpm 12.18.0, pinned in [`.mise.toml`](./.mise.toml). TypeScript runs directly via Node's native type stripping (no compile step). The deployed Lambdas target the matching Node 26 runtime (`nodejs26.x`), which AWS still lists as **public preview** (not SLA/Support-covered; GA targeted ~Nov 2026). See [`docs/deploy.md`](./docs/deploy.md) for the exact setup commands and the full runtime/preview note.

## License

MIT.
