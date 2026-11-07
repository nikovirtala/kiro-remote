/**
 * KiroRemoteDnsStack: a thin Stack that hosts one {@link KiroRemoteDns}
 * construct (the Route 53 public hosted zone for the delegated subdomain) and
 * publishes the outputs the operator needs to delegate the zone.
 *
 * Deploy this stack FIRST, read the `NameServers` output, and paste those four
 * nameservers at the parent DNS provider (Cloudflare) as NS records for the
 * `kiro-remote` subdomain ("DNS only"). Once delegation propagates, deploy the
 * app stack ({@link import("./stack.ts").KiroRemoteStack}) with
 * `-c hostedZoneId=<HostedZoneId output>` so it imports this zone and manages
 * the ACM certificate validation + the alias record automatically -- no further
 * manual DNS. See [`docs/deploy.md`](../../../docs/deploy.md).
 */

import { CfnOutput, Fn, Stack, type StackProps } from "aws-cdk-lib";
import type { Construct } from "constructs";
import { KiroRemoteDns } from "./dns.ts";

export interface KiroRemoteDnsStackProps extends StackProps {
  /** The fully-qualified name of the delegated zone, e.g. "kiro-remote.nikovirtala.dev". */
  zoneName: string;
}

export class KiroRemoteDnsStack extends Stack {
  readonly dns: KiroRemoteDns;

  constructor(scope: Construct, id: string, props: KiroRemoteDnsStackProps) {
    super(scope, id, props);
    this.dns = new KiroRemoteDns(this, "KiroRemoteDns", { zoneName: props.zoneName });

    const hostedZone = this.dns.hostedZone;

    // `hostedZoneNameServers` is a string[] token; join it so the output is a
    // single readable comma-separated list. These are the four Route 53
    // nameservers the operator pastes at Cloudflare to delegate the subdomain.
    new CfnOutput(this, "NameServers", {
      value: Fn.join(",", hostedZone.hostedZoneNameServers ?? []),
      description:
        "Route 53 nameservers for the delegated zone -- paste these as NS records for the subdomain at your DNS provider (Cloudflare, 'DNS only'), then deploy KiroRemoteStack",
    });
    new CfnOutput(this, "HostedZoneId", {
      value: hostedZone.hostedZoneId,
      description:
        "Hosted zone id -- pass it to the app stack via `-c hostedZoneId=<id>` so it imports this zone for cert validation + the alias record",
    });
    new CfnOutput(this, "HostedZoneName", {
      value: hostedZone.zoneName,
      description: "The delegated zone name (the custom-domain host / zone apex)",
    });
  }
}
