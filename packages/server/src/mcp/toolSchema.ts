/**
 * An MCP server's inputSchema is advertised to the model so it can call the
 * tool well, but the SERVER is the authority on what's valid — not our client
 * wrapper. LangChain validates the model's arguments against the tool schema
 * before our handler runs and ABORTS the turn on a mismatch, so a real-world
 * schema constraint (a search tool's `minLength` on `query`, a `format`, a
 * `pattern`) rejects a reasonable call the server would have accepted.
 *
 * This strips the validation-only keywords, leaving shape (types, properties,
 * enums, descriptions) intact for the model while letting any reasonably
 * shaped input through to the server, which returns a real error the model
 * can react to instead of the turn dying.
 */

// Keywords that only constrain (not describe) — dropped so client validation
// never rejects input the MCP server itself would accept.
const CONSTRAINT_KEYWORDS = new Set([
  "required",
  "additionalProperties",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
  "pattern",
  "format",
  "multipleOf",
  "$schema",
]);

// Sanitize a schema NODE. Crucially schema-aware: keys inside `properties`
// are parameter NAMES (a tool may have a param literally named "format" or
// "pattern"), so we recurse into their VALUES as schemas but never filter the
// names themselves. Constraint keywords are only stripped where they're
// schema keywords.
function sanitizeSchema(node: unknown): unknown {
  if (!node || typeof node !== "object" || Array.isArray(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (CONSTRAINT_KEYWORDS.has(key)) continue;
    if (key === "type" && Array.isArray(value)) {
      // Collapse ["string","null"] to the first real type — some validators
      // choke on the array form.
      const real = (value as unknown[]).find((t) => t !== "null");
      out.type = real ?? (value as unknown[])[0];
    } else if (key === "properties" && value && typeof value === "object") {
      const props: Record<string, unknown> = {};
      for (const [name, sub] of Object.entries(value)) props[name] = sanitizeSchema(sub);
      out.properties = props;
    } else if (key === "items") {
      out.items = Array.isArray(value) ? value.map(sanitizeSchema) : sanitizeSchema(value);
    } else if (
      (key === "oneOf" || key === "anyOf" || key === "allOf") &&
      Array.isArray(value)
    ) {
      out[key] = value.map(sanitizeSchema);
    } else {
      // Descriptive keywords (description, enum, title, default…) kept verbatim.
      out[key] = value;
    }
  }
  return out;
}

/** A permissive-but-descriptive tool schema: shape kept, constraints dropped,
 * always a top-level object (what LangChain's tool() expects). */
export function permissiveToolSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!schema || typeof schema !== "object") {
    return { type: "object", properties: {} };
  }
  const clean = sanitizeSchema(schema) as Record<string, unknown>;
  if (clean.type !== "object") {
    return { type: "object", properties: clean.properties ?? {} };
  }
  if (!clean.properties) clean.properties = {};
  return clean;
}
