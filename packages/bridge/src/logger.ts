/**
 * Structured JSON logging for the bridge.
 *
 * EVERY structured log line is routed through core's {@link redact} before it
 * is written, so a Kiro API key (ksk_), bearer token, or OAuth URL can never
 * escape into logs even if a caller forgets to scrub a field. The bridge also
 * NEVER logs the `_kiro/openExternalUrl` URL at all (it is stored as a pending
 * action, not logged).
 */

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
  now?: () => number;
  /**
   * Environment to read the default level from (defaults to `process.env`).
   * Injectable so tests can exercise the env-level behaviour deterministically.
   */
  env?: NodeJS.ProcessEnv;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

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
  const now = opts.now ?? (() => Date.now());

  function log(lineLevel: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (LEVEL_ORDER[lineLevel] < LEVEL_ORDER[level]) {
      return;
    }
    const record = {
      ts: new Date(now()).toISOString(),
      level: lineLevel,
      msg,
      ...bindings,
      ...(fields ?? {}),
    };
    // Redact the WHOLE record (keys + values) before serializing.
    sink(JSON.stringify(redact(record)));
  }

  return {
    debug: (msg, fields) => log("debug", msg, fields),
    info: (msg, fields) => log("info", msg, fields),
    warn: (msg, fields) => log("warn", msg, fields),
    error: (msg, fields) => log("error", msg, fields),
    child: (childBindings) =>
      createLogger({ level, sink, bindings: { ...bindings, ...childBindings }, now }),
  };
}
