export type MercadoLivreResponse = Readonly<{ status: number; json(): Promise<unknown> }>;
export type MercadoLivreClient = Readonly<{
  request(path: string, init?: RequestInit): Promise<MercadoLivreResponse>;
}>;
export const createMercadoLivreClient = (fetcher: typeof fetch = fetch): MercadoLivreClient => ({
  request: async (path, init) =>
    fetcher(new URL(path, "https://api.mercadolibre.com").toString(), init),
});
