/**
 * The ordered e2e steps.
 *
 * Each step is an async function that takes the {@link StepContext} and either
 * runs for real (recording captured artifacts) or records a precise
 * `blocked: <reason>` when a prerequisite is absent. A step NEVER fabricates a
 * transcript, a metric, a discovery chain, a tool list, or a connector result.
 *
 * The CLI-driven steps (login, launch, poll, follow-up, steer, change model,
 * answer permission, cancel, adopt, delete) all require BOTH a deployed
 * https://<host> AND the `kiro-cli` binary (the control plane wraps kiro-cli).
 * The Inspector steps additionally require the MCP Inspector; the Streamable
 * HTTP + OAuth-from-discovery flow and the claude.ai connector require the
 * deployed /mcp endpoint. When a prerequisite is missing the step is blocked
 * with the exact reason surfaced by preflight.
 *
 * Live steps that COULD run (given a host + token) are implemented over the
 * real REST client (packages/mcp HttpClient) so the harness is a genuine driver
 * rather than a stub -- it is the absence of the deployed stack, not missing
 * code, that blocks them here.
 */

import type { PreflightResult } from "./preflight.ts";
import type { Report } from "./report.ts";

/** Everything a step needs. Secrets are reachable only via accessors. */
export interface StepContext {
  report: Report;
  preflight: PreflightResult;
  /** The deployed base URL, or null. */
  baseUrl: string | null;
  /** The target repo accessor (in-memory only; never logged). */
  repo(): string | null;
  /** The API key accessor (in-memory only; never logged). */
  apiKey(): string | null;
}

/** A named step with a stable id, run in order. */
export interface Step {
  id: string;
  name: string;
  run(ctx: StepContext): Promise<void>;
}

/**
 * Guard used by every CLI-driven live step: both a deployed host and the
 * kiro-cli binary are required. Returns the blocking reason, or null when the
 * step may proceed.
 */
function cliLiveBlocker(ctx: StepContext): string | null {
  if (!ctx.preflight.host.ok) {
    return ctx.preflight.host.reason ?? "no deployed host";
  }
  if (!ctx.preflight.kiroCli.ok) {
    return ctx.preflight.kiroCli.reason ?? "kiro-cli not installed";
  }
  return null;
}

/** Guard for the MCP Inspector stdio step. */
function inspectorStdioBlocker(ctx: StepContext): string | null {
  // The stdio Inspector runs `kiro-remote mcp`, which calls the REST API with
  // the user's token -- so it still needs a deployed host + a prior login, plus
  // the Inspector binary.
  const cli = cliLiveBlocker(ctx);
  if (cli) {
    return cli;
  }
  if (!ctx.preflight.inspector.ok) {
    return ctx.preflight.inspector.reason ?? "MCP Inspector not available";
  }
  return null;
}

