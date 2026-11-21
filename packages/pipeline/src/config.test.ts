/**
 * deploy.toml (read by @nikovirtala/deployment in the pipeline's build) and the names the pipeline
 * stack uses (names.ts) must agree, and the settings schema must say what scripts/deploy.sh does:
 * the same keys, the same -c names, and every setting deploy.sh requires REQUIRED here too.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig, parseEnvFile, resolveSettings } from "@nikovirtala/deployment";
import { describe, expect, it } from "vitest";
import {
  DNS_STACK_NAME,
  FREEZE_PARAMETER,
  GITHUB_TOKEN_SECRET,
  LEDGER_TABLE_NAME,
  NOTIFY_TOPIC_NAME,
  PIPELINE_NAME,
  REGION,
  ROLE_NAMES,
  SERVICE_STACK_NAME,
  SETTINGS_PREFIX,
  TASK_ROLE_PREFIX,
} from "./names.ts";

const ROOT = path.resolve(import.meta.dirname, "..", "..", "..");
const config = loadConfig(path.join(ROOT, "deploy.toml"));
const script = fs.readFileSync(path.join(ROOT, "scripts", "deploy.sh"), "utf8");
const example = fs.readFileSync(path.join(ROOT, "deploy.env.example"), "utf8");

describe("deploy.toml and the pipeline stack", () => {
  it("name the same ledger, flag, settings, roles, topic, token, pipeline and stacks", () => {
    const r = config.raw;
    expect(r.project).toMatchObject({
      name: "kiro-remote",
      region: REGION,
      environment: "production",
      repository: "nikovirtala/kiro-remote",
    });
    expect(r.pipeline.name).toBe(PIPELINE_NAME);
    expect(r.ledger.table).toBe(LEDGER_TABLE_NAME);
    expect(r.freeze.parameter).toBe(FREEZE_PARAMETER);
    expect(r.settings.prefix).toBe(SETTINGS_PREFIX);
    expect(r.roles).toEqual({
      deploy: ROLE_NAMES.deploy,
      smoke: ROLE_NAMES.smoke,
      task_prefix: TASK_ROLE_PREFIX,
    });
    expect(r.notify.topic).toBe(NOTIFY_TOPIC_NAME);
    expect(r.provenance.github_token_secret).toBe(GITHUB_TOKEN_SECRET);
    expect(r.target.stacks).toEqual([DNS_STACK_NAME, SERVICE_STACK_NAME]);
    expect(r.target.cdk).toEqual([
      "pnpm",
      "--filter",
      "@nikovirtala/kiro-remote-cdk",
      "exec",
      "cdk",
    ]);
    expect(r.preflight).toContainEqual({ kind: "stack", name: SERVICE_STACK_NAME });
    // The bridge image's build context excludes **/cdk.out and nothing like it (BRIDGE_IMAGE_EXCLUDES).
    expect(r.target.output).toBe("cdk.out");
  });

  it("pass no rollback trigger until the service has alarms (a missing alarm would fail the deploy)", () => {
    // When alarms are added, the deploy role needs cloudwatch:DescribeAlarms and DescribeAlarmHistory.
    expect(config.raw.target.rollback_triggers).toEqual([]);
  });
});

describe("the settings schema and scripts/deploy.sh", () => {
  // Every `add_opt <context> "$<KEY>"` line: the -c flags deploy.sh passes, and the key each comes from.
  const passed = [...script.matchAll(/^add_opt\s+(\w+)\s+"\$(\w+)"/gm)].map((m) => ({
    context: m[1] as string,
    key: m[2] as string,
  }));

  it("name the same keys, as the same -c context keys", () => {
    expect(passed.length).toBeGreaterThan(10);
    expect(
      config.specs
        .map((s) => ({ context: s.context, key: s.key }))
        .sort((a, b) => a.key.localeCompare(b.key)),
    ).toEqual([...passed].sort((a, b) => a.key.localeCompare(b.key)));
  });

  it("make REQUIRED every setting deploy.sh refuses to deploy without, each with its effect", () => {
    const dies = [...script.matchAll(/\[ -n "\$(\w+)" \] \|\| die "\1 is not set/g)].map(
      (m) => m[1] as string,
    );
    expect(dies).toEqual(["KIRO_CLI_VERSION", "KIRO_API_KEY_SECRET_ARN"]);
    const required = config.specs.filter((s) => s.required);
    for (const key of [...dies, "HOSTED_ZONE_ID"])
      expect(
        required.map((s) => s.key),
        key,
      ).toContain(key);
    for (const s of required) expect(s.required, s.key).toMatch(/[Ww]ithout it|deploy without it/);
    // deploy.sh's conditional rule: DNS_ZONE_NAME and CUSTOM_DOMAIN_NAME set, HOSTED_ZONE_ID not.
    expect(script).toMatch(
      /if \[ -n "\$DNS_ZONE_NAME" \] && \[ -n "\$CUSTOM_DOMAIN_NAME" \] && \[ -z "\$HOSTED_ZONE_ID" \]/,
    );
    expect(config.specs.find((s) => s.key === "HOSTED_ZONE_ID")?.requiredWhen).toEqual([
      "DNS_ZONE_NAME",
      "CUSTOM_DOMAIN_NAME",
    ]);
  });

  it("default what deploy.sh defaults, to the same values", () => {
    for (const m of script.matchAll(/^(\w+)="\$\{\1:?-([^$}]*)\}"/gm)) {
      const [, key, value] = m as unknown as [string, string, string];
      const spec = config.specs.find((s) => s.key === key);
      if (!spec || value === "") continue;
      expect(spec.default, key).toBe(value);
    }
    for (const m of script.matchAll(/^(\w+)="\$\{\1:?-\$DEFAULT_DOMAIN\}"/gm)) {
      expect(config.specs.find((s) => s.key === m[1])?.default, m[1]).toBe(
        "kiro-remote.nikovirtala.dev",
      );
    }
  });

  it("document every setting in deploy.env.example, and a filled-in example resolves", () => {
    for (const s of config.specs) expect(example, s.key).toMatch(new RegExp(`^${s.key}=`, "m"));
    const env = {
      ...parseEnvFile(example),
      KIRO_API_KEY_SECRET_ARN:
        "arn:aws:secretsmanager:eu-north-1:827333031966:secret:kiro-remote/kiro-api-key-AbC123",
      HOSTED_ZONE_ID: "Z0123456789ABCDEFGHIJ",
      GITHUB_APP_SECRET_ARN:
        "arn:aws:secretsmanager:eu-north-1:827333031966:secret:kiro-remote/github-app-AbC123",
    };
    expect(resolveSettings(config.specs, env).errors).toEqual([]);
    expect(
      resolveSettings(config.specs, parseEnvFile(example)).errors.map((e) => e.split(" ")[0]),
    ).toEqual(["HOSTED_ZONE_ID", "KIRO_API_KEY_SECRET_ARN", "GITHUB_APP_SECRET_ARN"]);
  });
});
