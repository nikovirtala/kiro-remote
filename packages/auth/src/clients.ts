/**
 * Client resolution: a `client_id` presented at /oauth/authorize is either an
 * HTTPS CIMD URL (fetched + validated under the SSRF guard) or a
 * pre-registered client id. In both cases the `redirect_uri` must match an
 * allowed value EXACTLY (RFC: open-redirection mitigation).
 */

import { CimdError, type CimdFetcher } from "./cimd.ts";

/** A resolved client with its allowed redirect URIs and display name. */
export interface ResolvedClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  /** True when resolved from a CIMD document (vs pre-registration). */
  isCimd: boolean;
}

/** Pre-registered client entry (set up by the construct prop). */
export interface PreRegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
}

export interface ClientResolverDeps {
  cimd: CimdFetcher;
  preRegistered: readonly PreRegisteredClient[];
}

/**
 * True when a candidate redirect URI is a loopback URI whose only variable
 * part is the port, per the OAuth 2.1 native-app loopback rule. A registered
 * `http://127.0.0.1/callback` (or ::1 / localhost) matches any port.
 */
export function loopbackRedirectMatches(registered: string, candidate: string): boolean {
  let reg: URL;
  let cand: URL;
  try {
    reg = new URL(registered);
    cand = new URL(candidate);
  } catch {
    return false;
  }
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (!loopbackHosts.has(reg.hostname) || !loopbackHosts.has(cand.hostname)) {
    return false;
  }
  if (reg.protocol !== "http:" || cand.protocol !== "http:") {
    return false;
  }
  return reg.hostname === cand.hostname && reg.pathname === cand.pathname;
}

/** Exact match, with the loopback port exception for native clients. */
export function redirectUriAllowed(allowed: readonly string[], candidate: string): boolean {
  for (const entry of allowed) {
    if (entry === candidate) {
      return true;
    }
    if (loopbackRedirectMatches(entry, candidate)) {
      return true;
    }
  }
  return false;
}

export class ClientResolver {
  private readonly cimd: CimdFetcher;
  private readonly preRegistered: Map<string, PreRegisteredClient>;

  constructor(deps: ClientResolverDeps) {
    this.cimd = deps.cimd;
    this.preRegistered = new Map(deps.preRegistered.map((c) => [c.clientId, c]));
  }

  /** Resolve a client_id to its allowed redirect URIs. Throws CimdError. */
  async resolve(clientId: string): Promise<ResolvedClient> {
    if (clientId.startsWith("https://")) {
      const { document } = await this.cimd.fetch(clientId);
      return {
        clientId,
        clientName: document.client_name,
        redirectUris: document.redirect_uris,
        isCimd: true,
      };
    }
    const pre = this.preRegistered.get(clientId);
    if (!pre) {
      throw new CimdError("invalid_client", "unknown client_id");
    }
    return {
      clientId: pre.clientId,
      clientName: pre.clientName,
      redirectUris: pre.redirectUris,
      isCimd: false,
    };
  }
}
