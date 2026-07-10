import { describe, expect, it } from "vitest";
import { hasRight, maxRight, collectTeamAncestors } from "./rights.js";

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

describe("maxRight", () => {
  it("takes the stronger of the two, null-safe", () => {
    expect(maxRight(null, "use")).toBe("use");
    expect(maxRight("use", "edit")).toBe("edit");
    expect(maxRight("admin", "use")).toBe("admin");
    expect(maxRight("edit", "edit")).toBe("edit");
  });
});

describe("collectTeamAncestors (grants cascade down)", () => {
  // platform ⊂ engineering (parent), support is a root, ops has no parent.
  const parentOf = new Map<string, string | null>([
    ["engineering", null],
    ["platform", "engineering"],
    ["infra", "platform"],
    ["support", null],
  ]);

  it("walks a membership up to every ancestor", () => {
    // A member of infra is reached by grants on infra, platform, engineering.
    expect(new Set(collectTeamAncestors(["infra"], parentOf))).toEqual(
      new Set(["infra", "platform", "engineering"]),
    );
  });

  it("unions ancestors across multiple memberships without dupes", () => {
    const got = collectTeamAncestors(["platform", "support"], parentOf);
    expect(new Set(got)).toEqual(new Set(["platform", "engineering", "support"]));
    expect(got.length).toBe(new Set(got).size);
  });

  it("a root team reaches only itself", () => {
    expect(collectTeamAncestors(["support"], parentOf)).toEqual(["support"]);
  });

  it("terminates on a malformed parent cycle instead of looping", () => {
    const cyclic = new Map<string, string | null>([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(new Set(collectTeamAncestors(["a"], cyclic))).toEqual(new Set(["a", "b"]));
  });

  it("no memberships yields nothing", () => {
    expect(collectTeamAncestors([], parentOf)).toEqual([]);
  });
});
