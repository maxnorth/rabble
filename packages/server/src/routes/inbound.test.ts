import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "./inbound.js";

function sign(secret: string, timestamp: string, body: string): string {
  return `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex")}`;
}

describe("verifySlackSignature", () => {
  const secret = "test-signing-secret";
  const ts = "1712345678";
  const body = JSON.stringify({ type: "event_callback", event: { text: "hi" } });

  it("accepts Slack's v0 HMAC over timestamp and raw body", () => {
    expect(verifySlackSignature(secret, ts, body, sign(secret, ts, body))).toBe(true);
  });

  it("rejects a tampered body", () => {
    expect(
      verifySlackSignature(secret, ts, body.replace("hi", "rm -rf"), sign(secret, ts, body)),
    ).toBe(false);
  });

  it("rejects a replayed signature under a different timestamp", () => {
    expect(verifySlackSignature(secret, "1712349999", body, sign(secret, ts, body))).toBe(false);
  });

  it("rejects the wrong secret and malformed signatures without throwing", () => {
    expect(verifySlackSignature("other-secret", ts, body, sign(secret, ts, body))).toBe(false);
    expect(verifySlackSignature(secret, ts, body, "v0=nothex")).toBe(false);
    expect(verifySlackSignature(secret, ts, body, "")).toBe(false);
  });
});
