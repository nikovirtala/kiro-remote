/**
 * kiro-remote's smoke checks: what every deploy should show, from docs/deploy.md (the named outputs,
 * the managed-login domain and its branding, the Node 26 runtime, the Powertools configuration and
 * active tracing, the bridge's TZ, the Kiro API key that lives only in Secrets Manager) and the
 * README (the API's OpenAPI contract, the OAuth metadata, and every other route refusing a call
 * without a token). They run in the pipeline as the read-only smoke role, which cannot read session
 * data: no table item, no object, no log line, no secret value, no user (pipeline-stack.ts).
 *
 * Every AWS call goes through the package's read-only runner, so a check cannot change anything
 * even when its role could; `smoke-checks.test.ts` fails when a call is not in the smoke role.
 */
import {
  type AwsRunner,
  type CheckContext,
  describeStack,
  isHealthyStackStatus,
  isNotFound,
  type SmokeCheck,
  type StackInfo,
} from "@nikovirtala/deployment";
import { DNS_STACK_NAME, REGION, SERVICE_STACK_NAME } from "../names.ts";

/** The outputs docs/deploy.md, "Find the resource identifiers you'll need", lists. */
export const REQUIRED_OUTPUTS = [
  "UserPoolId",
  "FacadeClientId",
  "ApiUrl",
  "ManagedLoginDomainUrl",
  "McpResourceIdentifier",
] as const;
/** The two the stack adds when a custom domain is configured. */
export const CUSTOM_DOMAIN_OUTPUTS = ["CustomDomainTarget", "CustomDomainHostedZoneId"] as const;

/** The resource attribute the deploy stamps with the commit (packages/cdk, OTEL_RESOURCE_ATTRIBUTES). */
export const COMMIT_ATTRIBUTE = "vcs.ref.head.revision";

const stack = (aws: AwsRunner): StackInfo | undefined => describeStack(aws, SERVICE_STACK_NAME);

/** The origin MCP clients use: the MCP resource identifier without its /mcp path. */
export function publicOrigin(s: StackInfo): string | undefined {
  const mcp = s.outputs.McpResourceIdentifier;
  return mcp ? new URL(mcp).origin : undefined;
}

interface FunctionConfig {
  readonly FunctionName: string;
  readonly Runtime?: string;
  readonly PackageType?: string;
  readonly TracingConfig?: { Mode?: string };
  readonly Environment?: { Variables?: Record<string, string> };
}

/** The service's own functions (not the CDK trigger provider), with their configuration. */
function serviceFunctions(aws: AwsRunner): Array<{ logicalId: string; config: FunctionConfig }> {
  const res = aws("cloudformation", "list-stack-resources", [
    "--stack-name",
    SERVICE_STACK_NAME,
  ]) as {
    StackResourceSummaries?: Array<{
      LogicalResourceId: string;
      PhysicalResourceId?: string;
      ResourceType: string;
    }>;
  };
  return (res.StackResourceSummaries ?? [])
    .filter(
      (r) =>
        r.ResourceType === "AWS::Lambda::Function" &&
        r.LogicalResourceId.startsWith("KiroRemote") &&
        r.PhysicalResourceId,
    )
    .map((r) => ({
      logicalId: r.LogicalResourceId,
      config: aws("lambda", "get-function-configuration", [
        "--function-name",
        r.PhysicalResourceId as string,
      ]) as FunctionConfig,
    }));
}

/** Reads OTEL_RESOURCE_ATTRIBUTES (`k=v,k=v`, values percent-encoded). */
export function parseResourceAttributes(text: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (text ?? "").split(",")) {
    const i = pair.indexOf("=");
    if (i > 0) out[pair.slice(0, i).trim()] = decodeURIComponent(pair.slice(i + 1).trim());
  }
  return out;
}

async function http(ctx: CheckContext, url: string): Promise<{ status: number; json: unknown }> {
  const res = await ctx.fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    json = undefined;
  }
  return { status: res.status, json };
}

