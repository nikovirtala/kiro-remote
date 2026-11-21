#!/usr/bin/env node
/**
 * kiro-remote's smoke checks (packages/pipeline/src/smoke/checks.ts). Read-only: every AWS call is a
 * describe-, get- or list- call, and the HTTP requests are GETs.
 *
 *   node packages/pipeline/scripts/smoke.ts             # one line per check
 *   node packages/pipeline/scripts/smoke.ts --json      # what the pipeline's smoke stage reads
 *   node packages/pipeline/scripts/smoke.ts --dry-run   # each check's calls, none made
 *
 * Needs the AWS CLI and read-only credentials for the account. Exit 0 = no FAIL, 1 = a FAIL.
 */
import { smokeMain } from "@nikovirtala/deployment";
import { REGION } from "../src/names.ts";
import { CHECKS } from "../src/smoke/checks.ts";

process.exitCode = await smokeMain(CHECKS, { region: REGION });
