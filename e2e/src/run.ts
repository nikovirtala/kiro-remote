/**
 * The `pnpm e2e` entry point: run the live harness against a deployed stack.
 *
 * It loads the config from the environment, wires the real dependencies (the
 * MCP Inspector CLI, the `kiro-remote login` keychain, the MCP SDK client and
 * the REST HttpClient), runs every step, deletes any session the run created
 * and did not confirm deleted, and prints the scrubbed JSON report to stdout.
 * Progress goes to stderr.
 *
 * Exit code:
 *   0  every recorded step passed;
 *   1  a step failed (or the harness crashed);
 *   2  nothing failed, but at least one step was skipped (for example
 *      KIRO_REMOTE_URL is unset), so the live e2e did not fully run.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { FileKeychain, HttpClient } from "@nikovirtala/kiro-remote-mcp";
import { defaultLogin, nodeFetch, obtainToken } from "./auth.ts";
import { loadConfig } from "./config.ts";
import { defaultInspectorSpawn, runInspectorToolsList } from "./inspector.ts";
import { connectMcp } from "./mcp-client.ts";
import { makeScrubber, Report, type RunReport } from "./report.ts";
import { runSteps } from "./runner.ts";
import {
  cleanupSessions,
  DELETE_POLL_MS,
  DELETE_TIMEOUT_MS,
  GITHUB_STEPS,
  type HarnessContext,
  type HarnessDeps,
  STEPS,
  TURN_TIMEOUT_MS,
} from "./steps.ts";

/** The result of a harness run (used by the CLI exit code and tests). */
export interface RunHarnessResult {
  report: RunReport;
  exitCode: 0 | 1 | 2;
}

function realDeps(progress: (line: string) => void): HarnessDeps {
  return {
    fetch: globalThis.fetch,
    inspector: (u) => runInspectorToolsList(u, { spawn: defaultInspectorSpawn, progress }),
    obtainToken: (u) => {
      const keychain = new FileKeychain();
      return obtainToken(u, {
        keychain,
        fetch: nodeFetch,
        login: () => defaultLogin(u, keychain),
      });
    },
    connectMcp: (u, t) => connectMcp(u, t),
    rest: (u, t) => new HttpClient({ baseUrl: u, tokens: t, fetch: nodeFetch }),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    runId: randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase(),
    progress,
    turnTimeoutMs: TURN_TIMEOUT_MS,
    deleteTimeoutMs: DELETE_TIMEOUT_MS,
    deletePollMs: DELETE_POLL_MS,
    gh: (args) => ghCli(args),
  };
}

/** Run `gh <args>` (REST only) and return stdout. Auth comes from the ambient gh login, which must be a trusted login. */
function ghCli(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`gh ${args.slice(0, 3).join(" ")} failed: ${stderr.slice(0, 200)}`));
        return;
      }
      resolve(stdout);
    });
  });
}

/** Run the harness with injectable env and dependencies; returns the scrubbed report. */
export async function runHarness(
  opts: { env?: NodeJS.ProcessEnv; deps?: Partial<HarnessDeps>; signal?: AbortSignal } = {},
): Promise<RunHarnessResult> {
  const { config, secrets } = loadConfig(opts.env ?? process.env);
  const repo = secrets.repo();
  const report = new Report(
    { kiroRemoteUrl: config.baseUrl, e2eRepoPresent: config.hasRepo },
    { literalSecrets: repo ? [repo] : [] },
  );
  const progress =
    opts.deps?.progress ??
    ((line: string) => {
      process.stderr.write(`${report.scrub(line)}\n`);
    });
  const deps: HarnessDeps = { ...realDeps((line) => progress(report.scrub(line))), ...opts.deps };
  const ctx: HarnessContext = {
    baseUrl: config.baseUrl,
    repo: secrets.repo,
    deps,
    state: { created: new Set() },
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  try {
    const githubEnabled = (opts.env ?? process.env).KIRO_API_E2E_GITHUB === "1";
    await runSteps(githubEnabled ? [...STEPS, ...GITHUB_STEPS] : STEPS, ctx, report, {
      hasBaseUrl: config.baseUrl !== null,
      hasRepo: config.hasRepo,
      hasGithub: githubEnabled,
      ...(opts.signal ? { signal: opts.signal } : {}),
      now: deps.now,
      progress: deps.progress,
    });
  } finally {
    await cleanupSessions(ctx, report);
    await ctx.state.mcp?.close().catch(() => {});
  }
  return { report: report.build(), exitCode: report.exitCode };
}

/** CLI main: run, print the report and a summary, set the exit code. */
async function main(): Promise<void> {
  const controller = new AbortController();
  let interrupts = 0;
  const onSignal = () => {
    interrupts++;
    if (interrupts > 1) {
      process.exit(130);
    }
    process.stderr.write(
      "\ninterrupted: skipping the remaining steps and deleting created sessions (press Ctrl-C again to exit now)\n",
    );
    controller.abort();
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const { report, exitCode } = await runHarness({ signal: controller.signal });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const count = (s: string) => report.steps.filter((x) => x.status === s).length;
  const lines = [
    `e2e: ${count("passed")} passed, ${count("failed")} failed, ${count("skipped")} skipped`,
    ...report.steps
      .filter((s) => s.status !== "passed")
      .map((s) => `  ${s.status} ${s.id}: ${s.reason ?? ""}`),
  ];
  process.stderr.write(`\n${lines.join("\n")}\n`);
  process.exitCode = exitCode;
}

// Only run main() when invoked directly (not when imported by a test).
if (process.argv[1]?.endsWith("run.ts")) {
  main().catch((err) => {
    const scrub = makeScrubber([loadConfig().secrets.repo() ?? ""]);
    process.stderr.write(
      `e2e harness error: ${scrub(err instanceof Error ? err.message : String(err))}\n`,
    );
    process.exit(1);
  });
}
