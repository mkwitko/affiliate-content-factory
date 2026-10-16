import { describe, expect, it } from "vitest";
import {
  EncryptedSecretStore,
  type EncryptedSecretRecordRepository,
} from "./encrypted-secret-store.js";

const repository = (): EncryptedSecretRecordRepository & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    save: async ({ reference, ciphertext }) => void values.set(reference, ciphertext),
    find: async (reference) => values.get(reference) ?? null,
    delete: async (reference) => void values.delete(reference),
  };
};

describe("EncryptedSecretStore", () => {
  it("round-trips a secret without storing plaintext", async () => {
    const records = repository();
    const store = new EncryptedSecretStore(records, Buffer.alloc(32, 7));
    await store.put({ reference: "secret://workspace/pfm", secret: "real-api-key" });
    expect(records.values.get("secret://workspace/pfm")).not.toContain("real-api-key");
    await expect(store.get("secret://workspace/pfm")).resolves.toBe("real-api-key");
  });

  it("returns null for an unknown reference", async () => {
    const store = new EncryptedSecretStore(repository(), Buffer.alloc(32, 7));
    await expect(store.get("secret://missing")).resolves.toBeNull();
  });
});
