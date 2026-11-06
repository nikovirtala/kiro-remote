/**
 * JSON Schema generation.
 *
 * Both the OpenAPI 3.1 document and the MCP tool input schemas are generated
 * from the SAME zod objects via zod 4's native `z.toJSONSchema`. OpenAPI 3.1
 * uses JSON Schema draft 2020-12 as its schema dialect, and MCP tool
 * `inputSchema` values are JSON Schema, so a single `draft-2020-12` emission
 * satisfies both. This keeps schema parity a structural guarantee rather than
 * a convention: {@link toOpenApiSchema} and {@link toMcpInputSchema} produce
 * identical output for the same input.
 *
 * Chosen generator: zod 4 built-in `z.toJSONSchema` (no third-party
 * zod-to-openapi dependency). Documented in the feature findings.
 */

import { z } from "zod";
import { TOOL_INPUT_SCHEMAS, type ToolName } from "./index.ts";

/** A JSON Schema object (draft 2020-12). */
export type JsonSchema = Record<string, unknown>;

/**
 * Emit a JSON Schema from a zod object for use in the OpenAPI 3.1 document.
 * OpenAPI 3.1's schema dialect is JSON Schema draft 2020-12.
 */
export function toOpenApiSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as JsonSchema;
}

/** Emit a JSON Schema from a zod object for use as an MCP tool `inputSchema`. */
export function toMcpInputSchema(schema: z.ZodType): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: "input",
    unrepresentable: "any",
  }) as JsonSchema;
}

/** Generate every registered MCP tool input schema, keyed by tool name. */
export function allMcpInputSchemas(): Record<ToolName, JsonSchema> {
  const out = {} as Record<ToolName, JsonSchema>;
  for (const name of Object.keys(TOOL_INPUT_SCHEMAS) as ToolName[]) {
    out[name] = toMcpInputSchema(TOOL_INPUT_SCHEMAS[name]);
  }
  return out;
}

/** Generate every registered OpenAPI component schema, keyed by tool name. */
export function allOpenApiSchemas(): Record<ToolName, JsonSchema> {
  const out = {} as Record<ToolName, JsonSchema>;
  for (const name of Object.keys(TOOL_INPUT_SCHEMAS) as ToolName[]) {
    out[name] = toOpenApiSchema(TOOL_INPUT_SCHEMAS[name]);
  }
  return out;
}
