import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeUrl, makePkce } from "./oauth.js";

describe("makePkce", () => {
  it("produces a base64url S256 challenge of the verifier", () => {
    const { verifier, challenge } = makePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = createHash("sha256")
      .update(verifier)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(challenge).toBe(expected);
  });

  it("is unique per call", () => {
    expect(makePkce().verifier).not.toBe(makePkce().verifier);
  });
});

describe("authorizeUrl", () => {
  const base = {
    endpoints: {
      authorizationEndpoint: "https://as.example.com/authorize",
      tokenEndpoint: "https://as.example.com/token",
      scopes: ["read", "write"],
    },
    client: { clientId: "abc123" },
    redirectUri: "https://rabble.example/cb",
    state: "st-1",
    challenge: "chal-1",
  };

  it("carries every PKCE + code-flow parameter", () => {
    const u = new URL(authorizeUrl(base));
    expect(u.origin + u.pathname).toBe("https://as.example.com/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe("abc123");
    expect(u.searchParams.get("redirect_uri")).toBe("https://rabble.example/cb");
    expect(u.searchParams.get("state")).toBe("st-1");
    expect(u.searchParams.get("code_challenge")).toBe("chal-1");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("scope")).toBe("read write");
  });

  it("omits scope when the server advertised none", () => {
    const u = new URL(
      authorizeUrl({ ...base, endpoints: { ...base.endpoints, scopes: undefined } }),
    );
    expect(u.searchParams.has("scope")).toBe(false);
  });
});
