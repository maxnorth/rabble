import { describe, expect, it } from "vitest";
import {
  decryptSecret,
  deriveEncryptionKey,
  encryptSecret,
  hashAuthToken,
  hashPassword,
  newAuthToken,
  verifyPassword,
} from "./crypto.js";

describe("password hashing", () => {
  it("verifies the right password and rejects the wrong one", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt:/);
    expect(stored).not.toContain("correct horse");
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("produces distinct hashes for the same password (salted)", () => {
    expect(hashPassword("same")).not.toEqual(hashPassword("same"));
  });

  it("rejects malformed stored values without throwing", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt:zz")).toBe(false);
  });
});

describe("secret encryption", () => {
  it("round-trips and never stores plaintext", () => {
    const secret = "sk-ant-api-key-12345";
    const stored = encryptSecret(secret);
    expect(stored).toMatch(/^v1:/);
    expect(stored).not.toContain(secret);
    expect(decryptSecret(stored)).toBe(secret);
  });

  it("uses a fresh IV per encryption", () => {
    expect(encryptSecret("same")).not.toEqual(encryptSecret("same"));
  });

  it("rejects tampered ciphertext", () => {
    const stored = encryptSecret("secret");
    const parts = stored.split(":");
    const flipped = `${parts[0]}:${parts[1]}:${parts[2]}:${parts[3]!.replace(/^./, (c) => (c === "0" ? "1" : "0"))}`;
    expect(() => decryptSecret(flipped)).toThrow();
  });

  it("rejects unknown formats", () => {
    expect(() => decryptSecret("v9:aa:bb:cc")).toThrow(/Unrecognized/);
  });
});

describe("key rotation", () => {
  it("derives a stable 32-byte key per secret, distinct across secrets", () => {
    const a1 = deriveEncryptionKey("secret-A");
    const a2 = deriveEncryptionKey("secret-A");
    expect(a1.equals(a2)).toBe(true);
    expect(a1.length).toBe(32);
    expect(deriveEncryptionKey("secret-B").equals(a1)).toBe(false);
  });

  it("only the matching key decrypts — rotation reads old data with the old key", () => {
    // Encrypt under an explicit "old" key, as a rotation would find on disk.
    const oldKey = deriveEncryptionKey("old-secret");
    const stored = encryptSecret("xoxb-rotate-me", oldKey);
    // A different secret's key can't read it (GCM auth tag protects it)…
    expect(() => decryptSecret(stored, deriveEncryptionKey("new-secret"))).toThrow();
    // …but the old key still does, which is what rotateSecret.ts relies on.
    expect(decryptSecret(stored, oldKey)).toBe("xoxb-rotate-me");
  });
});

describe("auth tokens", () => {
  it("hashes deterministically and tokens are unique", () => {
    const a = newAuthToken();
    const b = newAuthToken();
    expect(a.token).not.toEqual(b.token);
    expect(hashAuthToken(a.token)).toEqual(a.tokenHash);
    expect(a.tokenHash).not.toContain(a.token);
  });
});
