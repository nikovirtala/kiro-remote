/**
 * Persist the running agent's advertised capabilities as the durable
 * CONFIG#CAPS item.
 *
 * The REST API (`GET /v1/capabilities`), the lambda capability gate, and the
 * MCP `kiro_capabilities` tool all READ this item via `repo.getCaps()` and
 * reconstruct the normalized capabilities with core's `deriveCapabilities`
 * applied to the stored RAW initialize result. For that reconstruction to
 * reproduce the advertisement, the bridge MUST store the RAW
 * `gateway.initializeResult` here, NOT the normalized Capabilities object.
 *
 * This runs after `gateway.initialize()` at BOTH bridge init points (serve
 * start and supervisor reconnect). It is try/catch guarded so a persistence
 * failure logs a warning and never crashes startup or reconnect; the bridge
 * keeps operating and the next reconnect retries the write.
 */

import {
  type InitializeResult,
  kiroCliVersion,
  type Repository,
  redact,
} from "@nikovirtala/kiro-remote-core";
import type { AcpGateway } from "./gateway.ts";
import type { Logger } from "./logger.ts";

export interface PersistCapsOptions {
  /**
   * The kiro-cli version the running engine came from. Used only when the
   * initialize result reports no `agentInfo.version`: the direct KAS engine
   * (Lambda path) omits `agentInfo`, which kiro-cli added when it relayed ACP.
   * The Lambda image sets it from its KIRO_CLI_VERSION build arg.
   */
  kiroCliVersion?: string;
}

/**
 * The initialize result to store: the raw result, plus `agentInfo.version`
 * from {@link PersistCapsOptions.kiroCliVersion} when the agent reported none.
 * Adding `agentInfo` does not change what `deriveCapabilities` reads.
 */
export function withAgentVersion(
  init: InitializeResult,
  fallbackVersion: string | undefined,
): InitializeResult {
  const version = fallbackVersion?.trim();
  if (!version || kiroCliVersion(init) !== null) {
    return init;
  }
  return {
    ...init,
    agentInfo: { name: "kiro-cli", ...(init.agentInfo ?? {}), version },
  };
}

/**
 * Write CONFIG#CAPS from the gateway's latest initialize advertisement. Logs a
 * redaction-safe `config_caps_persisted` confirmation on success, or a
 * `config_caps_persist_failed` warning on failure (continuing either way).
 */
export async function persistCaps(
  repo: Repository,
  gateway: AcpGateway,
  logger: Logger,
  options: PersistCapsOptions = {},
): Promise<void> {
  try {
    const caps = gateway.capabilities();
    const initializeResult = withAgentVersion(gateway.initializeResult, options.kiroCliVersion);
    // initializeResult MUST be (and remains) the RAW initialize result so the
    // read side (deriveCapabilities(caps.initializeResult)) reproduces the
    // advertisement. It is run through core's redact() first so that if the
    // (still-unknown) real kiro-cli v3 initialize result ever carries a
    // token/key/signed-URL under some field, that secret is scrubbed before it
    // lands in DynamoDB. redact() only replaces sensitive KEY names and
    // secret-pattern string VALUES, so the non-secret capability name arrays
    // (extensionMethods, executionTargets, sessionSources, listScopes,
    // configOptions, modes, protocolVersion) pass through unchanged and the
    // round-trip is preserved.
    await repo.putCaps({
      initializeResult: redact(initializeResult) as Record<string, unknown>,
      extensionMethods: [...caps.extensionMethods],
      configOptions: [...caps.configOptions],
      modes: [...caps.modes],
    });
    // GET /v1/models reads the separate CONFIG#MODELS item, which otherwise
    // stays empty. The model ids are derivable from the advertised `model`
    // config option (caps.models), so persist them with a descriptive source.
    if (caps.models.length > 0) {
      await repo.putModels([...caps.models], "config_option");
    }
    logger.info("config_caps_persisted", {
      kiroCliVersion: kiroCliVersion(initializeResult),
      extensionMethodCount: caps.extensionMethods.length,
      modeCount: caps.modes.length,
      configOptionCount: caps.configOptions.length,
      modelCount: caps.models.length,
      cloudExecution: caps.cloudExecution,
    });
  } catch (err) {
    // A persistence failure must not kill startup/reconnect; the bridge can
    // still operate and will retry on the next reconnect. The error string is
    // routed through the redacting logger like every other record.
    logger.warn("config_caps_persist_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
