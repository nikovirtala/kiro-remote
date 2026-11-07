/**
 * cdk-nag wiring for the KiroRemote stack (cdk-nag v3 / CDK Validations API).
 *
 * cdk-nag v3 dropped the `NagSuppressions`/Aspects model. Checks are now
 * registered as a CDK policy-validation PLUGIN, and findings are suppressed by
 * ACKNOWLEDGING them on a construct via `Validations.of(scope).acknowledge()`.
 * If any un-acknowledged finding remains, `app.synth()` is interrupted and the
 * report is shown -- which is exactly the "fail on un-suppressed error" gate.
 *
 * {@link applyAwsSolutionsChecks} registers the AwsSolutions plugin on a scope.
 *
 * {@link suppressIntentionalFindings} acknowledges EXACTLY the intentional
 * findings, each with a one-line justification. Acknowledgments cascade to
 * descendants, so a rule acknowledged on the stack covers that rule for every
 * resource beneath it; nothing is blanket-suppressed beyond the listed ids.
 */

import { Validations } from "aws-cdk-lib";
import { AwsSolutionsChecks } from "cdk-nag";
import type { IConstruct } from "constructs";

/** Register the AwsSolutions checks plugin on an app/stage scope. */
export function applyAwsSolutionsChecks(scope: IConstruct): void {
  Validations.of(scope).addPlugins(new AwsSolutionsChecks(scope, { verbose: true }));
}

/**
 * Acknowledge exactly the intentional AwsSolutions findings for the KiroRemote
 * stack. Every entry is justified inline. Because acknowledgments cascade to
 * descendants, acknowledging on the stack scope covers that rule id for all of
 * the stack's resources.
 */
