#!/usr/bin/env node
/**
 * The `kiro-remote` CLI entry point.
 *
 *   kiro-remote login   -- OAuth authorization-code + PKCE against the facade.
 *   kiro-remote logout  -- revoke the refresh token and clear stored tokens.
 *   kiro-remote whoami  -- print the caller's sub and scopes.
 *   kiro-remote mcp     -- run the stdio MCP transport over the REST API.
 *
 * Config comes from the environment so no secret is ever on the command line:
 *   KIRO_REMOTE_URL  -- the facade / REST API public base URL (required).
 *
 * This file is the thin wiring layer; all logic lives in the testable modules
 * (cli-commands, oauth, loopback, token-provider, http-client, stdio). Nothing
 * here logs tokens, codes, verifiers, or OAuth URLs.
 */

import { consoleIo, loginCommand, logoutCommand, whoamiCommand } from "./cli-commands.ts";
import { HttpClient } from "./http-client.ts";
import { FileKeychain } from "./keychain.ts";
import { createLoopbackRoundtrip } from "./loopback.ts";
import type { OAuthFetch } from "./oauth.ts";
import { redactingLogger } from "./server.ts";
import { runStdio } from "./stdio.ts";
import { KeychainTokenProvider } from "./token-provider.ts";

/** Adapt the global fetch to the {@link OAuthFetch} / http-client FetchLike shape. */
const nodeFetch: OAuthFetch = async (url, init) => {
  const res = await fetch(url, {
    method: init.method,
    headers: init.headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
  return { status: res.status, text: () => res.text() };
};

function requireBaseUrl(): string {
  const url = process.env.KIRO_REMOTE_URL;
  if (!url) {
    consoleIo.err("KIRO_REMOTE_URL is required (the facade / REST API base URL).");
    process.exit(2);
  }
  return url;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const keychain = new FileKeychain();

  switch (command) {
    case "login": {
      await loginCommand({
        baseUrl: requireBaseUrl(),
        fetch: nodeFetch,
        roundtrip: createLoopbackRoundtrip(),
        keychain,
        io: consoleIo,
      });
      return;
    }
    case "logout": {
      await logoutCommand({
        baseUrl: requireBaseUrl(),
        fetch: nodeFetch,
        keychain,
        io: consoleIo,
      });
      return;
    }
    case "whoami": {
      await whoamiCommand({ keychain, io: consoleIo });
      return;
    }
    case "mcp": {
      const baseUrl = requireBaseUrl();
      const tokens = new KeychainTokenProvider({ keychain, fetch: nodeFetch });
      const client = new HttpClient({ baseUrl, tokens, fetch: nodeFetch });
      await runStdio({ client, keychain, logger: redactingLogger });
      return;
    }
    default:
      consoleIo.err("usage: kiro-remote <login|logout|whoami|mcp>");
      process.exit(2);
  }
}

main().catch((err) => {
  // Never print token/code/URL; redact defensively via the io helper.
  consoleIo.err(`error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
