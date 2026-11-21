/** The tasks directory: valid names only, each task declaring a role of the task prefix that the pipeline stack defines. */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  defaultExec,
  discoverTasks,
  loadConfig,
  ProcessExecutor,
  validateNeeds,
} from "@nikovirtala/deployment";
import { describe, expect, it } from "vitest";
import { TASK_ROLE_PREFIX } from "./names.ts";
import { TASK_ROLES } from "./task-roles.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const config = loadConfig(path.join(ROOT, "deploy.toml"));

describe("the tasks directory", () => {
  it("exists, documents the protocol, and holds only well-named tasks", () => {
    expect(fs.readFileSync(path.join(config.tasksDir, "README.md"), "utf8")).toMatch(
      /--needs[\s\S]*--dry-run[\s\S]*--run/,
    );
    expect(() =>
      discoverTasks(config.tasksDir, { interpreters: config.raw.tasks.interpreters }),
    ).not.toThrow();
  });

  it("every task declares a role of the task prefix that task-roles.ts defines, never the deploy role", async () => {
    const tasks = discoverTasks(config.tasksDir, { interpreters: config.raw.tasks.interpreters });
    const executor = new ProcessExecutor({
      exec: defaultExec,
      cwd: ROOT,
      baseEnv: { PATH: process.env.PATH },
    });
    for (const t of tasks) {
      const needs = await executor.needs(t);
      validateNeeds(t, needs, {
        taskRolePrefix: TASK_ROLE_PREFIX,
        forbidden: [config.raw.roles.deploy],
      });
      expect(
        TASK_ROLES.map((r) => r.name),
        t.id,
      ).toContain(needs.role);
    }
  });
});