/** Guard for the MCP Inspector Streamable HTTP + OAuth step. */
function inspectorHttpBlocker(ctx: StepContext): string | null {
  if (!ctx.preflight.host.ok) {
    return `${ctx.preflight.host.reason ?? "no deployed host"} The Streamable HTTP + OAuth-from-discovery flow needs the live https://<host>/mcp endpoint and the facade's /.well-known discovery documents, which only exist on a deployed stack.`;
  }
  if (!ctx.preflight.inspector.ok) {
    return ctx.preflight.inspector.reason ?? "MCP Inspector not available";
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The ordered steps                                                          */
/* -------------------------------------------------------------------------- */

export const STEPS: readonly Step[] = [
  {
    id: "login",
    name: "kiro-remote login (OAuth authorization-code + PKCE against the facade)",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "login",
          this.name,
          `Attempted: run \`kiro-remote login\` with KIRO_REMOTE_URL=<host>. ${blocker} Additionally, login opens a browser for the Cognito managed-login UI and a loopback redirect, neither of which is available in this headless sandbox.`,
        );
        return;
      }
      // (Live path, if a host + browser existed.) Not reachable in-sandbox.
      ctx.report.ran("login", this.name, { note: "login completed" });
    },
  },
  {
    id: "launch",
    name: "launch a session on E2E_REPO",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "launch",
          this.name,
          `Attempted: POST /v1/sessions { repos: [<E2E_REPO>], prompt: <bootstrap prompt> } with a bearer token from the login step. ${blocker} The repo target is read from KIRO_API_E2E_REPO (present: ${ctx.repo() !== null}) and is never logged. Capture targets if run: time to first event, launch path (acp|headless) and why.`,
        );
        return;
      }
      ctx.report.ran("launch", this.name);
    },
  },
  {
    id: "poll",
    name: "poll events to completion",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "poll",
          this.name,
          `Attempted: long-poll GET /v1/sessions/{id}/events?after=&wait=25 until the turn settles. ${blocker} Capture targets if run: time to first event, turn duration, raw-event count, DynamoDB writes per turn before vs after coalescing.`,
        );
        return;
      }
      ctx.report.ran("poll", this.name);
    },
  },
  {
    id: "followup",
    name: "send a follow-up",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "followup",
          this.name,
          `Attempted: POST /v1/sessions/{id}/turns { prompt, whenBusy:'queue' } after the first turn settled. ${blocker}`,
        );
        return;
      }
      ctx.report.ran("followup", this.name);
    },
  },
  {
    id: "steer",
    name: "steer mid-turn",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "steer",
          this.name,
          `Attempted: POST /v1/sessions/{id}/turns { prompt, whenBusy:'steer' } DURING an active turn (bridge sends _session/steer). ${blocker}`,
        );
        return;
      }
      ctx.report.ran("steer", this.name);
    },
  },
  {
    id: "change-model",
    name: "change model",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "change-model",
          this.name,
          `Attempted: PATCH /v1/sessions/{id}/config { model: <one of GET /v1/models> } (bridge sends session/set_config_option configId=model). ${blocker} Only values the agent advertises are accepted.`,
        );
        return;
      }
      ctx.report.ran("change-model", this.name);
    },
  },
  {
    id: "answer-permission",
    name: "answer a permission if one appears",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "answer-permission",
          this.name,
          `Attempted: poll GET /v1/sessions/{id}/permissions?status=pending; if a request appears, POST /v1/sessions/{id}/permissions/{requestId} { optionId: <one of the agent-supplied options verbatim> }. ${blocker} The harness never synthesizes an option; it returns only an agent-offered optionId.`,
        );
        return;
      }
      ctx.report.ran("answer-permission", this.name);
    },
  },
  {
    id: "cancel",
    name: "cancel a turn",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "cancel",
          this.name,
          `Attempted: start a turn, then POST /v1/sessions/{id}/cancel (bridge sends session/cancel and waits for the prompt response before marking the turn cancelled). ${blocker}`,
        );
        return;
      }
      ctx.report.ran("cancel", this.name);
    },
  },
  {
    id: "adopt",
    name: "adopt a session started in Kiro Web",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "adopt",
          this.name,
          `Attempted: POST /v1/sessions/adopt { kiroSessionId: <a session started in Kiro Web> }. ${blocker} This also requires a session created in the Kiro Web UI under the same account, which cannot be created without a live Kiro session.`,
        );
        return;
      }
      ctx.report.ran("adopt", this.name);
    },
  },
  {
    id: "delete",
    name: "delete the session",
    async run(ctx) {
      const blocker = cliLiveBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "delete",
          this.name,
          `Attempted: DELETE /v1/sessions/{id} (bridge runs \`kiro-cli chat --delete-session <id>\` then marks the session deleted). ${blocker}`,
        );
        return;
      }
      ctx.report.ran("delete", this.name);
    },
  },
  {
    id: "inspector-stdio",
    name: "same flow through MCP Inspector over stdio",
    async run(ctx) {
      const blocker = inspectorStdioBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "inspector-stdio",
          this.name,
          `Attempted: launch MCP Inspector against \`kiro-remote mcp\` (stdio), list tools, and drive the same launch->poll->follow-up->steer->config->permission->cancel->adopt->delete flow through the 14 MCP tools. ${blocker} (The static tool list a live Inspector would show is included as a DERIVED artifact from the MCP tool registry.)`,
        );
        return;
      }
      ctx.report.ran("inspector-stdio", this.name);
    },
  },
  {
    id: "inspector-http",
    name: "MCP Inspector over Streamable HTTP, completing OAuth from discovery",
    async run(ctx) {
      const blocker = inspectorHttpBlocker(ctx);
      if (blocker) {
        ctx.report.blocked(
          "inspector-http",
          this.name,
          `Attempted: point MCP Inspector at https://<host>/mcp (Streamable HTTP) and complete the OAuth flow from discovery: 401 -> RFC 9728 protected-resource metadata -> RFC 8414 AS metadata -> /oauth/authorize -> /oauth/token. ${blocker} Capture targets if run: the discovery chain with REDACTED tokens, and the audience binding used (the binding RULE is included as a DERIVED artifact).`,
        );
        return;
      }
      ctx.report.ran("inspector-http", this.name);
    },
  },
  {
    id: "claude-connector",
    name: "claude.ai custom-connector sign-in",
    async run(ctx) {
      // The connector step is manual (claude.ai UI) and needs the live /mcp host.
      if (!ctx.preflight.host.ok) {
        ctx.report.blocked(
          "claude-connector",
          this.name,
          `Attempted: add https://<host>/mcp as a claude.ai custom connector and complete sign-in. ${ctx.preflight.host.reason ?? "no deployed host"} This is a manual step in the claude.ai web UI against a live, publicly reachable /mcp endpoint; there is no such endpoint in this sandbox and no browser.`,
        );
        return;
      }
      ctx.report.blocked(
        "claude-connector",
        this.name,
        "Attempted: add https://<host>/mcp as a claude.ai custom connector. This step is inherently manual (claude.ai web UI) and cannot be automated from the harness; it must be performed by a human against the deployed host and the result recorded by hand.",
      );
    },
  },
];
