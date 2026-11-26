/**
 * The logger surface the MCP package logs through. Everything it logs goes
 * through core's redact.
 */

import { redact } from "@nikovirtala/kiro-remote-core";

/** Minimal logger surface. */
export interface Logger {
  info(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
}

/** A logger that routes every message and meta object through core's redact. */
export const redactingLogger: Logger = {
  info(message, meta) {
    if (meta !== undefined) {
      console.error(redact(message), redact(meta));
    } else {
      console.error(redact(message));
    }
  },
  error(message, meta) {
    if (meta !== undefined) {
      console.error(redact(message), redact(meta));
    } else {
      console.error(redact(message));
    }
  },
};

/** A logger that drops everything (used in tests). */
export const silentLogger: Logger = { info() {}, error() {} };
