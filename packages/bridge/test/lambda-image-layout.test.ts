/**
 * Keeps packages/bridge/Dockerfile.lambda and the engine path constants in
 * src/kas-engine.ts in step. The Lambda handlers spawn KAS_NODE_PATH with
 * KAS_SERVER_PATH, so the image must create exactly those paths. The expected
 * strings are derived from the constants, so changing either side alone fails
 * this test.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { KAS_NODE_PATH, KAS_ROOT, KAS_SERVER_PATH } from "../src/kas-engine.ts";

const dockerfile = readFileSync(
  fileURLToPath(new URL("../Dockerfile.lambda", import.meta.url)),
  "utf8",
);

const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const KAS_CURRENT = `${KAS_ROOT}/kas/current`;

describe("Lambda image engine layout", () => {
  test("the server path lives under kas/current", () => {
    expect(KAS_SERVER_PATH.startsWith(`${KAS_CURRENT}/`)).toBe(true);
  });

  test("the Dockerfile copies the engine's node binary to KAS_NODE_PATH", () => {
    expect(dockerfile).toMatch(
      new RegExp(`\\bcp\\b[^\\n]*\\s${reEscape(KAS_NODE_PATH)}(?:\\s|$)`, "m"),
    );
  });

  test("the Dockerfile symlinks kas/current to the unpacked release", () => {
    expect(dockerfile).toMatch(
      new RegExp(`ln\\s+-s\\s+\\S+\\s+${reEscape(KAS_CURRENT)}(?:\\s|$)`, "m"),
    );
  });

  test("the Dockerfile asserts the server entry exists at KAS_SERVER_PATH", () => {
    const relative = KAS_SERVER_PATH.slice(KAS_CURRENT.length + 1);
    expect(relative).toBe("node_modules/@kiro/agent/dist/server/acp-server.js");
    expect(dockerfile).toMatch(new RegExp(`test\\s+-f\\s+${reEscape(KAS_SERVER_PATH)}`));
  });

  test("the runtime stage ships the engine root", () => {
    expect(dockerfile).toContain(`COPY --from=kiro ${KAS_ROOT} ${KAS_ROOT}`);
  });
});

describe("Lambda image entries", () => {
  test.each(["lambda-consumer", "caps-publisher", "catch-up-durable"])(
    "the Dockerfile bundles and ships %s.cjs",
    (name) => {
      expect(dockerfile).toContain(`packages/bridge/src/${name}.ts`);
      expect(dockerfile).toContain(`--outfile=/app/dist/${name}.cjs`);
      expect(dockerfile).toContain(
        `COPY --from=deps /app/dist/${name}.cjs \${LAMBDA_TASK_ROOT}/${name}.cjs`,
      );
    },
  );
});
