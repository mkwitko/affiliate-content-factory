export interface SecretStore {
  put(input: { reference: string; secret: string }): Promise<void>;
  get(reference: string): Promise<string | null>;
  delete(reference: string): Promise<void>;
}
