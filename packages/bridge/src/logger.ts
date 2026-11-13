/**
 * Structured JSON logging for the bridge.
 *
 * EVERY structured log line is routed through core's {@link redact} before it
 * is written, so a Kiro API key (ksk_), bearer token, or OAuth URL can never
 * escape into logs even if a caller forgets to scrub a field. The bridge also
 * NEVER logs the `_kiro/openExternalUrl` URL at all (it is stored as a pending
 * action, not logged).
 *
 * The lines are produced by the Powertools Logger, but its console output is
 * replaced by a sink: ACP uses stdout for JSON-RPC, so the default sink writes
 * to stderr and Powertools never touches stdout.
 */

import { type LogItem, Logger as PowertoolsLogger } from "@aws-lambda-powertools/logger";
import { redact } from "@nikovirtala/kiro-remote-core";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/** Sink that receives the final (already-redacted) JSON line. Default: stderr. */
export type LogSink = (line: string) => void;

const defaultSink: LogSink = (line) => {
  // ACP uses stdout for JSON-RPC, so all logs go to stderr.
  process.stderr.write(`${line}\n`);
};

export interface LoggerOptions {
  level?: LogLevel;
  sink?: LogSink;
  bindings?: Record<string, unknown>;
  /**
   * Environment to read the default level from (defaults to `process.env`).
   * Injectable so tests can exercise the env-level behaviour deterministically.
   */
  env?: NodeJS.ProcessEnv;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SERVICE_NAME = "kiro-remote-bridge";

/**
 * A Powertools Logger whose output goes to a {@link LogSink} (stderr by
 * default) and whose WHOLE record (keys and values) is run through
 * {@link redact} right before it is written.
 */
class RedactingLogger extends PowertoolsLogger {
  // Powertools may log from inside super() (e.g. reserved-key warnings), before
  // this field is assigned, so printLog falls back to the default sink.
  private readonly sink?: LogSink;

  constructor(sink: LogSink, level: LogLevel, bindings: Record<string, unknown>) {
    super({
      serviceName: SERVICE_NAME,
      logLevel: level.toUpperCase() as Uppercase<LogLevel>,
      persistentKeys: bindings,
    });
    this.sink = sink;
  }

  protected override printLog(_logLevel: number, log: LogItem): void {
    log.prepareForPrint();
    (this.sink ?? defaultSink)(JSON.stringify(redact(log.getAttributes()), this.getJsonReplacer()));
  }
}

/** Parse a LogLevel from a raw env value; returns undefined for anything invalid. */
function parseLogLevel(raw: string | undefined): LogLevel | undefined {
  if (raw && Object.hasOwn(LEVEL_ORDER, raw)) {
    return raw as LogLevel;
  }
  return undefined;
}

export function createLogger(opts: LoggerOptions = {}): Logger {
  const env = opts.env ?? process.env;
  // Precedence: explicit opts.level > BRIDGE_LOG_LEVEL env > "info". An invalid
  // env value is ignored (falls back to info) so a typo never silences logs.
  const level = opts.level ?? parseLogLevel(env.BRIDGE_LOG_LEVEL) ?? "info";
  const sink = opts.sink ?? defaultSink;
  const bindings = opts.bindings ?? {};
  const pt = new RedactingLogger(sink, level, bindings);

  return {
    debug: (msg, fields) => pt.debug(msg, fields ?? {}),
    info: (msg, fields) => pt.info(msg, fields ?? {}),
    warn: (msg, fields) => pt.warn(msg, fields ?? {}),
    error: (msg, fields) => pt.error(msg, fields ?? {}),
    child: (childBindings) =>
      createLogger({ level, sink, bindings: { ...bindings, ...childBindings } }),
  };
}
