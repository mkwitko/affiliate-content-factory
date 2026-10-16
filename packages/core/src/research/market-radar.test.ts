import { describe, expect, it } from "vitest";
import { buildMarketRadar } from "./market-radar.js";

const at = new Date("2026-10-01T12:00:00.000Z");
const trends = [
  { keyword: "sérum facial", url: "https://www.mercadolivre.com.br/s?search=serum" },
  { keyword: "creme hidratante", url: "https://www.mercadolivre.com.br/s?search=creme" },
  { keyword: "sérum facial", url: "https://www.mercadolivre.com.br/s?search=serum" },
];

describe("buildMarketRadar", () => {
  it("deduplicates terms and groups matching source evidence without combining units", () => {
    const result = buildMarketRadar({
      trends,
      youtube: [
        {
          query: "sérum facial",
          videos: [
            {
              videoId: "abcdefghijk",
              title: "Como usar sérum facial",
              url: "https://www.youtube.com/watch?v=abcdefghijk",
              publishedAt: "2026-09-25T00:00:00Z",
              viewCount: 1200,
            },
          ],
        },
      ],
      observedAt: at,
    });

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      keyword: "sérum facial",
      rank: 1,
      sourceCount: 2,
      demandValidated: false,
      growth7d: null,
      evidence: [
        { source: "mercado_livre_trends", value: "rank:1" },
        { source: "youtube_recent_video", value: "views:1200" },
      ],
    });
    expect(result[1]).toMatchObject({
      keyword: "creme hidratante",
      sourceCount: 1,
      confidence: "low",
      missingSources: ["youtube_recent_video"],
    });
  });

  it("does not match unrelated video titles or unsafe evidence URLs", () => {
    const result = buildMarketRadar({
      trends: [{ keyword: "protetor solar", url: "https://evilmercadolivre.com.br/protetor" }],
      youtube: [
        {
          query: "protetor solar",
          videos: [
            {
              videoId: "abcdefghijk",
              title: "Maquiagem para festa",
              url: "https://www.youtube.com/watch?v=abcdefghijk",
              publishedAt: "2026-09-25T00:00:00Z",
              viewCount: 900,
            },
          ],
        },
      ],
      observedAt: at,
    });

    expect(result[0]).toMatchObject({ sourceCount: 1, confidence: "low" });
    expect(result[0]?.evidence).toHaveLength(1);
    expect(result[0]?.evidence[0]?.sourceUrl).toBeNull();
  });

  it("ignores video evidence older than 30 days and maps only the documented 50-item rank groups", () => {
    const result = buildMarketRadar({
      trends: Array.from({ length: 50 }, (_, index) => ({
        keyword: `produto ${index + 1}`,
        url: `https://lista.mercadolivre.com.br/produto-${index + 1}`,
      })),
      youtube: [
        {
          query: "produto 1",
          videos: [
            {
              videoId: "abcdefghijk",
              title: "Produto 1 resenha",
              url: "https://www.youtube.com/watch?v=abcdefghijk",
              publishedAt: "2026-08-01T00:00:00Z",
              viewCount: 100,
            },
          ],
        },
      ],
      observedAt: at,
    });

    expect(result[0]).toMatchObject({
      rankGroup: "fastest_growth",
      sourceCount: 1,
      missingSources: ["youtube_recent_video"],
    });
    expect(result[10]?.rankGroup).toBe("most_wanted");
    expect(result[30]?.rankGroup).toBe("popular");
  });
});
