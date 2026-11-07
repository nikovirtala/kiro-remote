/**
 * The transport must surface the ACP child's OWN stderr when it crashes.
 *
 * kiro-cli writes its startup diagnostics to stderr and, when it fails, exits
 * non-zero. Previously the transport logged live stderr only at DEBUG (dropped
 * at the default info level), so a crash showed `acp_child_exit code=1` with no
 * reason. Now the transport buffers a bounded stderr tail and, on a non-zero
 * exit (or a signal), logs that tail at ERROR alongside `acp_child_exit` -- so
 * the retained logs always contain kiro-cli's own error. The tail is redacted
 * like every other field. A clean (code 0) exit stays a routine WARN with no
 * stderr dump.
 */

import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import { createLogger } from "../src/logger.ts";
import { type SpawnFn, StdioJsonRpcTransport } from "../src/transport.ts";

/** A spawn fn that runs a one-line Node script writing to stderr then exiting. */
function scriptedSpawn(script: string): SpawnFn {
  return () =>
    // biome-ignore lint/suspicious/noExplicitAny: a real child satisfies the stream shape.
    spawn(process.execPath, ["-e", script], { stdio: ["pipe", "pipe", "pipe"] }) as any;
}

interface ExitLog {
  level: string;
  msg: string;
  // `code` is scrubbed by redact() (it is a sensitive key name for OAuth
  // codes), so the test asserts on `level`/`stderr`, not the code value.
  code?: unknown;
  signal?: string | null;
  stderr?: string;
}

/** Drive a transport to child exit and return the `acp_child_exit` record. */
async function runToExit(script: string): Promise<ExitLog> {
  const lines: string[] = [];
  // Default level (info) on purpose: the exit diagnostic must be visible even
  // when live `acp_stderr` debug lines are suppressed.
  const logger = createLogger({ sink: (l) => lines.push(l), env: {} });
  const transport = new StdioJsonRpcTransport({
    spec: { command: "unused", args: [] },
    spawnFn: scriptedSpawn(script),
    logger,
    onExit: () => {},
  });

  const exited = new Promise<void>((resolve) => {
    // Resolve once we observe the exit record.
    const check = setInterval(() => {
      if (lines.some((l) => (JSON.parse(l) as { msg: string }).msg === "acp_child_exit")) {
        clearInterval(check);
        resolve();
      }
    }, 5);
  });

  transport.start();
  await exited;

  const record = lines.map((l) => JSON.parse(l) as ExitLog).find((r) => r.msg === "acp_child_exit");
  if (!record) {
    throw new Error("no acp_child_exit record");
  }
  return record;
}

describe("transport child stderr surfacing", () => {
  test("a non-zero exit logs the buffered stderr tail at ERROR (even at info level)", async () => {
    const record = await runToExit(
      'process.stderr.write("kiro-cli: fatal: cannot init HOME\\n"); process.exit(1);',
    );
    expect(record.level).toBe("error");
    expect(record.stderr).toContain("kiro-cli: fatal: cannot init HOME");
  });

  test("a secret in the child's stderr is redacted in the surfaced tail", async () => {
    const record = await runToExit(
      'process.stderr.write("auth failed with ksk_supersecretvalue\\n"); process.exit(1);',
    );
    expect(record.level).toBe("error");
    expect(record.stderr).not.toContain("ksk_supersecretvalue");
    expect(record.stderr).toContain("[REDACTED]");
  });

  test("a clean exit (code 0) stays a routine WARN with no stderr dump", async () => {
    const record = await runToExit('process.stderr.write("some noise\\n"); process.exit(0);');
    expect(record.level).toBe("warn");
    expect(record.stderr).toBeUndefined();
  });
});
