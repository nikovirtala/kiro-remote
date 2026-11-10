/**
 * Shared ACP types and the capability model. The bridge drives the engine over
 * ACP; core only defines the data shapes (and, in capabilities.ts, the
 * normalized view of the initialize result) so the API and the bridge agree on
 * them without pulling in process/transport code.
 */

/** Client-owned session inputs, sent on session/new and re-sent on session/load. */
export interface SessionInputs {
  cwd: string;
  additionalDirectories?: string[];
  mcpServers?: unknown[];
  modeId?: string;
  modelId?: string;
  effortLevel?: string;
  /**
   * Target GitHub repositories for a cloud execution target. The bridge sends
   * them on session/new under `_meta.kiro.repositories` with the cloud-sandbox
   * execution target.
   */
  repos?: string[];
}

export * from "./capabilities.ts";
