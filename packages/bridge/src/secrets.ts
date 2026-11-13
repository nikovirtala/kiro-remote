/**
 * Secret loading.
 *
 * KIRO_API_KEY (ksk_) is resolved at RUNTIME. It is NEVER baked into the
 * image, written to disk, or logged. The engine owns auth by reading
 * KIRO_API_KEY from the child's environment, so the bridge only needs to make
 * sure the value is present in the child env -- never in a log line.
 *
 * The bridge Lambda functions get a Secrets Manager ARN (KIRO_API_KEY_SECRET_ARN)
 * and resolve it here; a KIRO_API_KEY already in the env (local runs, tests)
 * wins. The Secrets Manager client is injected so tests run offline.
 */

import { SecretsProvider } from "@aws-lambda-powertools/parameters/secrets";
import type { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import type { Logger } from "./logger.ts";

export const KIRO_API_KEY_ENV = "KIRO_API_KEY";

export interface SecretsDeps {
  secretsManager?: SecretsManagerClient;
  logger: Logger;
  env?: NodeJS.ProcessEnv;
}

/**
 * Resolve the Kiro API key. Prefers a value already present in the environment
 * (local runs and tests); otherwise resolves the Secrets Manager ARN named by
 * KIRO_API_KEY_SECRET_ARN (what the bridge Lambda functions use). Returns null when neither is configured. The
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
    const provider = new SecretsProvider({ awsSdkV3Client: deps.secretsManager });
    const secret = await provider.get(arn);
    deps.logger.info("kiro_api_key_from_secrets_manager");
    return typeof secret === "string" ? secret : null;
  }
  deps.logger.warn("kiro_api_key_missing");
  return null;
}
