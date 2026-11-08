/**
 * Headless `kiro-cli chat` child-process helpers.
 *
 * `kiro-cli chat --cloud` subprocesses are the ONLY cloud path (chat-only ==
 * cloud-only, for now): they both PROVISION a real cloud Space (visible in
 * app.kiro.dev) and DRIVE its turns. ACP cannot drive a cloud session -- the
 * user empirically proved that `session/load` + `session/prompt` against a real
 * cloud id returns `Session '...' not found` -- so the ACP child is never used
 * to launch or prompt a cloud session.
 *
 * Three invocations run a `kiro-cli chat` child via the injectable runner:
 *  - launch (first turn):
 *    `kiro-cli chat --cloud --repo <r> [--repo <r2> ...] --no-interactive "<prompt>"`
 *  - follow-up turn (resume):
 *    `kiro-cli chat --cloud --resume-id <cloudSessionId> --no-interactive "<prompt>"`
 *  - delete: `kiro-cli chat --delete-session <kiroSessionId>`.
 *
 * The real `--cloud` stdout is PLAIN TEXT (there is no JSON/stream-json output
 * mode for --cloud): interleaved `[INFO] ...`, `[cloud] session <uuid>`,
 * `[tool] ...`, `[tool] status: Completed`, `[sandbox] ...` log lines, then the
 * assistant's free-text answer. We parse the cloud session id out of the
 * `[cloud] session <uuid>` line and the assistant text + tool activity out of
 * the remaining lines.
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

/** A UUID (v4-ish) as emitted on the `[cloud] session <uuid>` line. */
const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;

/**
 * Parse the cloud session id out of plain-text `--cloud` stdout. The real
 * output carries a line like `[cloud] session 08047063-f7b4-4ce5-...`; scan for
 * the first line whose (whitespace/log-prefix-tolerant) content matches the
 * `[cloud] session ` marker and capture the following token as the id. Returns
 * the first match or null (pure + unit-testable). There is NO stream-json for
 * --cloud, so we never JSON.parse here.
 */
export function parseCloudSessionId(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    // Tolerate a surrounding log prefix/timestamp before the `[cloud]` marker.
    const marker = line.indexOf("[cloud]");
    if (marker < 0) {
      continue;
    }
    const after = line.slice(marker + "[cloud]".length);
    // Expect `session <id>` after the marker (allow extra whitespace).
    const m = after.match(/^\s*session\s+(\S+)/);
    if (m?.[1]) {
      // Prefer a UUID shape when present, but accept any non-empty token.
      const uuid = m[1].match(UUID_RE);
      return uuid ? uuid[0] : m[1];
    }
  }
  return null;
}

/** A tool activity entry parsed out of the plain-text cloud output. */
export interface ParsedTool {
  /** A stable key for the tool line (its 1-based ordinal), used as toolCallId. */
  id: string;
  /** The tool line text after the `[tool] ` prefix. */
  title: string;
  /** The last observed status for this tool line (e.g. "Completed"), if any. */
  status: string | null;
}

/** Structured result of parsing the plain-text `--cloud` stdout. */
export interface ParsedCloudOutput {
  /** The cloud session id from the `[cloud] session <uuid>` line, or null. */
  cloudSessionId: string | null;
  /** Tool activity lines, in order. */
  tools: ParsedTool[];
  /** The assistant's final free-text answer (non-prefixed lines joined). */
  assistantText: string;
}

/** Log/system line prefixes that are NOT assistant free-text. */
const SYSTEM_PREFIXES = [
  "[INFO]",
  "[WARN]",
  "[ERROR]",
  "[DEBUG]",
  "[cloud]",
  "[tool]",
  "[sandbox]",
];

function hasSystemPrefix(trimmed: string): boolean {
  return SYSTEM_PREFIXES.some((p) => trimmed.startsWith(p));
}

/**
 * Map the plain-text `--cloud` stdout into a structured result: the cloud
 * session id, the ordered tool activity, and the assistant's trailing free-text
 * answer. `[tool] status: <s>` lines update the status of the most recent
 * `[tool] <title>` line; any line without a known system prefix is treated as
 * assistant text. Pure + unit-testable.
 */
