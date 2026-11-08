/**
 * Capability negotiation.
 *
 * The running server's `initialize` advertisement is authoritative. API and MCP
 * gate every optional/extension request on {@link Capabilities}, NEVER on a CLI
 * version. `capabilities()` derives a normalized {@link Capabilities} from the
 * raw initialize result and {@link hasExtensionMethod} answers "is extension
 * method X advertised?".
 */

/** A configuration option advertised by the agent (model, effortLevel, ...). */
export interface ConfigOption {
  configId: string;
  values?: string[];
  [key: string]: unknown;
}

/** A mode advertised by the agent. */
export interface Mode {
  modeId: string;
  name?: string;
  [key: string]: unknown;
}

/** Normalized, queryable view of the agent's advertised capabilities. */
export interface Capabilities {
  /** `agentCapabilities._meta.kiro.extensionMethods`. */
  extensionMethods: readonly string[];
  /** Advertised session sources (e.g. local, remote). */
  sessionSources: readonly string[];
  /** Advertised session/list scopes. */
  listScopes: readonly string[];
  /** Advertised execution targets. */
  executionTargets: readonly string[];
  /** Advertised configuration options, keyed by configId. */
  configOptions: readonly ConfigOption[];
  /** Advertised modes. */
  modes: readonly Mode[];
  /** Model ids derived from the `model` config option values. */
  models: readonly string[];
  /** Whether the agent advertised replay marking. */
  replayMarking: boolean;
  /**
   * Whether cloud/remote execution is genuinely advertised.
   *
   * Derived as a faithful OR of several plausible signals rather than from a
   * single literal key/value. The real kiro-cli v3 initialize shape is not
   * known in this sandbox, and a live run showed the advertised
   * executionTargets coming back EMPTY even though cloud-related extension
   * methods were present. Deriving from multiple keys keeps the launch
   * decision resilient so the ACP cloud path is preferred whenever cloud or
   * remote execution is actually offered, with headless as a true last resort.
   */
  cloudExecution: boolean;
}

/** Raw `initialize` result shape (only the fields we read). */
export interface InitializeResult {
  protocolVersion?: number;
  agentCapabilities?: {
    _meta?: {
      kiro?: {
        extensionMethods?: unknown;
        sessionSources?: unknown;
        /**
         * Advertised session/list scopes. The real kiro-cli v3 agent sends
         * `sessionListScopes`; `listScopes` was an earlier guess kept for
         * back-compat. {@link capabilities} prefers `sessionListScopes`.
         */
        sessionListScopes?: unknown;
        listScopes?: unknown;
        executionTargets?: unknown;
        replayMarking?: unknown;
        [key: string]: unknown;
      };
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  configOptions?: unknown;
  modes?: unknown;
  /**
   * Alternate location some advertisements may use for execution targets (the
   * real v3 shape is unknown in-sandbox). Read defensively in addition to the
   * canonical agentCapabilities._meta.kiro.executionTargets location.
   */
  executionTargets?: unknown;
  [key: string]: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
}

/**
 * Normalize an advertised execution-targets value to a string[].
 *
 * Accepts the canonical bare-string array, but also tolerates entries shaped
 * as objects carrying an id/name/target field (the real v3 shape is unknown
 * in-sandbox, so we do not assume a single representation). Anything else is
 * dropped.
 */
function normalizeTargets(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      out.push(entry);
      continue;
    }
    if (typeof entry === "object" && entry !== null) {
      const obj = entry as Record<string, unknown>;
      const candidate = obj.id ?? obj.name ?? obj.target;
      if (typeof candidate === "string") {
        out.push(candidate);
      }
    }
  }
  return out;
}

function asConfigOptions(value: unknown): ConfigOption[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (v): v is ConfigOption =>
      typeof v === "object" && v !== null && typeof (v as ConfigOption).configId === "string",
  );
}

function asModes(value: unknown): Mode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (v): v is Mode => typeof v === "object" && v !== null && typeof (v as Mode).modeId === "string",
  );
}

