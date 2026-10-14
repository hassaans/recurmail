const encoder = new TextEncoder();

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value))
    throw new Error("Invalid encrypted token");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(
    normalized + "=".repeat((4 - (normalized.length % 4)) % 4),
  );
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeKey(encoded: string): Uint8Array {
  const bytes = decodeBase64Url(
    encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, ""),
  );
  if (bytes.length !== 32)
    throw new Error("TOKEN_ENCRYPTION_KEY must encode exactly 32 bytes");
  const standard = btoa(String.fromCharCode(...bytes));
  if (standard !== encoded)
    throw new Error("TOKEN_ENCRYPTION_KEY must be canonical base64");
  return bytes;
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.length);
  copy.set(value);
  return copy.buffer;
}

/** Decrypts the Node crypto.ts v1 AES-256-GCM envelope using WebCrypto. */
export async function decryptRefreshToken(
  envelope: string,
  encodedKey: string,
  owner: string,
): Promise<string> {
  const parts = envelope.split(".");
  if (parts.length !== 4 || parts[0] !== "v1")
    throw new Error("Invalid encrypted token");
  const iv = decodeBase64Url(parts[1]);
  const tag = decodeBase64Url(parts[2]);
  const ciphertext = decodeBase64Url(parts[3]);
  if (iv.length !== 12 || tag.length !== 16)
    throw new Error("Invalid encrypted token");

  const key = await crypto.subtle.importKey(
    "raw",
    arrayBuffer(decodeKey(encodedKey)),
    "AES-GCM",
    false,
    ["decrypt"],
  );
  const authenticated = new Uint8Array(ciphertext.length + tag.length);
  authenticated.set(ciphertext);
  authenticated.set(tag, ciphertext.length);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: arrayBuffer(iv),
      additionalData: arrayBuffer(encoder.encode(owner)),
      tagLength: 128,
    },
    key,
    arrayBuffer(authenticated),
  );
  return new TextDecoder().decode(plaintext);
}
