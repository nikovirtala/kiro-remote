/**
 * The /mcp handler served on a local port, the way the API serves it: the
 * request becomes the seam's {principal, method, headers (lower-cased), body}
 * and the answer is written from its {status, headers, body}. There is no
 * sign-in here; every request is from a caller that holds every scope.
 */

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHttpTransportHandler } from "../src/http-transport.ts";
import { buildInProcess, principal } from "./helpers.ts";

export async function startLocalHttp(): Promise<{ url: string; close(): Promise<void> }> {
  const handler = createHttpTransportHandler({ client: buildInProcess().client });
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      if (req.url !== "/mcp") {
        res.writeHead(404).end();
        return;
      }
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === "string") {
          headers[k.toLowerCase()] = v;
        }
      }
      const body = Buffer.concat(chunks).toString("utf8");
      const out = await handler.handle({
        principal: principal(),
        method: req.method ?? "GET",
        headers,
        ...(body ? { body } : {}),
      });
      res.writeHead(out.status, out.headers).end(out.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Run as a script (`node test/local-http.ts`) to serve /mcp until stopped. */
if (import.meta.main) {
  const { url } = await startLocalHttp();
  console.log(url);
}
