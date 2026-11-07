/**
 * KiroRemoteDns: a tiny construct that creates the Route 53 PUBLIC hosted zone
 * for a DELEGATED subdomain (e.g. `kiro-remote.nikovirtala.dev`).
 *
 * The point of a separate, delegated zone is to break the deploy ordering
 * deadlock in the custom-domain flow: ACM DNS-validation against a Route 53
 * zone (and the alias record) can only succeed once the zone's nameservers are
 * reachable, but you cannot delegate the zone until it exists and has published
 * its NS. So this zone is created and deployed FIRST (its own stack), the
 * operator pastes the four Route 53 nameservers at the parent DNS provider
 * (Cloudflare) ONCE, and only then is the app stack deployed with the zone
 * imported -- at which point cert validation and the alias record are fully
 * CDK-managed, with no further manual DNS.
 *
 * NOTHING is hardcoded to a region: a public hosted zone is a global Route 53
 * resource; the enclosing stack's `env` still drives the deploy account.
 *
 * erasableSyntaxOnly applies: no enums/namespaces/parameter properties.
 */

import { PublicHostedZone } from "aws-cdk-lib/aws-route53";
import { Construct } from "constructs";

export interface KiroRemoteDnsProps {
  /**
   * The fully-qualified name of the delegated zone, e.g.
   * "kiro-remote.nikovirtala.dev". Because the service host IS this zone's
   * apex, the app stack's custom-domain alias record is created AT the apex.
   */
  zoneName: string;
}

export class KiroRemoteDns extends Construct {
  /** The Route 53 public hosted zone for the delegated subdomain. */
  readonly hostedZone: PublicHostedZone;

  constructor(scope: Construct, id: string, props: KiroRemoteDnsProps) {
    super(scope, id);
    this.hostedZone = new PublicHostedZone(this, "HostedZone", {
      zoneName: props.zoneName,
    });
  }
}