/** Derive normalized {@link Capabilities} from a raw `initialize` result. */
export function capabilities(init: InitializeResult): Capabilities {
  const kiro = init.agentCapabilities?._meta?.kiro ?? {};
  const configOptions = asConfigOptions(init.configOptions);
  const modelOption = configOptions.find((o) => o.configId === "model");

  // executionTargets may live under the canonical kiro key OR a top-level key;
  // either may use bare strings or object-shaped entries. Normalize both.
  const executionTargets =
    kiro.executionTargets !== undefined
      ? normalizeTargets(kiro.executionTargets)
      : normalizeTargets(init.executionTargets);
  const extensionMethods = asStringArray(kiro.extensionMethods);
  const sessionSources = asStringArray(kiro.sessionSources);
  // The real v3 agent advertises `sessionListScopes`; `listScopes` was an
  // earlier guess. Prefer sessionListScopes when it yields a non-empty array,
  // otherwise fall back to the legacy `listScopes` key. The derived field name
  // stays `listScopes` so downstream consumers are unchanged.
  const sessionListScopes = asStringArray(kiro.sessionListScopes);
  const listScopes =
    sessionListScopes.length > 0 ? sessionListScopes : asStringArray(kiro.listScopes);

  // Cloud/remote execution is derived from a faithful OR of genuine signals
  // (see the Capabilities.cloudExecution doc comment for why this is resilient
  // rather than keyed on a single literal value).
  const cloudExecution =
    executionTargets.some((t) => /cloud|remote/i.test(t)) ||
    sessionSources.some((s) => /remote|cloud/i.test(s)) ||
    listScopes.some((s) => /cloud|remote/i.test(s)) ||
    extensionMethods.some((m) => /cloud|remote/i.test(m));

  return {
    extensionMethods,
    sessionSources,
    listScopes,
    executionTargets,
    configOptions,
    modes: asModes(init.modes),
    models: asStringArray(modelOption?.values),
    replayMarking: kiro.replayMarking === true,
    cloudExecution,
  };
}

/**
 * The cloud execution target / session source selected for session/new.
 *
 * A `null` field means nothing suitable was advertised AND no override was
 * supplied, so the caller must decide (FEAT-002 fails the launch LOUDLY rather
 * than silently creating an invisible local session).
 */
export interface ResolvedCloudTarget {
  executionTarget: string | null;
  sessionSource: string | null;
}

/**
 * Pick the cloud execution target + remote session source to request on
 * session/new so the agent provisions a real cloud Space (visible in
 * app.kiro.dev) instead of defaulting to source='local' and running inside the
 * bridge container.
 *
 * Selection is STRING-DRIVEN off the live advertisement, never a single
 * hardcoded literal: the exact ACP V3 session/new field name/shape is NOT
 * observable in this sandbox (kiro.dev/docs is JS-rendered and exposes no wire
 * shape; Docker + real kiro-cli are unavailable), so we match the advertised
 * strings and let the next live redeploy confirm the wire shape via the
 * redacted acp_rpc_request logs in transport.ts. The choice is:
 *  - an explicit override always wins (set via KIRO_EXECUTION_TARGET /
 *    KIRO_SESSION_SOURCE so the strings are correctable without a code change);
 *  - otherwise the execution target is the advertised entry matching
 *    /cloud|remote/i, preferring an exact 'cloud-sandbox' when present;
 *  - otherwise the session source is the advertised entry matching
 *    /remote|cloud/i, preferring an exact 'remote' when present;
 *  - `null` for a field when nothing suitable is advertised and no override was
 *    given.
 */
export function resolveCloudTarget(
  caps: Capabilities,
  overrides?: { executionTarget?: string; sessionSource?: string },
): ResolvedCloudTarget {
  const pick = (values: readonly string[], match: RegExp, preferred: string): string | null => {
    const exact = values.find((v) => v === preferred);
    if (exact) {
      return exact;
    }
    return values.find((v) => match.test(v)) ?? null;
  };

  const executionTarget =
    overrides?.executionTarget ?? pick(caps.executionTargets, /cloud|remote/i, "cloud-sandbox");
  const sessionSource =
    overrides?.sessionSource ?? pick(caps.sessionSources, /remote|cloud/i, "remote");

  return {
    executionTarget: executionTarget ?? null,
    sessionSource: sessionSource ?? null,
  };
}

/** True when the given extension method was advertised by the running server. */
export function hasExtensionMethod(caps: Capabilities, method: string): boolean {
  return caps.extensionMethods.includes(method);
}

/** True when the given model id is offered by the advertised model config. */
export function supportsModel(caps: Capabilities, model: string): boolean {
  return caps.models.includes(model);
}
