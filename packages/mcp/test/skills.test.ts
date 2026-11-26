/**
 * The skills the server offers (SEP-2640), over both transports and both
 * protocol eras: skills/list, skills/get, resources/read, the refusal of an
 * unknown skill, the instructions, and the rule that any authenticated caller
 * (whatever its scopes) may list and read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { memorySkillFiles } from "@modelcontextprotocol/server/ext/skills";
import { z } from "@nikovirtala/kiro-remote-core";
import { describe, expect, it } from "vitest";
import { createHttpTransportHandler } from "../src/http-transport.ts";
import { INSTRUCTIONS, SKILL_URI } from "../src/instructions.ts";
import { loadSkillCatalog, SKILLS_CACHE_HINT } from "../src/skills.ts";
import { SKILLS_DIR } from "../src/skills-files.ts";
import { buildInProcess, modernCall, principal, type RpcAnswer, seamFetch } from "./helpers.ts";

const SKILL = "skill://kiro-remote-sessions";

function handler() {
  const { client } = buildInProcess();
  return createHttpTransportHandler({ client });
}

/** A caller with no scope at all: authenticated, nothing more. */
const nobody = principal({ scopes: [] });

describe("skills over a 2026-07-28 request", () => {
  it("skills/list names kiro-remote-sessions with a complete manifest", async () => {
    const { json } = await modernCall(handler(), nobody, "skills/list");
    const skills = json.result.skills as RpcAnswer[];
    expect(skills.map((s) => s.uri)).toEqual([`${SKILL}/SKILL.md`]);
    const skill = skills[0] as RpcAnswer;
    expect(skill.frontmatter.name).toBe("kiro-remote-sessions");
    expect(skill.frontmatter.description).toMatch(/Kiro cloud session/);
    const uris = skill.resources.map((r: { uri: string }) => r.uri);
    expect(uris).toEqual([
      `${SKILL}/SKILL.md`,
      `${SKILL}/references/cloud-sessions.md`,
      `${SKILL}/references/pull-requests.md`,
      `${SKILL}/references/turn-loop.md`,
    ]);
    for (const r of skill.resources) {
      const file = readFileSync(join(SKILLS_DIR, r.uri.slice("skill://".length)));
      expect(r.size).toBe(file.length);
      expect(r.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it("answers can be cached for 5 minutes by anyone", async () => {
    const { json } = await modernCall(handler(), nobody, "skills/list");
    expect(SKILLS_CACHE_HINT).toEqual({ ttlMs: 300000, cacheScope: "public" });
    expect(json.result).toMatchObject({ ttlMs: 300000, cacheScope: "public" });
  });

  it("skills/get returns one skill by its SKILL.md URI", async () => {
    const { json } = await modernCall(handler(), nobody, "skills/get", {
      uri: `${SKILL}/SKILL.md`,
    });
    expect(json.result.skill.frontmatter.name).toBe("kiro-remote-sessions");
    expect(json.result.skill.resources).toHaveLength(4);
  });

  it("resources/read returns SKILL.md and a reference file as served on disk", async () => {
    for (const path of ["SKILL.md", "references/turn-loop.md"]) {
      const { json } = await modernCall(handler(), nobody, "resources/read", {
        uri: `${SKILL}/${path}`,
      });
      const content = json.result.contents[0];
      expect(content.uri).toBe(`${SKILL}/${path}`);
      expect(content.mimeType).toBe("text/markdown");
      expect(content.text).toBe(
        readFileSync(join(SKILLS_DIR, "kiro-remote-sessions", path), "utf8"),
      );
    }
  });

  it("an unknown skill URI is -32602, from skills/get and from resources/read", async () => {
    const uri = "skill://not-a-skill/SKILL.md";
    for (const method of ["skills/get", "resources/read"]) {
      const { json } = await modernCall(handler(), nobody, method, { uri });
      expect(json.result).toBeUndefined();
      expect(json.error.code).toBe(-32602);
    }
  });

  it("server/discover offers the extension and the instructions", async () => {
    const { json } = await modernCall(handler(), nobody, "server/discover");
    expect(json.result.capabilities.extensions["io.modelcontextprotocol/skills"]).toBeDefined();
    expect(json.result.instructions).toBe(INSTRUCTIONS);
    expect(json.result.capabilities.resources.listChanged).toBe(false);
  });
});

describe("skills over a 2025-06-18 client (v1 SDK)", () => {
  async function connect() {
    const client = new Client({ name: "legacy-client", version: "0.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://seam.test/mcp"), {
        fetch: seamFetch(handler(), nobody),
      }),
    );
    return client;
  }

  it("initialize carries the instructions", async () => {
    const client = await connect();
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
    await client.close();
  });

  it("skills/list and a SKILL.md read work in the 2025 era too", async () => {
    const client = await connect();
    const list = await client.request(
      { method: "skills/list", params: {} },
      z.object({ skills: z.array(z.object({ uri: z.string() })) }).passthrough(),
    );
    expect(list.skills.map((s) => s.uri)).toEqual([`${SKILL}/SKILL.md`]);
    const read = await client.readResource({ uri: `${SKILL}/SKILL.md` });
    expect(JSON.stringify(read.contents[0])).toContain("kiro_launch_session");
    await client.close();
  });
});

describe("the instructions", () => {
  it("stay short and name the loop, whenBusy queue, idempotency keys and the skill URI", () => {
    expect(INSTRUCTIONS.length).toBeLessThanOrEqual(600);
    for (const needle of [
      "kiro_launch_session",
      "kiro_wait_for_events",
      "kiro_get_transcript",
      'whenBusy: "queue"',
      "idempotencyKey",
      SKILL_URI,
    ]) {
      expect(INSTRUCTIONS).toContain(needle);
    }
  });
});

describe("one catalog serves a directory of skills", () => {
  it("adding a folder adds a skill, with no code change", async () => {
    const skill = (name: string) =>
      `---\nname: ${name}\ndescription: Use when testing ${name}.\n---\n# ${name}\n`;
    const catalog = await loadSkillCatalog(
      memorySkillFiles({
        "kiro-remote-sessions/SKILL.md": skill("kiro-remote-sessions"),
        "github-wake/SKILL.md": skill("github-wake"),
        "github-wake/references/loop.md": "# loop\n",
      }),
      { strict: true },
    );
    expect(catalog.entries.map((e) => e.uri)).toEqual([
      "skill://github-wake/SKILL.md",
      "skill://kiro-remote-sessions/SKILL.md",
    ]);
  });

  it("the skills folder loads without a single warning (strict)", async () => {
    const catalog = await loadSkillCatalog(undefined, { strict: true });
    expect(catalog.entries.length).toBeGreaterThan(0);
  });
});
