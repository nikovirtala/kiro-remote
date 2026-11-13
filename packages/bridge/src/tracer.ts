/**
 * Powertools Tracer for the bridge Lambdas. Outside Lambda (tests, local runs)
 * the Tracer disables itself and {@link traced} returns the client untouched.
 */

import { Tracer } from "@aws-lambda-powertools/tracer";

export const tracer = new Tracer({ serviceName: "kiro-remote-bridge" });

/** Instrument an AWS SDK v3 client so its calls appear as X-Ray subsegments. */
export function traced<T extends { middlewareStack: unknown }>(client: T): T {
  return tracer.captureAWSv3Client(client);
}
