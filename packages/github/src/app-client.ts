/**
 * The GitHub App client: installation tokens on demand, and the few read-only
 * API calls the integration makes.
 *
 * JWT signing and the installation-token exchange are delegated to
 * @octokit/auth-app (no hand-rolled JWTs). Tokens are minted on demand, cached
 * until {@link TOKEN_REFRESH_MARGIN_MS} before they expire, and never logged:
 * they live only in this object's memory and in the Authorization header of
 * the request that uses them. The App has read-only permissions.
 */

import { createAppAuth } from "@octokit/auth-app";
import { request } from "@octokit/request";

/** Refresh an installation token this long before it expires. */
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface AppCredentials {
  appId: string;
  privateKey: string;
  webhookSecret: string;
}

/** Parse the Secrets Manager JSON: `{ appId, privateKey, webhookSecret }`. */
export function parseAppSecret(secretString: string): AppCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new Error("GitHub App secret is not valid JSON");
  }
  const o = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<
    string,
    unknown
  >;
  const appId = typeof o.appId === "number" ? String(o.appId) : o.appId;
  for (const [name, value] of [
    ["appId", appId],
    ["privateKey", o.privateKey],
    ["webhookSecret", o.webhookSecret],
  ] as const) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`GitHub App secret is missing "${name}"`);
    }
  }
  return {
    appId: appId as string,
    // Secret consoles often store the PEM with literal \n sequences.
    privateKey: (o.privateKey as string).replace(/\\n/g, "\n"),
    webhookSecret: o.webhookSecret as string,
  };
}

/** The slice of a pull request the integration reads. */
export interface PullInfo {
  number: number;
  state: "open" | "closed";
  merged: boolean;
  createdAt: string;
  headSha: string;
  headRef: string;
  authorLogin: string | null;
  body: string | null;
}

export interface ReviewCommentInfo {
  path: string;
  line: number | null;
  body: string;
}

export interface WebhookDeliverySummary {
  id: number;
  guid: string;
  deliveredAt: string;
  status: string;
}

type AuthFn = (opts: {
  type: "app" | "installation";
  installationId?: number;
  refresh?: boolean;
}) => Promise<{ token: string; expiresAt?: string }>;

type RequestFn = (route: string, params?: Record<string, unknown>) => Promise<{ data: unknown }>;

export interface GithubClientOptions {
  credentials: AppCredentials;
  now?: () => number;
  /** Test seams. */
  auth?: AuthFn;
  request?: RequestFn;
}

interface CachedToken {
  token: string;
  expiresAtMs: number;
}

export class GithubClient {
  private readonly auth: AuthFn;
  private readonly req: RequestFn;
  private readonly now: () => number;
  private readonly tokens = new Map<number, CachedToken>();
  private readonly repoInstallations = new Map<string, number>();

  constructor(opts: GithubClientOptions) {
    this.now = opts.now ?? (() => Date.now());
    this.auth =
      opts.auth ??
      (createAppAuth({
        appId: opts.credentials.appId,
        privateKey: opts.credentials.privateKey,
      }) as unknown as AuthFn);
    this.req =
      opts.request ??
      ((route, params) => request(route, params ?? {}) as Promise<{ data: unknown }>);
  }

  /** A valid installation token, minted only when none is cached with 5+ minutes left. */
  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    if (cached && cached.expiresAtMs - this.now() > TOKEN_REFRESH_MARGIN_MS) {
      return cached.token;
    }
    // refresh: true skips auth-app's own cache; this class decides when to refresh.
    const fresh = await this.auth({ type: "installation", installationId, refresh: true });
    const expiresAtMs = fresh.expiresAt ? Date.parse(fresh.expiresAt) : this.now() + 55 * 60 * 1000;
    this.tokens.set(installationId, { token: fresh.token, expiresAtMs });
    return fresh.token;
  }

  private async appJwt(): Promise<string> {
    return (await this.auth({ type: "app" })).token;
  }

  private async asInstallation(
    installationId: number,
    route: string,
    params: Record<string, unknown> = {},
  ) {
    const token = await this.installationToken(installationId);
    return this.req(route, { ...params, headers: { authorization: `bearer ${token}` } });
  }

  private async asApp(route: string, params: Record<string, unknown> = {}) {
    const jwt = await this.appJwt();
    return this.req(route, { ...params, headers: { authorization: `bearer ${jwt}` } });
  }

  /** The App's installation id for a repo (cached). Null when the App is not installed there. */
  async installationIdForRepo(repo: string): Promise<number | null> {
    const key = repo.toLowerCase();
    const known = this.repoInstallations.get(key);
    if (known !== undefined) {
      return known;
    }
    const [owner, name] = repo.split("/");
    try {
      const res = await this.asApp("GET /repos/{owner}/{repo}/installation", { owner, repo: name });
      const id = Number((res.data as { id?: unknown }).id);
      if (!Number.isSafeInteger(id)) {
        return null;
      }
      this.repoInstallations.set(key, id);
      return id;
    } catch (err) {
      if (statusOf(err) === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Read a pull request. Null when it does not exist (or the App cannot see it). */
  async getPull(repo: string, number: number, installationId?: number): Promise<PullInfo | null> {
    const id = installationId ?? (await this.installationIdForRepo(repo));
    if (id === null) {
      return null;
    }
    const [owner, name] = repo.split("/");
    try {
      const res = await this.asInstallation(id, "GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo: name,
        pull_number: number,
      });
      const d = res.data as {
        number: number;
        state: "open" | "closed";
        merged?: boolean;
        created_at: string;
        head: { sha: string; ref: string };
        user?: { login?: string } | null;
        body?: string | null;
      };
      return {
        number: d.number,
        state: d.state,
        merged: d.merged === true,
        createdAt: d.created_at,
        headSha: d.head.sha,
        headRef: d.head.ref,
        authorLogin: d.user?.login ?? null,
        body: d.body ?? null,
      };
    } catch (err) {
      if (statusOf(err) === 404) {
        return null;
      }
      throw err;
    }
  }

  /** Inline comments of one review. */
  async listReviewComments(
    repo: string,
    number: number,
    reviewId: number,
    installationId: number,
  ): Promise<ReviewCommentInfo[]> {
    const [owner, name] = repo.split("/");
    const res = await this.asInstallation(
      installationId,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
      { owner, repo: name, pull_number: number, review_id: reviewId, per_page: 100 },
    );
    return (
      res.data as Array<{
        path: string;
        line?: number | null;
        original_line?: number | null;
        body: string;
      }>
    ).map((c) => ({ path: c.path, line: c.line ?? c.original_line ?? null, body: c.body }));
  }

  /** The App's most recent webhook deliveries (App JWT), newest first. */
  async listAppDeliveries(perPage = 100): Promise<WebhookDeliverySummary[]> {
    const res = await this.asApp("GET /app/hook/deliveries", { per_page: perPage });
    return (
      res.data as Array<{ id: number; guid: string; delivered_at: string; status: string }>
    ).map((d) => ({
      id: d.id,
      guid: d.guid,
      deliveredAt: d.delivered_at,
      status: d.status,
    }));
  }

  /** Ask GitHub to redeliver one delivery. */
  async redeliver(deliveryId: number): Promise<void> {
    await this.asApp("POST /app/hook/deliveries/{delivery_id}/attempts", {
      delivery_id: deliveryId,
    });
  }
}

function statusOf(err: unknown): number | undefined {
  const s = (err as { status?: unknown }).status;
  return typeof s === "number" ? s : undefined;
}
