/**
 * The rule "a skill only names what exists", over every skill folder in
 * `skills/` (not just one): each `kiro_*` tool a skill file names is a tool in
 * tools.ts, each `whenBusy` value it names is in the schema of kiro_send_prompt,
 * each relative link resolves to a file in the same skill, the frontmatter name
 * is the folder name, and nothing deployment-specific is in the text.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES, toolListEntries } from "../src/tools.ts";

/** The skills folder: one folder per skill. */
const SKILLS_DIR = fileURLToPath(new URL("../skills", import.meta.url));

/** Every file under `dir`, as paths relative to it. */
function filesUnder(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => relative(dir, join(e.parentPath, e.name)));
}

const skillFolders = readdirSync(SKILLS_DIR).filter((n) =>
  statSync(join(SKILLS_DIR, n)).isDirectory(),
);

const files = skillFolders.flatMap((skill) =>
  filesUnder(join(SKILLS_DIR, skill)).map((path) => ({
    skill,
    path,
    text: readFileSync(join(SKILLS_DIR, skill, path), "utf8"),
  })),
);

/** Every `const` and `enum` value in a JSON schema, at any depth. */
function allowedValues(schema: unknown): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap(allowedValues);
  }
  if (typeof schema !== "object" || schema === null) {
    return [];
  }
  const out: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === "const" && typeof value === "string") {
      out.push(value);
    } else if (key === "enum" && Array.isArray(value)) {
      out.push(...value.filter((v): v is string => typeof v === "string"));
    } else {
      out.push(...allowedValues(value));
    }
  }
  return out;
}

describe("the skills folder", () => {
  it("holds at least one skill, each with a SKILL.md", () => {
    expect(skillFolders.length).toBeGreaterThan(0);
    for (const skill of skillFolders) {
      expect(existsSync(join(SKILLS_DIR, skill, "SKILL.md"))).toBe(true);
    }
  });

  it.each(skillFolders)(
    "%s: frontmatter name is the folder name and says when to use it",
    (skill) => {
      const text = readFileSync(join(SKILLS_DIR, skill, "SKILL.md"), "utf8");
      // A formatter that adds a blank line after the opening fence breaks strict parsers.
      expect(text.startsWith("---\nname: ")).toBe(true);
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      expect(/^name: (.+)$/m.exec(front)?.[1]).toBe(skill);
      const description = /^description: (.+)$/m.exec(front)?.[1] ?? "";
      expect(description.length).toBeGreaterThan(40);
      expect(description).toMatch(/\bUse when\b/);
    },
  );
});

describe("a skill only names what exists", () => {
  it("every kiro_* tool a skill file names is in tools.ts", () => {
    const known = new Set(TOOL_NAMES);
    const named = files.flatMap((f) =>
      [...f.text.matchAll(/\bkiro_[a-z][a-z_]*[a-z]\b/g)].map((m) => ({
        at: `${f.skill}/${f.path}`,
        tool: m[0],
      })),
    );
    expect(named.length).toBeGreaterThan(0);
    // `kiro_*` is the glob the description uses for "the tools of this server".
    const unknown = named.filter((n) => !known.has(n.tool));
    expect(unknown).toEqual([]);
  });

  it("every whenBusy value a skill file names is in the tool's schema", () => {
    const send = toolListEntries().find((t) => t.name === "kiro_send_prompt");
    const allowed = new Set(allowedValues(send?.inputSchema.properties?.whenBusy));
    expect([...allowed].sort()).toEqual(["queue", "reject", "steer"]);

    const named = files.flatMap((f) =>
      [...f.text.matchAll(/whenBusy`?\s*[:=]?\s*`?"?([A-Za-z]+)"?/g)].map((m) => ({
        at: `${f.skill}/${f.path}`,
        value: m[1],
      })),
    );
    expect(named.length).toBeGreaterThan(0);
    expect(named.filter((n) => !allowed.has(n.value ?? ""))).toEqual([]);
  });

  it("every argument a skill puts in braces after a tool name is in that tool's schema", () => {
    const schemas = new Map(
      toolListEntries().map((t) => [t.name, Object.keys(t.inputSchema.properties ?? {})]),
    );
    const bad: string[] = [];
    for (const f of files) {
      for (const m of f.text.matchAll(/\b(kiro_[a-z_]+)\s*\{([^}]*)\}/g)) {
        const props = schemas.get(m[1] ?? "");
        if (!props) {
          continue;
        }
        for (const arg of (m[2] ?? "").split(",")) {
          const name = /^\s*([A-Za-z]+)\??\s*(?::|$)/.exec(arg)?.[1];
          if (name && !props.includes(name)) {
            bad.push(`${f.skill}/${f.path}: ${m[1]} has no argument ${name}`);
          }
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it("every relative link resolves to a file of the same skill", () => {
    for (const f of files.filter((x) => x.path.endsWith(".md"))) {
      for (const m of f.text.matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
        const target = m[1] ?? "";
        expect(target, `${f.skill}/${f.path}`).not.toMatch(/^[a-z]+:/i);
        const resolved = join(SKILLS_DIR, f.skill, dirname(f.path), target);
        expect(existsSync(resolved), `${f.skill}/${f.path} links ${target}`).toBe(true);
      }
    }
  });

  it("holds no hostname, URL, account id or e-mail address", () => {
    for (const f of files) {
      expect(f.text, `${f.skill}/${f.path}`).not.toMatch(/https?:\/\//);
      expect(f.text, `${f.skill}/${f.path}`).not.toMatch(/\b\d{12}\b/);
      expect(f.text, `${f.skill}/${f.path}`).not.toMatch(/@[A-Za-z0-9-]+\.[a-z]{2,}/);
      expect(f.text, `${f.skill}/${f.path}`).not.toMatch(
        /\b[a-z0-9-]+\.(com|net|org|dev|io|aws)\b/i,
      );
    }
  });
});
