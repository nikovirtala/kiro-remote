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

/**
 * A dynamically-registered (RFC 7591) client as seen by the pure auth code.
 * This is the transport-agnostic shape the {@link DynamicClientStore} port
 * exchanges; the concrete DynamoDB-backed adapter (in packages/api wiring)
 * maps this to/from the core `RegisteredClientItem` (PK/SK stripped).
 */
export interface ResolvedDynamicClient {
  clientId: string;
  clientName: string | null;
  redirectUris: string[];
  grantTypes: string[];
  responseTypes: string[];
  tokenEndpointAuthMethod: string;
  createdAt: number;
}

/**
 * Injectable store for dynamically-registered clients. Keeping this an
 * interface (mirroring how CimdFetcher/httpGet/CognitoPort/KmsPort are
 * injected) keeps packages/auth free of any @aws-sdk / core Repository import
 * in its pure code paths. The concrete repo-backed adapter lives in the
 * packages/api wiring.
 */
export interface DynamicClientStore {
  getClient(clientId: string): Promise<ResolvedDynamicClient | null>;
  putClient(client: ResolvedDynamicClient): Promise<void>;
}

export interface ClientResolverDeps {
  cimd: CimdFetcher;
  preRegistered: readonly PreRegisteredClient[];
  /** Optional store of dynamically-registered (RFC 7591) clients. */
  dynamic?: DynamicClientStore;
}

/** Loopback hosts permitted for an `http:` native-app redirect URI. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * True when a redirect URI is allowed at registration (RFC 7591) / resolution:
 * either an absolute `https:` URI OR an `http:` loopback URI (host in
 * {127.0.0.1, ::1, localhost}). Everything else is rejected: arbitrary `http:`,
 * opaque/custom schemes, and relative URIs (which fail to parse as absolute).
 */
export function isAllowedRedirectUri(uri: string): boolean {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return false;
  }
  if (url.protocol === "https:") {
    return true;
  }
  if (url.protocol === "http:") {
    return LOOPBACK_HOSTS.has(url.hostname);
  }
  return false;
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
  if (!LOOPBACK_HOSTS.has(reg.hostname) || !LOOPBACK_HOSTS.has(cand.hostname)) {
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
  private readonly dynamic?: DynamicClientStore;

  constructor(deps: ClientResolverDeps) {
    this.cimd = deps.cimd;
    this.preRegistered = new Map(deps.preRegistered.map((c) => [c.clientId, c]));
    this.dynamic = deps.dynamic;
  }

  /**
   * Resolve a client_id to its allowed redirect URIs. Resolution order:
   *   1. an `https://` client_id -> CIMD (fetched under the SSRF guard),
   *   2. else a pre-registered client,
   *   3. else, if a dynamic store is configured, a dynamically-registered
   *      (RFC 7591) client,
   *   4. else throw `invalid_client`.
   * Throws CimdError.
   */
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
    if (pre) {
      return {
        clientId: pre.clientId,
        clientName: pre.clientName,
        redirectUris: pre.redirectUris,
        isCimd: false,
      };
    }
    if (this.dynamic) {
      const dyn = await this.dynamic.getClient(clientId);
      if (dyn) {
        return {
          clientId: dyn.clientId,
          clientName: dyn.clientName ?? dyn.clientId,
          redirectUris: dyn.redirectUris,
          isCimd: false,
        };
      }
    }
    throw new CimdError("invalid_client", "unknown client_id");
  }
}