export function parseCloudOutput(stdout: string): ParsedCloudOutput {
  const tools: ParsedTool[] = [];
  const assistantLines: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    if (trimmed.startsWith("[tool]")) {
      const body = trimmed.slice("[tool]".length).trim();
      const statusMatch = body.match(/^status:\s*(.+)$/i);
      if (statusMatch) {
        // Attach the status to the most recent tool line.
        const last = tools[tools.length - 1];
        if (last) {
          last.status = statusMatch[1].trim();
        }
        continue;
      }
      tools.push({ id: String(tools.length + 1), title: body, status: null });
      continue;
    }
    if (hasSystemPrefix(trimmed)) {
      continue;
    }
    // A non-prefixed line is assistant free-text.
    assistantLines.push(trimmed);
  }
  return {
    cloudSessionId: parseCloudSessionId(stdout),
    tools,
    assistantText: assistantLines.join("\n").trim(),
  };
}

export interface HeadlessLaunchArgs {
  prompt: string;
  repos: string[];
}

/** The outcome of a chat --cloud invocation the caller persists as events. */
export interface HeadlessTurnResult {
  cloudSessionId: string;
  tools: ParsedTool[];
  assistantText: string;
}

/**
 * Run the chat --cloud launch (first turn) and return the parsed cloud session
 * id + assistant/tool output. Throws LOUDLY when no `[cloud] session <uuid>`
 * line appears OR the process exits non-zero, so launch() can fail the session.
 *
 * `--no-interactive` governs tool-permission behavior on the chat path (it
 * auto-proceeds or refuses rather than prompting); the ACP answerPermission
 * flow does not apply to chat --cloud.
 */
export async function headlessLaunch(
  runner: HeadlessRunner,
  logger: Logger,
  args: HeadlessLaunchArgs,
): Promise<HeadlessTurnResult> {
  const repoArgs = args.repos.flatMap((r) => ["--repo", r]);
  const result = await runner({
    command: KIRO_CLI,
    args: ["chat", "--cloud", ...repoArgs, "--no-interactive", args.prompt],
  });
  return finishTurn(logger, result, "headless_launch");
}

/**
 * Run a follow-up turn against an existing cloud session via
 * `kiro-cli chat --cloud --resume-id <cloudSessionId> --no-interactive
 * "<prompt>"`. The CLI help documents `--resume-id <SESSION_ID>` ("Resume a
 * specific conversation by session ID"), which composes with --cloud. Returns
 * the parsed assistant/tool output (the cloud id is the one we resumed). Throws
 * LOUDLY on non-zero exit.
 */
export async function headlessResume(
  runner: HeadlessRunner,
  logger: Logger,
  cloudSessionId: string,
  prompt: string,
): Promise<HeadlessTurnResult> {
  const result = await runner({
    command: KIRO_CLI,
    args: ["chat", "--cloud", "--resume-id", cloudSessionId, "--no-interactive", prompt],
  });
  // A resume already knows its cloud id; the `[cloud] session` line may not be
  // re-emitted, so fall back to the resumed id when parsing finds none.
  const parsed = parseCloudOutput(result.stdout);
  if (result.code !== 0 && result.code !== null) {
    logger.warn("headless_resume_failed", {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    throw new Error(`headless resume failed with exit code ${result.code}`);
  }
  logger.info("headless_resume_done", { exitCode: result.code });
  return {
    cloudSessionId: parsed.cloudSessionId ?? cloudSessionId,
    tools: parsed.tools,
    assistantText: parsed.assistantText,
  };
}

/**
 * Shared completion handling for a launch turn: parse the plain-text output,
 * require a cloud session id + zero exit, and log the numeric status under
 * `exitCode` (NOT `code`: core redact() lists `code` in SENSITIVE_KEYS -- the
 * OAuth authorization code -- and would scrub it). stdout/stderr still run
 * through the pattern redactor, so any ksk_/bearer/OAuth value in them stays
 * scrubbed.
 */
function finishTurn(logger: Logger, result: HeadlessResult, tag: string): HeadlessTurnResult {
  const parsed = parseCloudOutput(result.stdout);
  const failedExit = result.code !== 0 && result.code !== null;
  if (!parsed.cloudSessionId || failedExit) {
    // Surface the raw (pattern-redacted) child output so the live failure is
    // diagnosable BEFORE we throw.
    logger.warn(`${tag}_failed`, {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    });
    throw new Error(
      failedExit
        ? `${tag} failed with exit code ${result.code}`
        : `${tag} produced no cloud session id`,
    );
  }
  logger.info(`${tag}_done`, { exitCode: result.code });
  return {
    cloudSessionId: parsed.cloudSessionId,
    tools: parsed.tools,
    assistantText: parsed.assistantText,
  };
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
  logger.info("headless_delete_done", { exitCode: result.code });
  if (result.code !== 0 && result.code !== null) {
    throw new Error(`delete-session failed with exit code ${result.code}`);
  }
}
