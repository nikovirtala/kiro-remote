/**
 * Unit tests for the production context-from-env builder. AWS SDK client
 * construction is stubbed by injecting fake clients so nothing touches the
 * network.
 */

import { PowertoolsObservability } from "@nikovirtala/kiro-remote-api";
import { describe, expect, it } from "vitest";
import { buildContextFromEnv } from "../src/lambda/context-from-env.ts";

/** A fake AWS client that captures sends but never hits the network. */
class FakeClient {
  // biome-ignore lint/suspicious/noExplicitAny: command input is dynamic.
  readonly sent: any[] = [];
  // biome-ignore lint/suspicious/noExplicitAny: command is dynamic.
  async send(command: any): Promise<Record<string, unknown>> {
    this.sent.push(command);
    return {};
  }
}

function env(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    AWS_REGION: "eu-west-1",
    TABLE_NAME: "kiro-remote",
    BUCKET_NAME: "kiro-remote-bucket",
    COMMAND_QUEUE_URL: "https://sqs.eu-west-1.amazonaws.com/123/cmd.fifo",
    PUBLIC_BASE_URL: "https://kiro.example.com",
    MCP_RESOURCE: "https://kiro.example.com/mcp",
    COGNITO_USER_POOL_ID: "eu-west-1_abc123",
    COGNITO_CLIENT_ID: "cognito-app-client",
    OAUTH_CODE_KMS_KEY_ID: "key-1",
    COGNITO_DOMAIN: "https://kiro-remote.auth.eu-west-1.amazoncognito.com",
    CIMD_ALLOWED_HOSTS: "claude.ai,kiro.example.com",
    ALLOWED_REPOS: "acme/*,me/repo",
    ...overrides,
  };
}

function clients() {
  return {
    // biome-ignore lint/suspicious/noExplicitAny: fakes stand in for SDK clients.
    ddb: new FakeClient() as any,
    // biome-ignore lint/suspicious/noExplicitAny: fakes stand in for SDK clients.
    s3: new FakeClient() as any,
    // biome-ignore lint/suspicious/noExplicitAny: fakes stand in for SDK clients.
    sqs: new FakeClient() as any,
    // biome-ignore lint/suspicious/noExplicitAny: fakes stand in for SDK clients.
    kms: new FakeClient() as any,
  };
}

describe("buildContextFromEnv", () => {
  it("assembles a fully-populated ApiContext from env vars", () => {
    const ctx = buildContextFromEnv({ env: env(), clients: clients() });

    expect(ctx.publicBaseUrl).toBe("https://kiro.example.com");
    expect(ctx.resourceMetadataUrl).toBe(
      "https://kiro.example.com/.well-known/oauth-protected-resource/mcp",
    );
    expect(ctx.service.allowedRepos).toEqual(["acme/*", "me/repo"]);
    expect(ctx.auth.resourceIdentifier).toBe("https://kiro.example.com/mcp");
    expect(ctx.auth.allowedClientIds).toContain("cognito-app-client");
    expect(ctx.facade.config.kmsKeyId).toBe("key-1");
    expect(ctx.facade.config.publicBaseUrl).toBe("https://kiro.example.com");
    expect(ctx.facade.config.mcpResource).toBe("https://kiro.example.com/mcp");
    expect(ctx.facade.config.cognitoClientId).toBe("cognito-app-client");
    expect(ctx.facade.config.scopesSupported).toEqual([
      "sessions:read",
      "sessions:write",
      "sessions:delete",
    ]);
    expect(ctx.facade.config.cimdAllowedHosts).toEqual(["claude.ai", "kiro.example.com"]);
    expect(ctx.obs).toBeInstanceOf(PowertoolsObservability);
    // mcp is left unset here (no injected transport) so /mcp keeps the 501 seam.
    expect(ctx.mcp).toBeUndefined();
  });

  it("derives the Cognito JWKS URI from region + user pool id", () => {
    const ctx = buildContextFromEnv({ env: env(), clients: clients() });
    expect(ctx.facade.config.cognitoJwksUri).toBe(
      "https://cognito-idp.eu-west-1.amazonaws.com/eu-west-1_abc123/.well-known/jwks.json",
    );
  });

  it("strips a trailing slash from PUBLIC_BASE_URL", () => {
    const ctx = buildContextFromEnv({
      env: env({ PUBLIC_BASE_URL: "https://kiro.example.com/" }),
      clients: clients(),
    });
    expect(ctx.publicBaseUrl).toBe("https://kiro.example.com");
    expect(ctx.resourceMetadataUrl).toBe(
      "https://kiro.example.com/.well-known/oauth-protected-resource/mcp",
    );
  });

  it("kiroCliVersion resolves to null until the bridge initializes CONFIG#CAPS", async () => {
    const ctx = buildContextFromEnv({ env: env(), clients: clients() });
    await expect(ctx.kiroCliVersion()).resolves.toBeNull();
  });

  it("capabilities falls back to the empty set when CONFIG#CAPS is absent", async () => {
    const ctx = buildContextFromEnv({ env: env(), clients: clients() });
    // FakeClient.send returns {} so getCaps() resolves to null -> empty caps.
    const caps = await ctx.capabilities();
    expect(caps.extensionMethods).toEqual([]);
    expect(caps.models).toEqual([]);
    expect(caps.replayMarking).toBe(false);
  });

  it("wires ctx.mcp when a transport handler is injected", () => {
    const mcp = {
      async handle() {
        return { status: 200, headers: {}, body: "{}" };
      },
    };
    const ctx = buildContextFromEnv({ env: env(), clients: clients(), mcp });
    expect(ctx.mcp).toBe(mcp);
  });

  it("throws a clear error when a required env var is missing", () => {
    const incomplete = env();
    delete incomplete.TABLE_NAME;
    expect(() => buildContextFromEnv({ env: incomplete, clients: clients() })).toThrow(
      "missing required environment variable: TABLE_NAME",
    );
  });
});
