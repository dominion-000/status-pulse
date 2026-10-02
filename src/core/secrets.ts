import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM for endpoint credentials (SP-02.6). Stored layout: iv (12 bytes) | auth tag (16) | ciphertext.
// GCM authenticates as well as encrypts, so a modified blob fails to decrypt instead of returning garbage.

function keyFrom(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("CREDENTIALS_ENC_KEY must be 32 bytes, base64 encoded");
  return key;
}

export function encryptSecret(plain: string, base64Key: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

export function decryptSecret(blob: Buffer, base64Key: string): string {
  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const body = blob.subarray(28);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(base64Key), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
}
