/**
 * @nikovirtala/mcp
 *
 * One MCP server on @modelcontextprotocol/sdk exposed over two transports --
 * the Streamable HTTP transport mounted at /mcp on the API, and the stdio
 * transport run by `kiro-remote mcp` -- both written against the ONE canonical
 * {@link KiroRemoteClient} interface (defined in @nikovirtala/api, implemented
 * here as {@link InProcessClient} and {@link HttpClient}). The 14 tools call
 * only that interface, so they contain no transport-forked logic.
 *
 * Also exports the `kiro-remote` CLI command implementations (login, logout,
 * whoami, mcp) and the keychain / token-provider pieces so the CDK (FEAT-007)
 * can compose the in-process /mcp handler onto the API context.
 */

export const PACKAGE_NAME = "@nikovirtala/mcp";

// CLI + OAuth + storage.
export {
  type CliIo,
  consoleIo,
  type LoginCommandDeps,
  type LogoutCommandDeps,
  loginCommand,
  logoutCommand,
  type WhoamiCommandDeps,
  whoamiCommand,
} from "./cli-commands.ts";
// The single client interface (canonical in @nikovirtala/api) and its impls.
export type { ToolClient } from "./client.ts";
export { InProcessClient, type InProcessClientDeps } from "./client.ts";
export {
  collectEvents,
  finalTranscript,
  MAX_EVENTS,
  MAX_TEXT_CHARS,
  MAX_WAIT_SECONDS,
  type TranscriptResult,
  type WaitForEventsResult,
} from "./events.ts";
export {
  type FetchLike,
  HttpClient,
  type HttpClientDeps,
  HttpClientError,
  type TokenProvider,
} from "./http-client.ts";
// Transports.
export { createHttpTransportHandler, type HttpTransportDeps } from "./http-transport.ts";
export {
  defaultTokenPath,
  FileKeychain,
  type Keychain,
  MemoryKeychain,
  type StoredTokens,
} from "./keychain.ts";
export {
  createLoopbackRoundtrip,
  defaultOpener,
  type LoopbackDeps,
  type UrlOpener,
} from "./loopback.ts";
export {
  type AuthorizationRoundtrip,
  type CliClientMetadata,
  type LoginDeps,
  type LoginResult,
  login,
  OAuthError,
  type OAuthFetch,
  refresh,
  revoke,
  type TokenSet,
} from "./oauth.ts";
export {
  buildMcpServer,
  type CallToolOutcome,
  callTool,
  InsufficientScopeError,
  type Logger,
  listTools,
  redactingLogger,
  SERVER_NAME,
  SERVER_VERSION,
  silentLogger,
} from "./server.ts";
export { localPrincipal, type RunStdioDeps, runStdio } from "./stdio.ts";
export {
  decodeTokenForDisplay,
  KeychainTokenProvider,
  type KeychainTokenProviderDeps,
  NotLoggedInError,
  type WhoamiView,
} from "./token-provider.ts";
// Tools + dispatch.
export {
  authorizeTool,
  CORE_SCHEMA_FOR_TOOL,
  findTool,
  TOOL_DEFS,
  TOOL_NAMES,
  type ToolAnnotations,
  type ToolDef,
  type ToolListEntry,
  type ToolResult,
  toolListEntries,
} from "./tools.ts";
