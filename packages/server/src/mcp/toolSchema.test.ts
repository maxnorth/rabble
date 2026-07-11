import { describe, expect, it } from "vitest";
import { permissiveToolSchema } from "./toolSchema.js";

describe("permissiveToolSchema", () => {
  it("keeps properties, types, enums, and descriptions", () => {
    const out = permissiveToolSchema({
      type: "object",
      properties: {
        query: { type: "string", description: "what to search" },
        mode: { type: "string", enum: ["fast", "deep"] },
      },
    });
    expect(out.type).toBe("object");
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.query.description).toBe("what to search");
    expect(props.mode.enum).toEqual(["fast", "deep"]);
  });

  it("drops the constraints that abort a real call (the notion-search case)", () => {
    const out = permissiveToolSchema({
      type: "object",
      required: ["query"],
      additionalProperties: false,
      properties: {
        query: { type: "string", minLength: 1, pattern: "^\\S" },
        page_size: { type: "integer", minimum: 1, maximum: 100 },
        format: { type: "string", format: "uri" },
      },
    });
    expect(out.required).toBeUndefined();
    expect(out.additionalProperties).toBeUndefined();
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.query.minLength).toBeUndefined();
    expect(props.query.pattern).toBeUndefined();
    expect(props.query.type).toBe("string");
    expect(props.page_size.minimum).toBeUndefined();
    expect(props.page_size.maximum).toBeUndefined();
    expect(props.page_size.type).toBe("integer");
    // A property literally named "format" is preserved; only the format
    // KEYWORD inside a schema node is dropped.
    expect(props.format).toBeDefined();
    expect(props.format.format).toBeUndefined();
  });

  it("collapses nullable union types", () => {
    const out = permissiveToolSchema({
      type: "object",
      properties: { q: { type: ["string", "null"] } },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    expect(props.q.type).toBe("string");
  });

  it("normalizes a missing or non-object schema to an empty object schema", () => {
    expect(permissiveToolSchema(undefined)).toEqual({ type: "object", properties: {} });
    expect(permissiveToolSchema({ type: "string" })).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("recurses into nested object/array properties", () => {
    const out = permissiveToolSchema({
      type: "object",
      properties: {
        filter: {
          type: "object",
          required: ["field"],
          properties: { field: { type: "string", minLength: 2 } },
        },
        tags: { type: "array", items: { type: "string", maxLength: 5 } },
      },
    });
    const props = out.properties as Record<string, Record<string, unknown>>;
    const filter = props.filter as Record<string, unknown>;
    expect(filter.required).toBeUndefined();
    const filterProps = filter.properties as Record<string, Record<string, unknown>>;
    expect(filterProps.field.minLength).toBeUndefined();
    const tags = props.tags as Record<string, Record<string, unknown>>;
    expect((tags.items as Record<string, unknown>).maxLength).toBeUndefined();
  });
});
