/**
 * Banco Central do Brasil PTAX USD selling rate (public OData, no key). Walks back up to four days
 * to cover weekends and holidays; null when none is found, which makes a USD quote fail closed.
 */
const BASE =
  "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarDia(dataCotacao=@dataCotacao)";

export type PtaxRate = Readonly<{ brlPerUsd: number; source: string; at: Date }>;

const saoPauloDate = (at: Date) => {
  const local = new Date(at.getTime() - 3 * 60 * 60 * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}-${local.getUTCFullYear()}`;
};

export const fetchPtaxUsdBrl = async (
  now: Date,
  doFetch: typeof fetch = fetch,
): Promise<PtaxRate | null> => {
  for (let back = 0; back <= 4; back += 1) {
    const day = saoPauloDate(new Date(now.getTime() - back * 24 * 60 * 60 * 1000));
    const url = `${BASE}?@dataCotacao='${day}'&$format=json`;
    const response = await doFetch(url, {
      signal: AbortSignal.timeout(20_000),
      redirect: "error",
    }).catch(() => null);
    if (!response?.ok) return null;
    const body = (await response.json().catch(() => null)) as {
      value?: { cotacaoVenda?: unknown; dataHoraCotacao?: unknown }[];
    } | null;
    const last = body?.value?.at(-1);
    if (!last) continue;
    const rate = Number(last.cotacaoVenda);
    const at = new Date(`${String(last.dataHoraCotacao).replace(" ", "T").slice(0, 19)}-03:00`);
    if (!(rate > 1 && rate < 20) || Number.isNaN(at.getTime())) return null;
    return { brlPerUsd: rate, source: `bcb-ptax-venda:${day}`, at };
  }
  return null;
};
