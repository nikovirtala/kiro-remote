/**
 * KiroRemoteStack: a thin Stack that hosts one {@link KiroRemote} construct and
 * applies the cdk-nag suppressions for its intentional findings.
 *
 * The app (bin/app.ts) is an even thinner consumer that just instantiates this
 * stack with props. The region flows from `props.env.region` (nothing is
 * hardcoded); Kiro sandboxes run in us-east-1 regardless.
 */

import { Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { KiroRemote, type KiroRemoteProps } from "./construct.ts";
import { suppressIntentionalFindings } from "./nag.ts";

export interface KiroRemoteStackProps extends StackProps {
  /** The KiroRemote construct props (host, repos, limits, images, ...). */
  kiroRemote: KiroRemoteProps;
}

export class KiroRemoteStack extends Stack {
  readonly kiroRemote: KiroRemote;

  constructor(scope: Construct, id: string, props: KiroRemoteStackProps) {
    super(scope, id, props);
    this.kiroRemote = new KiroRemote(this, "KiroRemote", props.kiroRemote);
    // Justified, inline suppressions for every intentional AwsSolutions finding.
    suppressIntentionalFindings(this.kiroRemote);
  }
}
