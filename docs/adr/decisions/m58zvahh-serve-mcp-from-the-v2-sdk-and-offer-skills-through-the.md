# Serve MCP from the v2 SDK and offer skills through the Skills extension

## Context
What an agent needs to know to hand work to a Kiro cloud session (the launch, wait and transcript loop, the cloud-session no-ops, safe retries, PR linking) lives only in docs/mcp.md, which no MCP client reads, so agents learn it by trial and error. The Skills extension (io.modelcontextprotocol/skills, SEP-2640) lets a server publish that as a skill that Claude (web), Claude Code and VS Code Copilot list and load. Claude Desktop and Kiro do not support it and can only use the server's instructions text.

The SDK that ships the extension is @modelcontextprotocol/server 2.x. packages/mcp used @modelcontextprotocol/sdk 1.x for stdio and a hand-written JSON-RPC dispatcher for /mcp (initialize, ping, tools/list and tools/call only, protocol 2025-06-18). 2.x serves protocol 2026-07-28 and, through a fallback, the 2025 era, from one server factory. Its Skills extension attaches to the high-level McpServer, is marked experimental, and is pinned here to an exact version.

## Decision
packages/mcp moves to @modelcontextprotocol/server 2.4.0 (exact pin). One McpServer factory (createMcpServerFactory in packages/mcp/src/server.ts) backs stdio (serveStdio) and /mcp (createMcpHandler behind the existing McpTransportHandler seam). tools/list and tools/call are still produced from tools.ts, so the tool schemas do not change. Extensions attach in that one factory. The 2025 era is served by the SDK's stateless fallback, set in one constant in http-transport.ts, which becomes 'reject' when the era is retired. Skills are one folder per skill under packages/mcp/skills, served through one SkillCatalog, embedded into the API Lambda bundle at build time.

Options considered:
1. Stay on SDK 1.x and implement skills/list and skills/get by hand in the dispatcher. No dependency change, but we would own an extension that is still changing, and stdio and /mcp would each need it.
2. Move only /mcp to 2.x and keep 1.x for stdio. Two SDK majors and two server definitions, which is the fork the shared factory exists to avoid.
3. Move both transports to 2.x with one factory (chosen).
4. Publish the guidance as plain MCP resources or prompts on 1.x. No client loads these on its own, so it does not solve the problem.

## Scope
packages/mcp (server, transports, tools, skills), the API Lambda's /mcp seam in packages/api/src/mcp-seam.ts and the bundle in packages/cdk/src/api-asset.ts. The e2e client in e2e/src/mcp-client.ts stays on SDK 1.x on purpose, as the probe for the 2025 era.

## Consequences
- Both protocol eras are served from one factory, and a new extension (Events, Apps) attaches in one place.
- The seam has no streaming, so subscriptions/listen is refused and the server advertises tools.listChanged false.
- The stateless 2025 leg answers over SSE, so the seam unwraps single events to JSON as the old handler did. Both are legacy-only code that goes when the era is retired.
- skills attach is experimental in 2.4.0, so the version stays pinned and each upgrade is reviewed.
- The API bundle grows by about 340 KB.
- Clients without Skills support (Claude Desktop, Kiro) get a short instructions text instead of the skill.
