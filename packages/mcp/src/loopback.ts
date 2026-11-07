/**
 * The production {@link AuthorizationRoundtrip}: start a loopback HTTP server on
 * an ephemeral port, open the authorization URL in the user's browser, and
 * resolve with the authorization `code` once the facade redirects back to
 * http://127.0.0.1:<port>/callback.
 *
 * The browser-open is injected (defaults to the OS opener) so this stays
 * testable, and the authorization URL is NEVER printed or logged.
 */

import { exec } from "node:child_process";
import { createServer } from "node:http";
import { platform } from "node:os";
import type { AuthorizationRoundtrip } from "./oauth.ts";

/** Opens a URL in the default browser. Injected so tests never spawn one. */
export type UrlOpener = (url: string) => void;

/** Default OS browser opener (never logs the URL). */
export const defaultOpener: UrlOpener = (url: string): void => {
  const cmd = platform() === "darwin" ? "open" : platform() === "win32" ? "start" : "xdg-open";
  // Pass the URL as a single argument; swallow errors (the user may open it
  // manually). The URL is never written to any log.
  exec(`${cmd} "${url.replace(/"/g, "%22")}"`, () => {});
};

export interface LoopbackDeps {
  open?: UrlOpener;
  /** Max milliseconds to wait for the browser callback before failing. */
  timeoutMs?: number;
}

/** Build the loopback {@link AuthorizationRoundtrip}. */
export function createLoopbackRoundtrip(deps: LoopbackDeps = {}): AuthorizationRoundtrip {
  const open = deps.open ?? defaultOpener;
  const timeoutMs = deps.timeoutMs ?? 5 * 60 * 1000;

  return ({ authorizeUrl, state }) =>
    new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://127.0.0.1");
        if (url.pathname !== "/callback") {
          res.statusCode = 404;
          res.end("not found");
          return;
        }
        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");
        const ok = Boolean(code) && returnedState === state;
        res.statusCode = ok ? 200 : 400;
        res.setHeader("content-type", "text/plain");
        res.end(
          ok
            ? "kiro-remote login complete. You can close this window."
            : "kiro-remote login failed. You can close this window.",
        );
        server.close();
        clearTimeout(timer);
        if (ok && code) {
          const addr = server.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          resolve({ code, redirectUri: `http://127.0.0.1:${port}/callback` });
        } else {
          reject(new Error("loopback callback did not carry a valid code/state"));
        }
      });

      const timer = setTimeout(() => {
        server.close();
        reject(new Error("timed out waiting for the browser authorization callback"));
      }, timeoutMs);

      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        const redirectUri = `http://127.0.0.1:${port}/callback`;
        // Open the browser; the URL is never logged.
        open(authorizeUrl(redirectUri));
      });

      server.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
}
