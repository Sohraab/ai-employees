/**
 * Encrypts secrets (Slack tokens, signing secrets) before they go into the
 * database, with AES-256-GCM. The key comes from SECRETS_KEY: 32 random bytes,
 * base64-encoded. Generate one with:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
 * Losing the key means reconnecting every Slack app, so keep it in your secret manager.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface SecretBox {
  encrypt(plain: string): string;
  decrypt(sealed: string): string;
}

const VERSION = "v1";

export function secretBox(base64Key: string): SecretBox {
  const key = Buffer.from(base64Key, "base64");
  if (key.length !== 32) throw new Error("SECRETS_KEY must be 32 bytes, base64-encoded");

  return {
    encrypt(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
      return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
    },
    decrypt(sealed) {
      const [version, iv, tag, ct] = sealed.split(":");
      if (version !== VERSION || !iv || !tag || !ct) throw new Error("Unrecognized secret format");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
    },
  };
}

export function secretBoxFromEnv(env = process.env): SecretBox {
  const key = env.SECRETS_KEY;
  if (!key) throw new Error("SECRETS_KEY is not set (needed to store Slack credentials)");
  return secretBox(key);
}