export function suppressIntentionalFindings(scope: IConstruct): void {
  Validations.of(scope).acknowledge(
    // Lambda runtime pinned to the latest CDK-supported managed Node runtime.
    {
      id: "AwsSolutions-L1",
      reason:
        "Functions target the latest CDK-supported managed Node runtime (NODEJS_22_X); the runtime is pinned deliberately.",
    },
    // IAM4: the Lambda execution roles use the AWS-managed basic-execution
    // policy for CloudWatch Logs only.
    {
      id: "AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
      reason:
        "The Lambda execution roles use the AWS-managed AWSLambdaBasicExecutionRole for CloudWatch Logs only; all data-plane access is granted via scoped inline policies.",
    },
    // IAM5: the object-level and index wildcards are intrinsic to S3/DynamoDB
    // access and remain bound to THIS construct's OWN bucket/table.
    {
      id: "AwsSolutions-IAM5[Resource::<KiroRemotePayloadBucket47E35FF6.Arn>/*]",
      reason:
        "Object-level access is scoped to this construct's OWN payload bucket (bucket-arn/*); no other bucket is reachable.",
    },
    {
      id: "AwsSolutions-IAM5[Resource::<KiroRemoteTable897F2E95.Arn>/index/*]",
      reason:
        "GSI access is scoped to this construct's OWN table indexes (table-arn/index/*); required to query GSI1.",
    },
    // IAM5: the S3 action wildcards are the exact actions the CDK grantReadWrite
    // helper emits, bound to this construct's own bucket.
    {
      id: "AwsSolutions-IAM5[Action::s3:GetObject*]",
      reason: "Emitted by the scoped grantReadWrite on this construct's OWN bucket.",
    },
    {
      id: "AwsSolutions-IAM5[Action::s3:GetBucket*]",
      reason: "Emitted by the scoped grantReadWrite on this construct's OWN bucket.",
    },
    {
      id: "AwsSolutions-IAM5[Action::s3:List*]",
      reason: "Emitted by the scoped grantReadWrite on this construct's OWN bucket.",
    },
    {
      id: "AwsSolutions-IAM5[Action::s3:DeleteObject*]",
      reason: "Emitted by the scoped grantReadWrite on this construct's OWN bucket.",
    },
    {
      id: "AwsSolutions-IAM5[Action::s3:Abort*]",
      reason: "Emitted by the scoped grantReadWrite on this construct's OWN bucket.",
    },
    // IAM5: the KMS action wildcards are the exact actions grantEncrypt/
    // grantDecrypt emit, bound to this construct's OWN OAUTH#CODE key.
    {
      id: "AwsSolutions-IAM5[Action::kms:GenerateDataKey*]",
      reason:
        "Emitted by the scoped KMS grantEncrypt on this construct's OWN OAUTH#CODE key (callback handler only).",
    },
    {
      id: "AwsSolutions-IAM5[Action::kms:ReEncrypt*]",
      reason:
        "Emitted by the scoped KMS grantEncrypt on this construct's OWN OAUTH#CODE key (callback handler only).",
    },
    // SMG4: the Kiro API key is a long-lived personal token (ksk_) that is
    // rotated out-of-band by the operator, not by Secrets Manager rotation.
    {
      id: "AwsSolutions-SMG4",
      reason:
        "KIRO_API_KEY (ksk_) is a long-lived personal token rotated out-of-band by the operator; automatic Secrets Manager rotation is not applicable to a user API key.",
    },
    // COG8: the user pool stays on the Essentials feature plan (passkeys);
    // the Plus tier is not warranted for a single-tenant personal control plane.
    {
      id: "AwsSolutions-COG8",
      reason:
        "The pool uses the Essentials feature plan (passwordless passkey-first sign-in, self-sign-up off); the Plus tier's threat-protection is not warranted for a single-tenant personal control plane.",
    },
    // DynamoDB: PITR explicitly enabled; acknowledgement is informational.
    {
      id: "AwsSolutions-DDB3",
      reason: "Point-in-time recovery is explicitly enabled on the table.",
    },
    // Cognito user pool posture.
    {
      id: "AwsSolutions-COG1",
      reason:
        "Self-sign-up is OFF and the pool is admin-created only; a password-complexity policy does not apply to an admin-provisioned, passkey-first pool.",
    },
    {
      id: "AwsSolutions-COG2",
      reason:
        "No separately-required MFA step: the pool is passwordless and passkey-first, and a passkey login is already multi-factor (possession + required user verification). Cognito rejects requiring MFA on top of a passkey first-auth factor.",
    },
    {
      id: "AwsSolutions-COG3",
      reason:
        "AdvancedSecurityMode is left at the feature-plan default for a single-tenant personal control plane; the facade API is WAF rate-limited.",
    },
    // ECS: non-secret env vars are only resource names/limits; KIRO_API_KEY is
    // injected via ECS `secrets` from Secrets Manager, never a plain env var.
    {
      id: "AwsSolutions-ECS2",
      reason:
        "The only non-secret environment variables are resource names/limits (table, bucket, queue, region, caps); KIRO_API_KEY is injected via ECS secrets from Secrets Manager.",
    },
    // EC2 SG: the bridge SG has NO ingress and egress on 443 only.
    {
      id: "AwsSolutions-EC23",
      reason:
        "The bridge security group has NO ingress; egress is restricted to tcp/443 to reach AWS service endpoints and kiro.dev from a public-subnet, no-NAT design.",
    },
    // VPC flow logs omitted for this single-task, public-subnet, no-NAT VPC.
    {
      id: "AwsSolutions-VPC7",
      reason:
        "Flow logs are omitted for this single-task, public-subnet, no-NAT VPC whose only traffic is 443 egress.",
    },
    // API Gateway HTTP API observability + authorization boundary.
    {
      id: "AwsSolutions-APIG1",
      reason:
        "Request/response observability is emitted by the Lambda handlers (Powertools) and CloudWatch; HTTP API access logs are not separately enabled.",
    },
    {
      id: "AwsSolutions-APIG4",
      reason:
        "Authorization runs INSIDE the Lambda via authenticate() (never an API Gateway authorizer); the OAuth facade endpoints and metadata are intentionally public per RFC 9728/8414.",
    },
    // S3 server access logging omitted; bucket blocks public access + SSE + SSL.
    {
      id: "AwsSolutions-S1",
      reason:
        "Server access logging is omitted; the bucket blocks ALL public access, uses SSE, and enforces SSL, and only the API/bridge roles can read/write it.",
    },
    // SQS: no DLQ; idempotent commands are redelivered and expire via retention.
    {
      id: "AwsSolutions-SQS3",
      reason:
        "No DLQ: command messages are idempotent and left for visibility-timeout redelivery; they expire via the retention period rather than dead-lettering.",
    },
  );
}