export const CHECKS: readonly SmokeCheck[] = [
  {
    task: "stack",
    name: "the stacks are healthy",
    run: ({ aws, add }) => {
      const s = stack(aws);
      add(
        "stack",
        `${SERVICE_STACK_NAME} is healthy`,
        s && isHealthyStackStatus(s.status) ? "PASS" : "FAIL",
        s?.status ?? `not found in ${REGION}`,
      );
      const dns = describeStack(aws, DNS_STACK_NAME);
      // The DNS stack is optional (DNS_ZONE_NAME): report it, and fail only a broken one.
      if (!dns)
        add("stack", `${DNS_STACK_NAME} is healthy`, "INFO", "not deployed (DNS_ZONE_NAME is off)");
      else
        add(
          "stack",
          `${DNS_STACK_NAME} is healthy`,
          isHealthyStackStatus(dns.status) ? "PASS" : "FAIL",
          dns.status,
        );
    },
  },
  {
    task: "outputs",
    name: "the named outputs",
    run: ({ aws, add }) => {
      const s = stack(aws);
      if (!s) return add("outputs", "the named outputs", "FAIL", "no stack");
      const missing = REQUIRED_OUTPUTS.filter((k) => !s.outputs[k]);
      add(
        "outputs",
        "the outputs docs/deploy.md names exist",
        missing.length === 0 ? "PASS" : "FAIL",
        missing.length === 0 ? REQUIRED_OUTPUTS.join(", ") : `missing ${missing.join(", ")}`,
      );
      const custom = CUSTOM_DOMAIN_OUTPUTS.filter((k) => s.outputs[k]);
      add(
        "outputs",
        "the custom domain outputs",
        custom.length === CUSTOM_DOMAIN_OUTPUTS.length
          ? "PASS"
          : custom.length === 0
            ? "INFO"
            : "FAIL",
        custom.length === 0 ? "no custom domain" : custom.join(", "),
      );
    },
  },
  {
    task: "auth",
    name: "the managed-login domain and its branding",
    run: ({ aws, add }) => {
      const s = stack(aws);
      const url = s?.outputs.ManagedLoginDomainUrl ?? "";
      add(
        "auth",
        "the managed-login domain is <prefix>.auth.<region>.amazoncognito.com",
        new RegExp(`^https://[a-z0-9-]+\\.auth\\.${REGION}\\.amazoncognito\\.com$`).test(url)
          ? "PASS"
          : "FAIL",
        url || "no ManagedLoginDomainUrl",
      );
      const pool = s?.outputs.UserPoolId;
      const client = s?.outputs.FacadeClientId;
      if (!pool || !client)
        return add(
          "auth",
          "the facade client has a branding style",
          "FAIL",
          "no user pool or client output",
        );
      try {
        const b = aws("cognito-idp", "describe-managed-login-branding-by-client", [
          "--user-pool-id",
          pool,
          "--client-id",
          client,
        ]) as { ManagedLoginBranding?: { ManagedLoginBrandingId?: string } };
        // Without one, Managed Login v2 shows "Login pages unavailable" (docs/deploy.md).
        add(
          "auth",
          "the facade client has a branding style",
          b.ManagedLoginBranding?.ManagedLoginBrandingId ? "PASS" : "FAIL",
          b.ManagedLoginBranding?.ManagedLoginBrandingId ? "present" : "none",
        );
      } catch (err) {
        if (!isNotFound(err)) throw err;
        add(
          "auth",
          "the facade client has a branding style",
          "FAIL",
          'none: the hosted login page would show "Login pages unavailable"',
        );
      }
    },
  },
  {
    task: "api",
    name: "the API's public routes",
    run: async (ctx) => {
      const s = stack(ctx.aws);
      const origin = s ? publicOrigin(s) : undefined;
      if (!s || !origin)
        return ctx.add("api", "the API's public routes", "FAIL", "no McpResourceIdentifier output");
      const openapi = await http(ctx, `${origin}/openapi.json`);
      const version = (openapi.json as { openapi?: unknown } | undefined)?.openapi;
      ctx.add(
        "api",
        "GET /openapi.json is the OpenAPI 3.1 contract",
        openapi.status === 200 && typeof version === "string" && version.startsWith("3.1")
          ? "PASS"
          : "FAIL",
        `HTTP ${openapi.status}${version ? `, openapi ${String(version)}` : ""}`,
      );
      const prm = await http(ctx, `${origin}/.well-known/oauth-protected-resource/mcp`);
      const resource = (prm.json as { resource?: unknown } | undefined)?.resource;
      ctx.add(
        "api",
        "the MCP resource metadata names the MCP resource",
        prm.status === 200 && resource === s.outputs.McpResourceIdentifier ? "PASS" : "FAIL",
        `HTTP ${prm.status}`,
      );
      const as = await http(ctx, `${origin}/.well-known/oauth-authorization-server`);
      ctx.add(
        "api",
        "the OAuth authorization server metadata is served",
        as.status === 200 && (as.json as { issuer?: unknown } | undefined)?.issuer === origin
          ? "PASS"
          : "FAIL",
        `HTTP ${as.status}`,
      );
      for (const path of ["/v1/sessions", "/mcp"]) {
        const r = await http(ctx, `${origin}${path}`);
        ctx.add(
          "api",
          `GET ${path} without a token is refused`,
          r.status === 401 ? "PASS" : "FAIL",
          `HTTP ${r.status}`,
        );
      }
      // The default endpoint serves the same API (docs/deploy.md, Option A).
      const direct = await http(ctx, `${s.outputs.ApiUrl}/openapi.json`);
      ctx.add(
        "api",
        "the default execute-api endpoint answers",
        direct.status === 200 ? "PASS" : "FAIL",
        `HTTP ${direct.status}`,
      );
    },
  },
  {
    task: "functions",
    name: "the functions' runtime, tracing and Powertools",
    run: ({ aws, add }) => {
      const fns = serviceFunctions(aws);
      if (fns.length === 0)
        return add("functions", "the service's functions exist", "FAIL", "none in the stack");
      add("functions", "the service's functions exist", "PASS", `${fns.length} function(s)`);
      for (const { logicalId, config } of fns) {
        const env = config.Environment?.Variables ?? {};
        const problems: string[] = [];
        if (config.TracingConfig?.Mode !== "Active")
          problems.push(`tracing ${config.TracingConfig?.Mode ?? "off"}`);
        if (!env.POWERTOOLS_SERVICE_NAME) problems.push("no POWERTOOLS_SERVICE_NAME");
        if (config.PackageType === "Image") {
          // The image's TZ is :/etc/localtime, which the Logger cannot resolve (docs/deploy.md, Observability).
          if (env.TZ !== "UTC") problems.push(`TZ ${env.TZ ?? "unset"}`);
        } else if (config.Runtime !== "nodejs26.x")
          problems.push(`runtime ${config.Runtime ?? "?"}`);
        add(
          "functions",
          `${logicalId}: Node 26 or the bridge image, active tracing, Powertools`,
          problems.length === 0 ? "PASS" : "FAIL",
          problems.join(", "),
        );
      }
    },
  },
  {
    task: "secrets",
    name: "the Kiro API key lives in Secrets Manager",
    run: ({ aws, add }) => {
      const fns = serviceFunctions(aws);
      const arns = new Set(
        fns
          .map((f) => f.config.Environment?.Variables?.KIRO_API_KEY_SECRET_ARN)
          .filter((a): a is string => Boolean(a)),
      );
      const plain = fns
        .filter((f) => f.config.Environment?.Variables?.KIRO_API_KEY !== undefined)
        .map((f) => f.logicalId);
      add(
        "secrets",
        "no function has the Kiro API key as a plain variable",
        plain.length === 0 ? "PASS" : "FAIL",
        plain.join(", "),
      );
      if (arns.size !== 1)
        return add(
          "secrets",
          "the bridge reads one Kiro API key secret",
          "FAIL",
          `${arns.size} secret ARN(s)`,
        );
      const [arn] = [...arns] as [string];
      try {
        // Its metadata, never its value: the smoke role may not read one.
        aws("secretsmanager", "describe-secret", ["--secret-id", arn, "--query", "Name"]);
        add(
          "secrets",
          "the bridge's Kiro API key secret exists",
          "PASS",
          arn.split(":").at(-1) ?? "",
        );
      } catch (err) {
        if (!isNotFound(err)) throw err;
        add("secrets", "the bridge's Kiro API key secret exists", "FAIL", "not found");
      }
    },
  },
  {
    task: "provenance",
    name: "the functions carry the deployed commit",
    run: ({ aws, add }) => {
      const want = process.env.DEPLOY_COMMIT;
      for (const { logicalId, config } of serviceFunctions(aws)) {
        const attrs = parseResourceAttributes(
          config.Environment?.Variables?.OTEL_RESOURCE_ATTRIBUTES,
        );
        const got = attrs[COMMIT_ATTRIBUTE];
        const ok =
          got !== undefined && /^[0-9a-f]{40}$/.test(got) && (want === undefined || got === want);
        add(
          "provenance",
          `${logicalId}: OTEL_RESOURCE_ATTRIBUTES names the deployed commit`,
          ok ? "PASS" : "FAIL",
          got
            ? `${got.slice(0, 12)}${want && got !== want ? `, deployed ${want.slice(0, 12)}` : ""}`
            : "no vcs.ref.head.revision",
        );
      }
    },
  },
  {
    task: "queues",
    name: "the GitHub dead-letter queue",
    run: ({ aws, add }) => {
      const res = aws("cloudformation", "list-stack-resources", [
        "--stack-name",
        SERVICE_STACK_NAME,
      ]) as {
        StackResourceSummaries?: Array<{
          LogicalResourceId: string;
          PhysicalResourceId?: string;
          ResourceType: string;
        }>;
      };
      const dlq = (res.StackResourceSummaries ?? []).find(
        (r) =>
          r.ResourceType === "AWS::SQS::Queue" &&
          r.LogicalResourceId.startsWith("KiroRemoteGithubDlq"),
      );
      if (!dlq?.PhysicalResourceId)
        return add(
          "queues",
          "the GitHub dead-letter queue",
          "INFO",
          "no GitHub wake in this stack",
        );
      // Waits (docs/github.md): the API asks the GitHub consumer to read an awaited PR through
      // this queue, so it must name it. Without it every wait would answer 501.
      const queue = (res.StackResourceSummaries ?? []).find(
        (r) =>
          r.ResourceType === "AWS::SQS::Queue" &&
          r.LogicalResourceId.startsWith("KiroRemoteGithubQueue"),
      );
      const apiFn = serviceFunctions(aws).find((f) => f.logicalId.startsWith("KiroRemoteApiFn"));
      if (queue?.PhysicalResourceId) {
        const named =
          apiFn?.config.Environment?.Variables?.GITHUB_QUEUE_URL === queue.PhysicalResourceId;
        add(
          "queues",
          "the API names the GitHub queue (waits for pull requests)",
          named ? "PASS" : "FAIL",
          named ? "" : "GITHUB_QUEUE_URL is not the GitHub queue",
        );
      }
      const a = aws("sqs", "get-queue-attributes", [
        "--queue-url",
        dlq.PhysicalResourceId,
        "--attribute-names",
        "ApproximateNumberOfMessages",
      ]) as { Attributes?: { ApproximateNumberOfMessages?: string } };
      // A message there is a webhook delivery that failed earlier: a finding, not a broken deploy.
      add(
        "queues",
        "the GitHub dead-letter queue",
        "INFO",
        `${a.Attributes?.ApproximateNumberOfMessages ?? "?"} message(s)`,
      );
    },
  },
];
