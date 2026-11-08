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
 * The real `--cloud` output is PLAIN TEXT (there is no JSON/stream-json output
 * mode for --cloud) and is SPLIT ACROSS TWO STREAMS:
 *  - STDERR carries the log-prefixed lines: `[INFO] ...`, `[cloud] session
 *    <uuid>`, `[tool] ...`, `[tool] status: Completed`, `[sandbox] ...`.
 *  - STDOUT carries ONLY the assistant's free-text answer (the prose), with no
 *    bracketed/log-prefixed lines.
 * So we parse the cloud session id + tool activity out of STDERR (where the
 * `[cloud] session <uuid>`/`[tool]` lines live) and the assistant text out of
 * STDOUT.
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
 * Parse the cloud session id out of the plain-text `--cloud` log stream
 * (STDERR). The real output carries a line like `[cloud] session
 * 08047063-f7b4-4ce5-...`; scan for the first line whose
 * (whitespace/log-prefix-tolerant) content matches the `[cloud] session `
 * marker and capture the following token as the id. The id may be a BARE UUID
 * (no `sess_` prefix), e.g. `0719d335-adab-4df9-99f9-9699e9cc84a4`. Returns the
 * first match or null (pure + unit-testable). There is NO stream-json for
 * --cloud, so we never JSON.parse here.
 */
export function parseCloudSessionId(stderr: string): string | null {
  for (const line of stderr.split("\n")) {
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
 * Map the plain-text `--cloud` output into a structured result, reading from
 * the correct stream for each field. The real `chat --cloud` output is split:
 * STDERR carries the `[cloud] session <uuid>`/`[tool]`/`[INFO]`/`[sandbox]` log
 * lines, and STDOUT carries only the assistant's free-text answer. So:
 *  - the cloud session id + ordered tool activity come from STDERR (`[tool]
 *    status: <s>` lines update the status of the most recent `[tool] <title>`
 *    line);
 *  - the assistant answer is every non-empty, non-system-prefixed line of
 *    STDOUT (in practice all of stdout, which has no bracketed lines).
 * Pure + unit-testable.
 */
export function parseCloudOutput(stdout: string, stderr: string): ParsedCloudOutput {
  const tools: ParsedTool[] = [];
  // Tool activity lives on STDERR alongside the other log-prefixed lines.
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith("[tool]")) {
      continue;
    }
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
  }
  // The assistant free-text answer lives on STDOUT. Keep the "a
  // non-system-prefixed line is assistant text" rule so any stray log line is
  // still excluded; in practice stdout has no bracketed lines so this is every
  // non-empty line.
  const assistantLines: string[] = [];
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || hasSystemPrefix(trimmed)) {
      continue;
    }
    assistantLines.push(trimmed);
  }
  return {
    cloudSessionId: parseCloudSessionId(stderr),
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
  // A resume already knows its cloud id; the `[cloud] session` line (on STDERR)
  // may not be re-emitted, so fall back to the resumed id when parsing finds
  // none. The assistant answer still comes from STDOUT.
  const parsed = parseCloudOutput(result.stdout, result.stderr);
  // Only code === 0 is success. A null exit code (signal-killed, e.g. OOM mid
  // turn) is a TRUNCATED turn, not a quiet success -- fail loudly so settleResume
  // surfaces a turn.failed event + metric rather than persisting a partial answer.
  if (result.code !== 0) {
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
 * Shared completion handling for a launch turn: parse the plain-text output
 * (cloud id + tools from STDERR, assistant answer from STDOUT), require a cloud
 * session id + zero exit, and log the numeric status under
 * `exitCode` (NOT `code`: core redact() lists `code` in SENSITIVE_KEYS -- the
 * OAuth authorization code -- and would scrub it). stdout/stderr still run
 * through the pattern redactor, so any ksk_/bearer/OAuth value in them stays
 * scrubbed.
 */
function finishTurn(logger: Logger, result: HeadlessResult, tag: string): HeadlessTurnResult {
  // The cloud id + tool activity come from STDERR; the assistant answer comes
  // from STDOUT. A real `chat --cloud` success prints the `[cloud] session`
  // line on STDERR with the prose on STDOUT, so reading stdout alone would miss
  // the id and wrongly fail the turn.
  const parsed = parseCloudOutput(result.stdout, result.stderr);
  // A clean turn exits 0. Treat BOTH a non-zero exit AND a null exit code
  // (process killed by a signal with no code -- e.g. OOM/SIGKILL mid-turn) as a
  // failure: a signal-killed subprocess that happened to have already printed a
  // `[cloud] session` line produced a TRUNCATED turn, and accepting it would
  // persist a partial answer as complete. Only code === 0 is success.
  const failedExit = result.code !== 0;
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
