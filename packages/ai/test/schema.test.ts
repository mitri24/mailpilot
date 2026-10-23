import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { describe, expect, it } from "vitest";
import { WireOutput } from "../src/index.js";

// Offline check against the documented structured-output limits: every object closed and fully
// required, no length or numeric constraints, no recursion.
const UNSUPPORTED = ["minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minItems", "maxItems", "pattern"];

function walk(node: unknown, path: string, problems: string[]) {
  if (Array.isArray(node)) return node.forEach((n, i) => walk(n, `${path}[${i}]`, problems));
  if (!node || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;
  for (const key of UNSUPPORTED) if (key in obj) problems.push(`${path}: ${key}`);
  if (obj.type === "object") {
    if (obj.additionalProperties !== false) problems.push(`${path}: additionalProperties`);
    const props = Object.keys((obj.properties as object) ?? {});
    const required = (obj.required as string[]) ?? [];
    for (const p of props) if (!required.includes(p)) problems.push(`${path}.${p}: not required`);
  }
  for (const [k, v] of Object.entries(obj)) walk(v, `${path}.${k}`, problems);
}

describe("structured output schema", () => {
  it("stays within the documented JSON schema subset", () => {
    const format = betaZodOutputFormat(WireOutput);
    expect(format.type).toBe("json_schema");
    const problems: string[] = [];
    walk(format.schema, "$", problems);
    expect(problems).toEqual([]);
  });
});
