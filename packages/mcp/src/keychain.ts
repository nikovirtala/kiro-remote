/**
 * Token storage: an injectable {@link Keychain} interface with a 0600-permission
 * file fallback as the default implementation.
 *
 * A native OS-keychain library (e.g. keytar) requires native bindings that do
 * not build in this sandbox and are brittle across platforms, so the keychain
 * is modeled as an interface. The default {@link FileKeychain} writes the token
 * set to a single JSON file with 0600 (owner read/write only) permissions,
 * which is the documented fallback. A deployment that wants the real OS
 * keychain can supply an alternative implementation of {@link Keychain} without
 * touching any tool or CLI code.
 *
 * Nothing here is ever logged; callers hold the returned token set briefly and
 * pass it straight to the token provider. See findings for the choice rationale.
 */

import { constants as fsConstants } from "node:fs";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** The token set persisted between CLI invocations (Cognito tokens, unchanged). */
export interface StoredTokens {
  accessToken: string;
  refreshToken: string;
  /** Unix epoch seconds at which the access token expires. */
  expiresAt: number;
  /** The space-delimited granted scopes (for whoami display). */
  scope?: string;
  /** The token endpoint this set was issued from (for refresh). */
  tokenEndpoint: string;
  /** The CIMD client_id used (for refresh / revoke). */
  clientId: string;
}

/** Abstraction over where tokens live. The default is a 0600 file. */
export interface Keychain {
  get(): Promise<StoredTokens | null>;
  set(tokens: StoredTokens): Promise<void>;
  clear(): Promise<void>;
}

/** Default path for the fallback token file: ~/.config/kiro-remote/tokens.json. */
export function defaultTokenPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME && process.env.XDG_CONFIG_HOME.length > 0
      ? process.env.XDG_CONFIG_HOME
      : join(homedir(), ".config");
  return join(base, "kiro-remote", "tokens.json");
}

/**
 * The 0600 file fallback. The file (and its parent directory) are created with
 * owner-only permissions; on every write the mode is re-asserted to 0600 so a
 * pre-existing looser file is tightened.
 */
export class FileKeychain implements Keychain {
  private readonly path: string;

  constructor(path: string = defaultTokenPath()) {
    this.path = path;
  }

  /** The resolved token-file path (exposed for tests / diagnostics). */
  get filePath(): string {
    return this.path;
  }

  async get(): Promise<StoredTokens | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      return JSON.parse(raw) as StoredTokens;
    } catch {
      return null;
    }
  }

  async set(tokens: StoredTokens): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Write with the restrictive mode up front, then re-assert it to tighten
    // any pre-existing file whose mode was looser.
    await writeFile(this.path, JSON.stringify(tokens), { mode: 0o600 });
    await chmod(this.path, 0o600);
  }

  async clear(): Promise<void> {
    try {
      await access(this.path, fsConstants.F_OK);
      await writeFile(this.path, "", { mode: 0o600 });
      await chmod(this.path, 0o600);
    } catch {
      // Nothing to clear.
    }
  }
}

/** In-memory keychain for tests. */
export class MemoryKeychain implements Keychain {
  private tokens: StoredTokens | null = null;

  async get(): Promise<StoredTokens | null> {
    return this.tokens;
  }

  async set(tokens: StoredTokens): Promise<void> {
    this.tokens = tokens;
  }

  async clear(): Promise<void> {
    this.tokens = null;
  }
}
