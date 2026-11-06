import { describe, expect, it } from "vitest";
import {
  allMcpInputSchemas,
  allOpenApiSchemas,
  LaunchSessionSchema,
  TOOL_INPUT_SCHEMAS,
  toMcpInputSchema,
  toOpenApiSchema,
} from "../src/index.ts";

describe("schema parity: OpenAPI and MCP schemas derive from the same zod objects", () => {
  it("produces identical JSON Schema for a single schema", () => {
    const openapi = toOpenApiSchema(LaunchSessionSchema);
    const mcp = toMcpInputSchema(LaunchSessionSchema);
    expect(mcp).toEqual(openapi);
  });

  it("produces identical schemas for EVERY registered tool input", () => {
    const openapi = allOpenApiSchemas();
    const mcp = allMcpInputSchemas();
    expect(Object.keys(mcp).sort()).toEqual(Object.keys(openapi).sort());
    for (const name of Object.keys(TOOL_INPUT_SCHEMAS) as (keyof typeof TOOL_INPUT_SCHEMAS)[]) {
      expect(mcp[name], `parity for ${name}`).toEqual(openapi[name]);
    }
  });

  it("the generated schema actually reflects the zod object (launchSession)", () => {
    const schema = toOpenApiSchema(LaunchSessionSchema);
    expect(schema.type).toBe("object");
    const props = schema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(
      expect.arrayContaining(["prompt", "repos", "title", "mode", "model", "effort"]),
    );
    expect(schema.required).toEqual(expect.arrayContaining(["prompt", "repos"]));
  });
});
