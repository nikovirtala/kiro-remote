/**
 * Client ID Metadata Document (CIMD) fetching + validation with an SSRF guard.
 *
 * Per draft-ietf-oauth-client-id-metadata-document-00 and the MCP 2026-07-28
 * client-registration/security-considerations pages, an authorization server
 * that fetches URL-formatted client_ids MUST mitigate SSRF. This module:
 *   - requires the https scheme and a path component,
 *   - restricts the host to an allow-list (construct prop),
 *   - resolves DNS and rejects private/link-local/loopback/unspecified IPs,
 *   - refuses ALL redirects,
 *   - caps the body at 5 KB and the whole request at 3 s,
 *   - validates the document is JSON with the required fields and that its
 *     `client_id` equals the URL exactly.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** Maximum CIMD body size accepted (bytes). */
export const CIMD_MAX_BYTES = 5 * 1024;

/** Hard request timeout (ms). */
export const CIMD_TIMEOUT_MS = 3_000;

/** A validated CIMD document (only the fields the facade relies upon). */
export interface CimdDocument {
  client_id: string;
  client_name: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
  [key: string]: unknown;
}

/** Raised for any CIMD fetch/validation failure; carries an OAuth error code. */
export class CimdError extends Error {
  readonly oauthError: string;
  constructor(oauthError: string, message: string) {
    super(message);
    this.name = "CimdError";
    this.oauthError = oauthError;
  }
}

/** The fetch result plus the HTTP cache lifetime derived from the response. */
export interface CimdFetchResult {
  document: CimdDocument;
  /** How long the document may be cached (ms), honouring Cache-Control. */
  maxAgeMs: number;
}

/** DNS resolver port (injectable so tests avoid real DNS). */
export type DnsResolver = (host: string) => Promise<string[]>;

/** Low-level HTTP getter port (injectable so tests avoid network). */
export interface CimdHttpResponse {
  status: number;
  /** True when the server attempted a redirect (3xx with Location). */
  redirected: boolean;
  headers: Record<string, string>;
  /** Raw body bytes already truncated to at most CIMD_MAX_BYTES + 1. */
  body: string;
  /** True when the body exceeded CIMD_MAX_BYTES before truncation. */
  tooLarge: boolean;
}

export type CimdHttpGetter = (
  url: string,
  opts: { timeoutMs: number; maxBytes: number },
) => Promise<CimdHttpResponse>;

export interface CimdFetcherDeps {
  allowedHosts: readonly string[];
  /** Defaults to node:dns lookup returning all addresses. */
  resolve?: DnsResolver;
  /** Defaults to a native-fetch getter with manual redirect handling. */
  httpGet?: CimdHttpGetter;
}

const PRIVATE_V4: ReadonlyArray<readonly [number, number, number]> = [
  // [first octet, second-octet low, second-octet high] where applicable.
];

/** Return true if an IPv4/IPv6 literal is private, loopback, or link-local. */
export function isDisallowedAddress(addr: string): boolean {
  const kind = isIP(addr);
  if (kind === 4) {
    const parts = addr.split(".").map((p) => Number.parseInt(p, 10));
    if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
      return true;
    }
    const [a, b] = parts;
    if (a === 0) return true; // 0.0.0.0/8 "this network"
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 127) return true; // loopback
    if (a === 169 && b === 254) return true; // link-local 169.254.0.0/16
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (kind === 6) {
    const lower = addr.toLowerCase();
    if (lower === "::1" || lower === "::") return true; // loopback / unspecified
    if (lower.startsWith("fe80")) return true; // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true; // unique-local
    // IPv4-mapped (::ffff:a.b.c.d) -> validate the embedded v4.
    const mapped = /::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(lower);
    if (mapped) {
      return isDisallowedAddress(mapped[1]);
    }
    return false;
  }
  // Not an IP literal at all -> treat as disallowed (we only pass resolved IPs).
  return true;
}

// Silence unused-constant lint while documenting intent.
void PRIVATE_V4;

const defaultResolve: DnsResolver = async (host) => {
  const results = await lookup(host, { all: true });
  return results.map((r) => r.address);
};

