/**
 * Preflight prerequisite detection.
 *
 * The live e2e needs, at minimum:
 *   - a deployed control plane (KIRO_REMOTE_URL / the canonical https://<host>),
 *   - the `kiro-cli` binary on PATH (for `kiro-remote login` -> the CLI drives
 *     the OAuth flow and the cloud session launch wraps kiro-cli),
 *   - the MCP Inspector (`@modelcontextprotocol/inspector`) for the Inspector
 *     steps.
 *
 * Preflight detects each prerequisite and returns a precise, non-fabricated
 * reason when one is absent, so a step can be recorded as `blocked: <reason>`
 * rather than hanging or inventing output. The probes are injectable so tests
 * exercise both present and absent cases without touching the real system.
 */

/** Injectable probes so tests can simulate present/absent prerequisites. */
export interface PreflightProbes {
  /** Resolve the absolute path of a binary on PATH, or null when not found. */
  which(binary: string): Promise<string | null>;
}

/** The result of one prerequisite check. */
export interface PrereqCheck {
  ok: boolean;
  /** Present only when !ok: the exact reason the prerequisite is unmet. */
  reason?: string;
}

/** All prerequisite checks for a run. */
export interface PreflightResult {
  host: PrereqCheck;
  kiroCli: PrereqCheck;
  inspector: PrereqCheck;
}

/** Check the deployed-host prerequisite from config (no I/O). */
export function checkHost(baseUrl: string | null): PrereqCheck {
  if (baseUrl === null) {
    return {
      ok: false,
      reason:
        "KIRO_REMOTE_URL is unset: no control plane has been deployed in this sandbox, so there is no https://<host> to target. Deploying the CDK stack is out of scope here (it also requires the bridge container image, which cannot be built -- see the Docker blocker).",
    };
  }
  return { ok: true };
}

/** Check that `kiro-cli` is on PATH. */
export async function checkKiroCli(probes: PreflightProbes): Promise<PrereqCheck> {
  const found = await probes.which("kiro-cli");
  if (found === null) {
    return {
      ok: false,
      reason:
        "`kiro-cli` is not installed and not on PATH (command not found). The control plane wraps kiro-cli to drive cloud sessions; without it `kiro-remote login`, launch, poll, follow-up, steer, model-change, permission, cancel, adopt, and delete cannot run live. kiro-cli targets linux/arm64 and is normally installed into the bridge container image at deploy time.",
    };
  }
  return { ok: true };
}

/** Check that the MCP Inspector CLI is available. */
export async function checkInspector(probes: PreflightProbes): Promise<PrereqCheck> {
  const found = await probes.which("mcp-inspector");
  if (found === null) {
    return {
      ok: false,
      reason:
        "The MCP Inspector (@modelcontextprotocol/inspector) is not installed/available. The stdio Inspector flow needs the `kiro-remote mcp` server plus the Inspector binary; the Streamable HTTP + OAuth-from-discovery flow additionally needs the deployed https://<host>/mcp endpoint, which does not exist in this sandbox.",
    };
  }
  return { ok: true };
}

/** Run all prerequisite checks. */
export async function preflight(
  baseUrl: string | null,
  probes: PreflightProbes,
): Promise<PreflightResult> {
  return {
    host: checkHost(baseUrl),
    kiroCli: await checkKiroCli(probes),
    inspector: await checkInspector(probes),
  };
}
