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
}

/** Raw `initialize` result shape (only the fields we read). */
export interface InitializeResult {
  protocolVersion?: number;
  agentCapabilities?: {
    _meta?: {
      kiro?: {
        extensionMethods?: unknown;
        sessionSources?: unknown;
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
  [key: string]: unknown;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((v): v is string => typeof v === "string");
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

  return {
    extensionMethods: asStringArray(kiro.extensionMethods),
    sessionSources: asStringArray(kiro.sessionSources),
    listScopes: asStringArray(kiro.listScopes),
    executionTargets: asStringArray(kiro.executionTargets),
    configOptions,
    modes: asModes(init.modes),
    models: asStringArray(modelOption?.values),
    replayMarking: kiro.replayMarking === true,
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
