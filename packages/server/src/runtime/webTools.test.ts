import { describe, expect, it } from "vitest";
import type { agents } from "../db/schema.js";
import {
  buildWebTools,
  hostMatchesAllowlist,
  parseAllowlist,
  refusalFor,
} from "./webTools.js";

const agentWith = (capabilities: Record<string, unknown>) =>
  ({ id: "a", name: "Fetcher", capabilities }) as unknown as typeof agents.$inferSelect;

describe("buildWebTools", () => {
  it("offers no tool when outboundWebAccess is off", () => {
    expect(buildWebTools(agentWith({}), () => {})).toHaveLength(0);
    expect(
      buildWebTools(agentWith({ outboundWebAccess: false, networkAllowlist: "x.com" }), () => {}),
    ).toHaveLength(0);
  });

  it("offers a single fetch_url tool when the capability is on", () => {
    const tools = buildWebTools(
      agentWith({ outboundWebAccess: true, networkAllowlist: "x.com" }),
      () => {},
    );
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("fetch_url");
  });
});

describe("parseAllowlist", () => {
  it("splits on commas and whitespace, lowercases, drops blanks", () => {
    expect(parseAllowlist("A.com, b.com\n *.C.com  ,,")).toEqual([
      "a.com",
      "b.com",
      "*.c.com",
    ]);
    expect(parseAllowlist("")).toEqual([]);
    expect(parseAllowlist("   ")).toEqual([]);
  });
});

describe("hostMatchesAllowlist", () => {
  const patterns = ["api.example.com", "*.internal.acme.com"];

  it("matches an exact host", () => {
    expect(hostMatchesAllowlist("api.example.com", patterns)).toBe(true);
    expect(hostMatchesAllowlist("API.EXAMPLE.COM", patterns)).toBe(true);
  });

  it("matches proper subdomains of a wildcard but not the apex", () => {
    expect(hostMatchesAllowlist("db.internal.acme.com", patterns)).toBe(true);
    expect(hostMatchesAllowlist("a.b.internal.acme.com", patterns)).toBe(true);
    // apex is NOT matched by *.internal.acme.com
    expect(hostMatchesAllowlist("internal.acme.com", patterns)).toBe(false);
  });

  it("does not match on a substring or lookalike host", () => {
    expect(hostMatchesAllowlist("evil-example.com", ["example.com"])).toBe(false);
    expect(hostMatchesAllowlist("api.example.com.evil.com", patterns)).toBe(false);
    expect(hostMatchesAllowlist("notapi.example.com", patterns)).toBe(false);
  });

  it("never matches against an empty allowlist", () => {
    expect(hostMatchesAllowlist("anything.com", [])).toBe(false);
  });
});

describe("refusalFor", () => {
  const patterns = ["data.example.com"];

  it("passes an allowlisted https URL", () => {
    expect(refusalFor("https://data.example.com/path?q=1", patterns)).toBeNull();
  });

  it("fails closed on an empty allowlist even for a valid URL", () => {
    expect(refusalFor("https://data.example.com/", [])).toMatch(/no network allowlist/i);
  });

  it("refuses a host outside the allowlist", () => {
    expect(refusalFor("https://other.com/", patterns)).toMatch(/not in this agent/i);
  });

  it("refuses non-http(s) schemes", () => {
    expect(refusalFor("file:///etc/passwd", patterns)).toMatch(/only http/i);
    expect(refusalFor("ftp://data.example.com/", patterns)).toMatch(/only http/i);
  });

  it("refuses a malformed URL", () => {
    expect(refusalFor("not a url", patterns)).toMatch(/not a valid URL/i);
  });
});
