/**
 * Headless `kiro-cli chat` child-process helpers.
 *
 * Two paths run a `kiro-cli chat` child rather than the long-lived ACP child:
 *  - the cloud launch FALLBACK when no cloud execution target is advertised:
 *    `kiro-cli chat --v3 --no-interactive --cloud --repo <repos>
 *    --output-format stream-json` with the prompt on stdin; the cloud session
 *    id comes from the stream-json sessionUpdate/runFinished records.
 *  - delete: `kiro-cli chat --delete-session <kiroSessionId>`.
 *
 * The runner is injectable so tests supply a fake without a real binary.
 */

import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import type { Logger } from "./logger.ts";

export interface HeadlessSpec {
  command: string;
  args: string[];
  /** Written to stdin then closed, when present. */
  stdin?: string;
  env?: Record<string, string>;
}

export interface HeadlessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable headless runner. */
export type HeadlessRunner = (spec: HeadlessSpec) => Promise<HeadlessResult>;

export const defaultHeadlessRunner: HeadlessRunner = (spec) =>
  new Promise((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(spec.env ?? {}) },
    }) as ChildProcessWithoutNullStreams;
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr.on("data", (c: string) => {
      stderr += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    if (spec.stdin !== undefined) {
      child.stdin.write(spec.stdin);
      child.stdin.end();
    }
  });

const KIRO_CLI = "kiro-cli";

/**
 * Parse the cloud session id out of stream-json output. Each line is a JSON
 * record; the id appears on a `sessionUpdate` or `runFinished` record (field
 * `sessionId`, or `session_id`).
 */
export function parseCloudSessionId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const id = rec.sessionId ?? rec.session_id;
    const type = rec.type ?? rec.event;
    if (
      typeof id === "string" &&
      id.length > 0 &&
      (type === "sessionUpdate" || type === "runFinished" || type === undefined)
    ) {
      return id;
    }
  }
  return null;
}

export interface HeadlessLaunchArgs {
  prompt: string;
  repos: string[];
}

/** Run the headless cloud launch fallback and return the cloud session id. */
export async function headlessLaunch(
  runner: HeadlessRunner,
  logger: Logger,
  args: HeadlessLaunchArgs,
): Promise<string> {
  const repoArgs = args.repos.flatMap((r) => ["--repo", r]);
  const result = await runner({
    command: KIRO_CLI,
    args: [
      "chat",
      "--v3",
      "--no-interactive",
      "--cloud",
      ...repoArgs,
      "--output-format",
      "stream-json",
    ],
    stdin: args.prompt,
  });
  logger.info("headless_launch_done", { code: result.code });
  const sessionId = parseCloudSessionId(result.stdout);
  if (!sessionId) {
    throw new Error("headless launch produced no cloud session id");
  }
  return sessionId;
}

/** Delete a cloud session via `kiro-cli chat --delete-session <id>`. */
export async function headlessDelete(
  runner: HeadlessRunner,
  logger: Logger,
  kiroSessionId: string,
): Promise<void> {
  const result = await runner({
    command: KIRO_CLI,
    args: ["chat", "--delete-session", kiroSessionId],
  });
  logger.info("headless_delete_done", { code: result.code });
  if (result.code !== 0 && result.code !== null) {
    throw new Error(`delete-session failed with exit code ${result.code}`);
  }
}
