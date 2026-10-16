import type { DatabaseClient } from "./client.js";
import type { EncryptedSecretRecordRepository } from "../secrets/encrypted-secret-store.js";

export class PrismaSecretRecordRepository implements EncryptedSecretRecordRepository {
  public constructor(
    private readonly client: DatabaseClient,
    private readonly workspaceId: string,
  ) {}

  public async save(input: { reference: string; ciphertext: string }): Promise<void> {
    await this.client.secretRecord.upsert({
      where: { reference: input.reference },
      create: {
        reference: input.reference,
        ciphertext: input.ciphertext,
        workspaceId: this.workspaceId,
      },
      update: { ciphertext: input.ciphertext },
    });
  }

  public async find(reference: string): Promise<string | null> {
    const record = await this.client.secretRecord.findFirst({
      where: { reference, workspaceId: this.workspaceId },
      select: { ciphertext: true },
    });
    return record?.ciphertext ?? null;
  }

  public async delete(reference: string): Promise<void> {
    await this.client.secretRecord.deleteMany({
      where: { reference, workspaceId: this.workspaceId },
    });
  }
}
