import type { JsonSchema } from "./types";

type Schema = Record<string, unknown>;

/** Flattened schemas by original, so a turn's tool definitions are flattened once rather than on every step. */
const flattened = new WeakMap<JsonSchema, JsonSchema>();

/**
 * Makes a tool schema safe for runtimes that silently drop tools with `$ref`/`anyOf` (Ollama):
 * inlines `$ref`s from `$defs`/`definitions`, turns `anyOf`/`oneOf` of "X or null" into X, picks the first
 * option of other unions, merges `allOf`, and removes keys those runtimes don't understand.
 */
export function flattenSchema(schema: JsonSchema): JsonSchema {
  const cached = flattened.get(schema);
  if (cached) return cached;
  const defs = { ...(schema.$defs as Schema | undefined), ...(schema.definitions as Schema | undefined) };
  const out = walk(schema, defs, 0) as JsonSchema;
  flattened.set(schema, out);
  return out;
}

/** How many `$ref`/union/`allOf` layers one node may unwrap before giving up (refs can point at each other). */
const MAX_UNWRAP = 12;

/**
 * Unwraps the top of one node until it is plain: a `$ref` may lead to a union, and picking a union's option may
 * lead to another `$ref` (`{anyOf: [{$ref}, {type: "null"}]}`), so this repeats until nothing changes.
 */
function resolve(node: Schema, defs: Schema, depth = 0): Schema {
  let schema = node;
  for (let round = 0; round < MAX_UNWRAP && depth < MAX_UNWRAP; round++) {
    if (typeof schema.$ref === "string") {
      const name = schema.$ref.split("/").at(-1) ?? "";
      const target = defs[name];
      const { $ref: _ref, ...rest } = schema;
      schema = {
        ...(target && typeof target === "object" ? (target as Schema) : { type: "object" }),
        ...rest,
      };
      continue;
    }
    const union = Array.isArray(schema.anyOf) ? "anyOf" : Array.isArray(schema.oneOf) ? "oneOf" : null;
    if (union) {
      const real = (schema[union] as unknown[]).filter((option) => (option as Schema)?.type !== "null");
      const { [union]: _union, ...rest } = schema;
      schema = { ...((real[0] ?? { type: "string" }) as Schema), ...rest };
      continue;
    }
    if (Array.isArray(schema.allOf)) {
      // Every part must hold, so combine them: properties and required lists add up, other keys go first-come.
      const { allOf, ...rest } = schema;
      const merged: Schema = {};
      const parts = (allOf as unknown[]).map((item) =>
        item && typeof item === "object" ? resolve(item as Schema, defs, depth + 1) : {},
      );
      for (const part of [...parts, rest]) {
        for (const [key, value] of Object.entries(part)) {
          if (key === "properties" && merged.properties) {
            merged.properties = { ...(merged.properties as Schema), ...(value as Schema) };
          } else if (key === "required" && Array.isArray(merged.required) && Array.isArray(value)) {
            merged.required = [...new Set([...merged.required, ...value])];
          } else if (key === "description" || !(key in merged)) {
            merged[key] = value;
          }
        }
      }
      schema = merged;
      continue;
    }
    return schema;
  }
  // Refs that never bottom out: settle for an open object rather than a dangling reference.
  const { $ref: _ref, anyOf: _any, oneOf: _one, allOf: _all, ...rest } = schema;
  return { type: "object", ...rest };
}

function walk(node: unknown, defs: Schema, depth: number): unknown {
  if (Array.isArray(node)) return node.map((item) => walk(item, defs, depth));
  if (!node || typeof node !== "object") return node;
  if (depth > 12) return { type: "object" };
  let schema = resolve(node as Schema, defs);

  if (Array.isArray(schema.type)) {
    const type = (schema.type as string[]).find((t) => t !== "null") ?? "string";
    schema = { ...schema, type };
  }

  const out: Schema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === "$defs" || key === "definitions" || key === "$schema" || key === "$id") continue;
    if (key === "properties" && value && typeof value === "object") {
      out.properties = Object.fromEntries(
        Object.entries(value as Schema).map(([name, prop]) => [name, walk(prop, defs, depth + 1)]),
      );
    } else if (key === "items" || key === "additionalProperties") {
      out[key] = typeof value === "object" ? walk(value, defs, depth + 1) : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}
