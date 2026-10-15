import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error(
      "TOKEN_ENCRYPTION_KEY must be base64 encoding exactly 32 bytes",
    );
  }
  return key;
}

/** Versioned AES-256-GCM envelope. The owner is authenticated as additional data. */
export function encryptRefreshToken(
  token: string,
  key: string,
  owner: string,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  cipher.setAAD(Buffer.from(owner));
  const ciphertext = Buffer.concat([
    cipher.update(token, "utf8"),
    cipher.final(),
  ]);
  return [
    "v1",
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptRefreshToken(
  envelope: string,
  key: string,
  owner: string,
): string {
  const parts = envelope.split(".");
  if (
    parts.length !== 4 ||
    parts[0] !== "v1" ||
    parts.slice(1).some((part) => !/^[A-Za-z0-9_-]+$/.test(part))
  ) {
    throw new Error("Invalid encrypted token");
  }
  const [iv, tag, ciphertext] = parts
    .slice(1)
    .map((part) => Buffer.from(part, "base64url"));
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid encrypted token");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(key), iv);
  decipher.setAAD(Buffer.from(owner));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}
