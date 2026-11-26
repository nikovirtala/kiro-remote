/**
 * Run the MCP Inspector CLI once over Streamable HTTP: `tools/list`, or
 * `skills/list --verify`, in the era asked for.
 *
 * The Inspector does what Claude does on a first connection: the server
 * answers 401, the Inspector follows the RFC 9728 resource metadata to the RFC
 * 8414 authorization-server metadata, registers a client (RFC 7591), opens the
 * browser for the authorization-code + PKCE sign-in, exchanges the code, and
 * then calls `tools/list`.
 *
 * Tokens: the Inspector persists them by default (OS keychain or
 * ~/.mcp-inspector/secrets.json). The harness may keep tokens only in the
 * kiro-remote 0600 keychain, so it runs the Inspector with the in-memory secret
 * store and a throwaway storage directory that is removed afterwards. As a
 * result every run asks for one browser sign-in.
 */
import { spawn } from "node:child_process";
import { mkdtemp as fsMkdtemp, rm as fsRm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The pinned Inspector release (its CLI flags and env vars were checked against this one). */
export const INSPECTOR_PACKAGE = "@modelcontextprotocol/inspector@2.16.0";
/** Upper bound for the whole Inspector run, including the browser sign-in. */
export const INSPECTOR_TIMEOUT_MS = 300_000;

export interface InspectorInvocation {
  command: string;
  args: string[];
  env: Record<string, string>;
}

/**
 * One Inspector run: the method, the protocol era (the Inspector's default for
 * a URL is the 2025 era) and, for `skills/list`, the SEP-2640 checks.
 */
export interface InspectorCall {
  method: "tools/list" | "skills/list";
  era?: "legacy" | "auto" | "modern";
  /** `--verify`: conformance, sizes and digests of every skill; exit 7 or 8 when one fails. */
  verify?: boolean;
}

/** The command line and extra env for one run (`tools/list` by default). Carries no secret. */
export function inspectorInvocation(
  baseUrl: string,
  storageDir: string,
  call: InspectorCall = { method: "tools/list" },
): InspectorInvocation {
  return {
    command: "npx",
    args: [
      "--yes",
      INSPECTOR_PACKAGE,
      "--cli",
      `${baseUrl}/mcp`,
      "--transport",
      "http",
      ...(call.era ? ["--protocol-era", call.era] : []),
      "--method",
      call.method,
      ...(call.verify ? ["--verify"] : []),
      // `--verify` prints one JSON report per skill on its own; the format flag is for tools.
      ...(call.verify ? [] : ["--format", "json"]),
    ],
    env: {
      MCP_STORAGE_DIR: storageDir,
      MCP_INSPECTOR_SECRET_STORE: "memory",
      MCP_AUTO_OPEN_ENABLED: "true",
    },
  };
}

export type InspectorSpawn = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number; onStderrLine(line: string): void },
) => Promise<{ exitStatus: number | null; stdout: string; stderrTail: string }>;

/** Spawn without a shell, stdin closed, stderr streamed line by line. */
export const defaultInspectorSpawn: InspectorSpawn = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: opts.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let pending = "";
    let stderrTail = "";
    const emit = (line: string) => {
      if (line.trim().length > 0) {
        stderrTail = line;
        opts.onStderrLine(line);
      }
    };
    const timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const line of lines) {
        emit(line);
      }
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (exitStatus) => {
      clearTimeout(timer);
      emit(pending);
      resolve({ exitStatus, stdout, stderrTail });
    });
  });

/** Read the tool names from the Inspector's `--format json` output. */
export function parseInspectorToolNames(stdout: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("MCP Inspector output is not JSON");
  }
  const tools = (parsed as { result?: { tools?: unknown } } | null)?.result?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("MCP Inspector output has no result.tools array");
  }
  return tools.map((t) => {
    const name = (t as { name?: unknown } | null)?.name;
    if (typeof name !== "string") {
      throw new Error("MCP Inspector output has a tool without a name");
    }
    return name;
  });
}

/** Describe the error envelope the Inspector prints as its last stderr line. */
function describeFailure(exitStatus: number | null, stderrTail: string): string {
  let detail = "";
  try {
    const env = JSON.parse(stderrTail) as { error?: { code?: unknown; message?: unknown } };
    if (env.error) {
      detail = [env.error.code, env.error.message]
        .filter((v) => typeof v === "string" || typeof v === "number")
        .join(" ");
    }
  } catch {
    detail = stderrTail;
  }
  return `MCP Inspector exited ${exitStatus ?? "by signal"}${detail ? `: ${detail}` : ""}`;
}

export interface InspectorDeps {
  spawn: InspectorSpawn;
  /** Receives every Inspector stderr line; the caller scrubs before printing. */
  progress(line: string): void;
  mkdtemp?: (prefix: string) => Promise<string>;
  rm?: (path: string, opts: { recursive: boolean; force: boolean }) => Promise<void>;
  timeoutMs?: number;
}

/** One skill's `--verify` report, as far as the harness reads it. */
export interface SkillReport {
  name: string;
  ok: boolean;
  outcome: string;
  files: unknown[];
}

/** Read the per-skill reports `--verify` prints: one JSON object per line. */
export function parseSkillReports(stdout: string): SkillReport[] {
  const reports = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("{"))
    .map((l) => {
      try {
        return JSON.parse(l) as Partial<SkillReport>;
      } catch {
        throw new Error("MCP Inspector --verify printed a report that is not JSON");
      }
    });
  return reports.map((r) => {
    if (typeof r.name !== "string" || typeof r.ok !== "boolean" || !Array.isArray(r.files)) {
      throw new Error("MCP Inspector --verify printed a report without name, ok and files");
    }
    return { name: r.name, ok: r.ok, outcome: String(r.outcome), files: r.files };
  });
}

/**
 * Run one Inspector call (with its own browser sign-in) and return its stdout.
 * A non-zero exit throws, with the exit status and the error envelope.
 */
export async function runInspector(
  baseUrl: string,
  call: InspectorCall,
  deps: InspectorDeps,
): Promise<string> {
  const mkdtemp = deps.mkdtemp ?? fsMkdtemp;
  const rm = deps.rm ?? fsRm;
  const dir = await mkdtemp(join(tmpdir(), "kiro-e2e-inspector-"));
  try {
    const inv = inspectorInvocation(baseUrl, dir, call);
    const res = await deps.spawn(inv.command, inv.args, {
      env: { ...process.env, ...inv.env },
      timeoutMs: deps.timeoutMs ?? INSPECTOR_TIMEOUT_MS,
      onStderrLine: (line) => deps.progress(line),
    });
    if (res.exitStatus !== 0) {
      throw new Error(describeFailure(res.exitStatus, res.stderrTail));
    }
    return res.stdout;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Run `tools/list` through the Inspector and return the advertised tool names. */
export async function runInspectorToolsList(
  baseUrl: string,
  deps: InspectorDeps,
  era?: InspectorCall["era"],
): Promise<string[]> {
  return parseInspectorToolNames(
    await runInspector(baseUrl, { method: "tools/list", ...(era ? { era } : {}) }, deps),
  );
}
