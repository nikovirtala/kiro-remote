/** POST /github/webhook (API Gateway HTTP API v2). Reads the webhook secret; nothing else. */

import { handleWebhook } from "../ingress.ts";
import { createLogger, emfMetrics } from "../log.ts";
import { buildQueues, buildRepository, secretLoader, splitList } from "./runtime.ts";

interface HttpEvent {
  headers?: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}

let deps: Parameters<typeof handleWebhook>[0] | null = null;

function getDeps(): Parameters<typeof handleWebhook>[0] {
  if (!deps) {
    const env = process.env;
    const load = secretLoader(env);
    deps = {
      webhookSecret: async () => (await load()).webhookSecret,
      repo: buildRepository(env),
      queue: buildQueues(env).githubQueue,
      allowedRepos: splitList(env.ALLOWED_REPOS),
      metrics: emfMetrics(),
      logger: createLogger(),
    };
  }
  return deps;
}

export function toIngressRequest(event: HttpEvent) {
  const headers: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(event.headers ?? {})) {
    headers[k.toLowerCase()] = v;
  }
  const raw = event.body ?? "";
  return { headers, body: Buffer.from(raw, event.isBase64Encoded ? "base64" : "utf8") };
}

export async function handler(event: HttpEvent): Promise<{ statusCode: number; body: string }> {
  const res = await handleWebhook(getDeps(), toIngressRequest(event));
  return { statusCode: res.status, body: res.body };
}
