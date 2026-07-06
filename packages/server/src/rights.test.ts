import { describe, expect, it } from "vitest";
import { hasRight } from "./rights.js";

describe("hasRight (right ordering)", () => {
  it("orders use < edit < admin", () => {
    expect(hasRight("use", "use")).toBe(true);
    expect(hasRight("use", "edit")).toBe(false);
    expect(hasRight("use", "admin")).toBe(false);
    expect(hasRight("edit", "use")).toBe(true);
    expect(hasRight("edit", "edit")).toBe(true);
    expect(hasRight("edit", "admin")).toBe(false);
    expect(hasRight("admin", "use")).toBe(true);
    expect(hasRight("admin", "edit")).toBe(true);
    expect(hasRight("admin", "admin")).toBe(true);
  });

  it("null means no access at any level", () => {
    expect(hasRight(null, "use")).toBe(false);
    expect(hasRight(null, "edit")).toBe(false);
    expect(hasRight(null, "admin")).toBe(false);
  });
});
