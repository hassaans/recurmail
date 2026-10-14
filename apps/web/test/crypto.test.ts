import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptRefreshToken, encryptRefreshToken } from "../lib/crypto";

const key = randomBytes(32).toString("base64");
const token = "fake-refresh-token-for-tests";

describe("server refresh-token encryption", () => {
  it("round-trips with AES-256-GCM and binds the ciphertext to its owner", () => {
    const encrypted = encryptRefreshToken(token, key, "user-a");
    expect(encrypted).not.toContain(token);
    expect(decryptRefreshToken(encrypted, key, "user-a")).toBe(token);
    expect(() => decryptRefreshToken(encrypted, key, "user-b")).toThrow();
  });

  it("uses a fresh 96-bit IV for every encryption", () => {
    const first = encryptRefreshToken(token, key, "user-a");
    const second = encryptRefreshToken(token, key, "user-a");
    expect(first).not.toBe(second);
    expect(first.split(".")[1]).not.toBe(second.split(".")[1]);
    expect(Buffer.from(first.split(".")[1], "base64url")).toHaveLength(12);
  });

  it("rejects a tampered authentication tag", () => {
    const parts = encryptRefreshToken(token, key, "user-a").split(".");
    const tag = Buffer.from(parts[2], "base64url");
    tag[0] ^= 1;
    parts[2] = tag.toString("base64url");
    expect(() => decryptRefreshToken(parts.join("."), key, "user-a")).toThrow();
  });

  it("rejects the wrong key", () => {
    const encrypted = encryptRefreshToken(token, key, "user-a");
    expect(() =>
      decryptRefreshToken(
        encrypted,
        randomBytes(32).toString("base64"),
        "user-a",
      ),
    ).toThrow();
  });

  it.each([
    "",
    "bad-key",
    randomBytes(16).toString("base64"),
    randomBytes(33).toString("base64"),
  ])("rejects invalid keys without echoing them", (badKey) => {
    expect(() => encryptRefreshToken(token, badKey, "user-a")).toThrow(
      "TOKEN_ENCRYPTION_KEY must be base64 encoding exactly 32 bytes",
    );
  });

  it.each(["", "v0.a.b.c", "v1.a.b.c", "v1.a.b.c.extra"])(
    "rejects malformed ciphertext",
    (ciphertext) => {
      expect(() => decryptRefreshToken(ciphertext, key, "user-a")).toThrow();
    },
  );
});
