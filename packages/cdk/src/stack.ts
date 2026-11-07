/**
 * KiroRemoteStack: a thin Stack that hosts one {@link KiroRemote} construct and
 * applies the cdk-nag suppressions for its intentional findings.
 *
 * The app (bin/app.ts) is an even thinner consumer that just instantiates this
 * stack with props. The region flows from `props.env.region` (nothing is
 * hardcoded); Kiro sandboxes run in us-east-1 regardless.
 */

import { CfnOutput, Stack, type StackProps } from "aws-cdk-lib";
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

    // Named outputs with stable logical ids so operators can copy-paste the
    // resource ids the docs tell them to look up. Values are read from the
    // construct members -- nothing here is hardcoded.
    new CfnOutput(this, "UserPoolId", {
      value: this.kiroRemote.auth.userPool.userPoolId,
      description: "Cognito user pool id",
    });
    new CfnOutput(this, "FacadeClientId", {
      value: this.kiroRemote.auth.facadeClient.userPoolClientId,
      description: "The public, no-secret facade app client id",
    });
    new CfnOutput(this, "ApiUrl", {
      value: this.kiroRemote.httpApi.apiEndpoint,
      description: "The HTTP API default endpoint (facade base host)",
    });
    new CfnOutput(this, "ManagedLoginDomainUrl", {
      value: this.kiroRemote.auth.managedLoginDomain.baseUrl(),
      description: "Cognito managed-login domain base URL",
    });
    new CfnOutput(this, "McpResourceIdentifier", {
      value: this.kiroRemote.auth.mcpResourceIdentifier,
      description: "The RFC 8707 MCP resource identifier (<host>/mcp audience)",
    });

    // When a custom domain is configured, publish the regional target the
    // operator must CNAME to at their DNS provider (e.g. Cloudflare). The ACM
    // DNS-validation record values are not emitted as outputs for a zone-less
    // DNS-validated cert -- read those from the ACM console / describe-certificate.
    if (this.kiroRemote.customDomainName) {
      new CfnOutput(this, "CustomDomainTarget", {
        value: this.kiroRemote.customDomainName.regionalDomainName,
        description:
          "API Gateway regional domain name -- the CNAME target for the custom host (set at your DNS provider)",
      });
      new CfnOutput(this, "CustomDomainHostedZoneId", {
        value: this.kiroRemote.customDomainName.regionalHostedZoneId,
        description:
          "Region-specific Route 53 hosted zone id of the custom domain regional endpoint",
      });
    }
  }
}
