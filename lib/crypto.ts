import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

function encryptionKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("APP_ENC_KEY must contain 32 base64-encoded bytes");
  return key;
}

export function encryptRefreshToken(token: string, userId: string, encodedKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(encodedKey), iv);
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64");
}

export function decryptRefreshToken(encrypted: string, userId: string, encodedKey: string): string {
  const payload = Buffer.from(encrypted, "base64");
  if (payload.length <= 28) throw new Error("Invalid encrypted refresh token");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(encodedKey), payload.subarray(0, 12));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}