const defaultHttpGet: CimdHttpGetter = async (url, opts) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    const redirected = res.status >= 300 && res.status < 400;
    if (redirected) {
      return { status: res.status, redirected: true, headers: {}, body: "", tooLarge: false };
    }
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const reader = res.body?.getReader();
    let received = 0;
    let tooLarge = false;
    const chunks: Uint8Array[] = [];
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > opts.maxBytes) {
          tooLarge = true;
          await reader.cancel();
          break;
        }
        chunks.push(value);
      }
    }
    const body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8");
    return { status: res.status, redirected: false, headers, body, tooLarge };
  } finally {
    clearTimeout(timer);
  }
};

/** Parse Cache-Control max-age (seconds) into milliseconds, or 0 if absent. */
function parseMaxAgeMs(headers: Record<string, string>): number {
  const cc = headers["cache-control"];
  if (!cc) {
    return 0;
  }
  if (/no-store|no-cache/i.test(cc)) {
    return 0;
  }
  const m = /max-age\s*=\s*(\d+)/i.exec(cc);
  if (!m) {
    return 0;
  }
  return Number.parseInt(m[1], 10) * 1000;
}

/** Fetches and validates CIMD documents under a strict SSRF guard. */
export class CimdFetcher {
  private readonly allowedHosts: Set<string>;
  private readonly resolve: DnsResolver;
  private readonly httpGet: CimdHttpGetter;

  constructor(deps: CimdFetcherDeps) {
    this.allowedHosts = new Set(deps.allowedHosts.map((h) => h.toLowerCase()));
    this.resolve = deps.resolve ?? defaultResolve;
    this.httpGet = deps.httpGet ?? defaultHttpGet;
  }

  /**
   * Validate that `clientId` is a usable CIMD URL (https + path + allowed host)
   * and that every resolved address is public. Throws {@link CimdError}.
   */
  async assertSafeUrl(clientId: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(clientId);
    } catch {
      throw new CimdError("invalid_client", "client_id is not a valid URL");
    }
    if (url.protocol !== "https:") {
      throw new CimdError("invalid_client", "client_id URL must use https");
    }
    if (!url.pathname || url.pathname === "/") {
      throw new CimdError("invalid_client", "client_id URL must contain a path component");
    }
    const host = url.hostname.toLowerCase();
    if (!this.allowedHosts.has(host)) {
      throw new CimdError("invalid_client", "client_id host is not allowed");
    }
    // If the host is an IP literal, check it directly; otherwise resolve DNS.
    if (isIP(host) !== 0) {
      if (isDisallowedAddress(host)) {
        throw new CimdError("invalid_client", "client_id resolves to a disallowed address");
      }
      return url;
    }
    const addresses = await this.resolve(host);
    if (addresses.length === 0) {
      throw new CimdError("invalid_client", "client_id host did not resolve");
    }
    for (const addr of addresses) {
      if (isDisallowedAddress(addr)) {
        throw new CimdError("invalid_client", "client_id resolves to a disallowed address");
      }
    }
    return url;
  }

  /** Fetch + validate the CIMD document for a client_id URL. */
  async fetch(clientId: string): Promise<CimdFetchResult> {
    const url = await this.assertSafeUrl(clientId);
    const res = await this.httpGet(url.toString(), {
      timeoutMs: CIMD_TIMEOUT_MS,
      maxBytes: CIMD_MAX_BYTES,
    });
    if (res.redirected) {
      throw new CimdError("invalid_client", "CIMD endpoint attempted a redirect");
    }
    if (res.tooLarge) {
      throw new CimdError("invalid_client", "CIMD document exceeds the size limit");
    }
    if (res.status !== 200) {
      throw new CimdError("invalid_client", `CIMD endpoint returned ${res.status}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new CimdError("invalid_client", "CIMD document is not valid JSON");
    }
    const doc = parsed as Record<string, unknown>;
    if (typeof doc.client_id !== "string") {
      throw new CimdError("invalid_client", "CIMD document is missing client_id");
    }
    if (doc.client_id !== clientId) {
      throw new CimdError("invalid_client", "CIMD client_id does not match the URL");
    }
    if (typeof doc.client_name !== "string") {
      throw new CimdError("invalid_client", "CIMD document is missing client_name");
    }
    if (
      !Array.isArray(doc.redirect_uris) ||
      doc.redirect_uris.length === 0 ||
      !doc.redirect_uris.every((u) => typeof u === "string")
    ) {
      throw new CimdError("invalid_client", "CIMD document is missing redirect_uris");
    }
    return {
      document: doc as CimdDocument,
      maxAgeMs: parseMaxAgeMs(res.headers),
    };
  }
}
