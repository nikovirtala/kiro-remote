/**
 * Test helpers for driving the fake ACP agent through a {@link SpawnFn}: a
 * spawner that picks a scenario per spawn (by call index) and records the
 * requested specs and children, and a reader for the params the fake agent
 * echoes to stderr (logged by the transport as `acp_stderr` at debug).
 */

import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defaultSpawn, type SpawnFn, type SpawnSpec } from "../src/transport.ts";

export const FAKE_AGENT = fileURLToPath(new URL("./fake-acp-agent.ts", import.meta.url));

export interface FakeAgentSpawner {
  spawnFn: SpawnFn;
  specs: SpawnSpec[];
  children: ChildProcessWithoutNullStreams[];
}

/**
 * Spawn the fake agent with `scenarios[i]` for the i-th spawn (the last
 * scenario repeats once the list runs out). The requested spec's env is kept
 * so the child sees what the code under test passes.
 */
export function fakeAgentSpawner(scenarios: unknown[]): FakeAgentSpawner {
  const specs: SpawnSpec[] = [];
  const children: ChildProcessWithoutNullStreams[] = [];
  const spawnFn: SpawnFn = (spec) => {
    const scenario = scenarios[Math.min(specs.length, scenarios.length - 1)] ?? {};
    specs.push(spec);
    const child = defaultSpawn({
      command: process.execPath,
      args: [FAKE_AGENT],
      env: { ...spec.env, FAKE_ACP_SCENARIO: JSON.stringify(scenario) },
    });
    children.push(child);
    return child;
  };
  return { spawnFn, specs, children };
}

/** Values the fake agent echoed to stderr under `key` (in order). */
export function echoed(logLines: string[], key: string): unknown[] {
  const out: unknown[] = [];
  for (const raw of logLines) {
    let record: { msg?: string; line?: string };
    try {
      record = JSON.parse(raw);
    } catch {
      continue;
    }
    if (record.msg !== "acp_stderr" || typeof record.line !== "string") {
      continue;
    }
    for (const line of record.line.split("\n")) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        if (key in parsed) {
          out.push(parsed[key]);
        }
      } catch {
        // Not one of the fake agent's JSON echo lines.
      }
    }
  }
  return out;
}

/** Resolve once the child has exited (immediately when it already has). */
export async function exited(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
