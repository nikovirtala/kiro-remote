/**
 * The bridge logger's level resolution.
 *
 * Operators must be able to raise/lower verbosity WITHOUT a redeploy, so the
 * default level honors the BRIDGE_LOG_LEVEL env var. Precedence is:
 *   explicit opts.level > BRIDGE_LOG_LEVEL env > "info".
 * An invalid env value is ignored (falls back to info) so a typo never silences
 * logs, and every line still routes through redact().
 */

import { describe, expect, test } from "vitest";
import { createLogger, type LogLevel } from "../src/logger.ts";

/** Collect the messages a logger emits at each level for a given config. */
function emittedMsgs(opts: { level?: LogLevel; env?: NodeJS.ProcessEnv }): string[] {
  const lines: string[] = [];
  const logger = createLogger({
    sink: (l) => lines.push(l),
    ...(opts.level ? { level: opts.level } : {}),
    ...(opts.env ? { env: opts.env } : {}),
  });
  logger.debug("dbg");
  logger.info("inf");
  logger.warn("wrn");
  logger.error("err");
  return lines.map((l) => (JSON.parse(l) as { message: string }).message);
}

describe("logger level resolution", () => {
  test("defaults to info when neither opts.level nor env is set", () => {
    expect(emittedMsgs({ env: {} })).toEqual(["inf", "wrn", "err"]);
  });

  test("BRIDGE_LOG_LEVEL=debug raises verbosity (debug lines appear)", () => {
    expect(emittedMsgs({ env: { BRIDGE_LOG_LEVEL: "debug" } })).toEqual([
      "dbg",
      "inf",
      "wrn",
      "err",
    ]);
  });

  test("BRIDGE_LOG_LEVEL=error lowers verbosity (only error lines appear)", () => {
    expect(emittedMsgs({ env: { BRIDGE_LOG_LEVEL: "error" } })).toEqual(["err"]);
  });

  test("an invalid BRIDGE_LOG_LEVEL falls back to info", () => {
    expect(emittedMsgs({ env: { BRIDGE_LOG_LEVEL: "loud" } })).toEqual(["inf", "wrn", "err"]);
  });

  test("explicit opts.level wins over BRIDGE_LOG_LEVEL", () => {
    // Env says debug, but the explicit warn opt must take precedence.
    expect(emittedMsgs({ level: "warn", env: { BRIDGE_LOG_LEVEL: "debug" } })).toEqual([
      "wrn",
      "err",
    ]);
  });

  test("the resolved env level is inherited by child loggers", () => {
    const lines: string[] = [];
    const parent = createLogger({ sink: (l) => lines.push(l), env: { BRIDGE_LOG_LEVEL: "debug" } });
    parent.child({ sub: "x" }).debug("child_dbg");
    expect(lines.map((l) => (JSON.parse(l) as { message: string }).message)).toContain("child_dbg");
  });

  test("structured fields are still redacted", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), env: { BRIDGE_LOG_LEVEL: "debug" } });
    logger.debug("leaky", { note: "key ksk_supersecretvalue here" });
    expect(lines[0]).not.toContain("ksk_supersecretvalue");
    expect(lines[0]).toContain("[REDACTED]");
  });
});

describe("logger bindings and field collisions", () => {
  test("a reserved `service` binding does not break logging and the service name wins", () => {
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => lines.push(l), bindings: { service: "x" } });
    logger.info("hello");
    const records = lines.map((l) => JSON.parse(l) as { message: string; service: string });
    const hello = records.find((r) => r.message === "hello");
    expect(hello?.service).toBe("kiro-remote-bridge");
  });

  test("a `component` binding is carried on every record", () => {
    const lines: string[] = [];
    createLogger({ sink: (l) => lines.push(l), bindings: { component: "bridge-caps" } }).info("hi");
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      message: "hi",
      component: "bridge-caps",
      service: "kiro-remote-bridge",
    });
  });
});
