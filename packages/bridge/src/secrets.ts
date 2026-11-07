/**
 * Secret loading.
 *
 * KIRO_API_KEY (ksk_) is injected as an ECS secret at RUNTIME. It is NEVER
 * baked into the image, written to disk, or logged. The CLI owns auth by
 * reading KIRO_API_KEY from the child's environment, so the bridge only needs
 * to make sure the value is present in the child env -- never in a log line.
 *
 * In a plain ECS secret injection the value already arrives as an env var; when
 * a Secrets Manager ARN is provided instead, we resolve it here. The Secrets
 * Manager client is injected so tests run offline.
 */

import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Logger } from "./logger.ts";

export const KIRO_API_KEY_ENV = "KIRO_API_KEY";

export interface SecretsDeps {
  secretsManager?: SecretsManagerClient;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the Kiro API key. Prefers a value already present in the environment
 * (direct ECS secret injection); otherwise resolves a Secrets Manager ARN named
 * by KIRO_API_KEY_SECRET_ARN. Returns null when neither is configured. The
 * value is returned to be placed into the child env -- NEVER logged.
 */
export async function resolveKiroApiKey(deps: SecretsDeps): Promise<string | null> {
  const env = deps.env ?? process.env;
  const direct = env[KIRO_API_KEY_ENV];
  if (direct && direct.length > 0) {
    deps.logger.info("kiro_api_key_from_env");
    return direct;
  }
  const arn = env.KIRO_API_KEY_SECRET_ARN;
  if (arn && deps.secretsManager) {
    const res = await deps.secretsManager.send(new GetSecretValueCommand({ SecretId: arn }));
    deps.logger.info("kiro_api_key_from_secrets_manager");
    return res.SecretString ?? null;
  }
  deps.logger.warn("kiro_api_key_missing");
  return null;
}
