import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { SecretStore } from "@money-maker/core/providers/secret-store";

export interface EncryptedSecretRecordRepository {
  save(input: { reference: string; ciphertext: string }): Promise<void>;
  find(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}

const algorithm = "aes-256-gcm";

export class EncryptedSecretStore implements SecretStore {
  public constructor(
    private readonly repository: EncryptedSecretRecordRepository,
    masterKey: Buffer,
  ) {
    if (masterKey.length !== 32) throw new Error("Secret store master key must be 32 bytes.");
    this.masterKey = Buffer.from(masterKey);
  }

  private readonly masterKey: Buffer;

  public async put(input: { reference: string; secret: string }): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv(algorithm, this.masterKey, iv);
    const encrypted = Buffer.concat([cipher.update(input.secret, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    await this.repository.save({
      reference: input.reference,
      ciphertext: Buffer.concat([iv, tag, encrypted]).toString("base64url"),
    });
  }

  public async get(reference: string): Promise<string | null> {
    const stored = await this.repository.find(reference);
    if (!stored) return null;
    const encoded = Buffer.from(stored, "base64url");
    const decipher = createDecipheriv(algorithm, this.masterKey, encoded.subarray(0, 12));
    decipher.setAuthTag(encoded.subarray(12, 28));
    return Buffer.concat([decipher.update(encoded.subarray(28)), decipher.final()]).toString(
      "utf8",
    );
  }

  public delete(reference: string): Promise<void> {
    return this.repository.delete(reference);
  }
}
