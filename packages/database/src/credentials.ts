import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * Mail credentials (OAuth tokens, IMAP passwords) are stored encrypted with AES-256-GCM.
 * The key comes from CREDENTIALS_ENCRYPTION_KEY (32 bytes, base64) and never leaves the server.
 */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, "base64");
    if (key.length !== 32) {
      throw new Error("CREDENTIALS_ENCRYPTION_KEY must be 32 bytes encoded as base64");
    }
    this.key = key;
  }

  encrypt(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = Buffer.from(JSON.stringify(value), "utf8");
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ["v1", iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(".");
  }

  decrypt<T>(payload: string): T {
    const [version, ivB64, tagB64, dataB64] = payload.split(".");
    if (version !== "v1" || !ivB64 || !tagB64 || !dataB64) {
      throw new Error("Unsupported credential payload");
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivB64, "base64"));
    decipher.setAuthTag(Buffer.from(tagB64, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8")) as T;
  }
}

export type StoredCredentials =
  | { kind: "imap"; password: string }
  | {
      kind: "oauth";
      accessToken: string;
      refreshToken: string | null;
      expiresAt: string | null;
      scope: string | null;
    };
