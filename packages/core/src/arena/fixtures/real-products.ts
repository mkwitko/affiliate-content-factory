import type { CommercialFact } from "../../offers/offer.js";

/**
 * Arena level 2: REAL Mercado Livre products for benchmarks (captured 2026-10-07). Five come
 * from the workspace's active offers (verified snapshot facts, imported listing photo); the rest
 * from the Mercado Livre search the factory uses (price and shipping as listed that day, first
 * listing photo). Benchmark only: prices change, so nothing here is publishable as is.
 * `hard` tags the cases the brief asks for (transparent, reflective, screen, cable, packaging...).
 * The set is 26 products; the search was rate limited before reaching 30 (add more later).
 */
export type RealProductNiche = "casa" | "beleza" | "tech";
export type RealProduct = Readonly<{
  id: string;
  niche: RealProductNiche;
  providerId: string;
  title: string;
  listingUrl: string;
  /** Listing photo: an mlstatic URL, or a workspace public asset id (`asset:<uuid>`). */
  photo: string;
  facts: readonly CommercialFact[];
  hard: readonly string[];
  /** Short English description for scene prompts, taken from the listing title, not invented. */
  visual: string;
}>;

const ML = "https://http2.mlstatic.com/";
const brl = (amountMinor: number) => ({ amountMinor, currency: "BRL" as const });

const product = (
  id: string,
  niche: RealProductNiche,
  providerId: string,
  title: string,
  photo: string,
  price: Readonly<{ current: number; list?: number; freeShipping: boolean; discount?: number }>,
  hard: readonly string[],
  visual: string,
): RealProduct => {
  const sourceUrl = `https://www.mercadolivre.com.br/p/${providerId}`;
  const fact = (key: string, value: CommercialFact["value"]): CommercialFact => ({
    key,
    value,
    sourceUrl,
    verified: true,
  });
  return {
    id,
    niche,
    providerId,
    title,
    listingUrl: sourceUrl,
    photo: photo.startsWith("asset:") ? photo : `${ML}${photo}`,
    facts: [
      fact("current_price", brl(price.current)),
      ...(price.list ? [fact("list_price", brl(price.list))] : []),
      ...(price.discount ? [fact("discount_percent", price.discount)] : []),
      fact("free_shipping", price.freeShipping),
    ],
    hard,
    visual,
  };
};

export const REAL_PRODUCTS: readonly RealProduct[] = Object.freeze([
  // Casa (Carla)
  product(
    "casa-estante-modular",
    "casa",
    "MLB59727079",
    "Estante Plastica Modular 3 Prateleiras Multiuso Organizadora",
    "D_NQ_NP_911294-MLA111863772500_062026-F.jpg",
    { current: 4290, freeShipping: false },
    ["rigid_geometry", "multi_part", "large"],
    "a plastic modular rack with 3 shelves",
  ),
  product(
    "casa-porta-tempero",
    "casa",
    "MLB23509265",
    "Porta tempero giratório com 12 potes",
    "asset:9e4a77d7-b933-4057-8bd3-fab5f41aa334",
    { current: 5767, list: 6990, discount: 17, freeShipping: false },
    ["multi_part", "count_matters", "transparent"],
    "a rotating spice rack holding 12 jars",
  ),
  product(
    "casa-escorredor-inox",
    "casa",
    "MLB72866832",
    "Escorredor Porta Talheres Utensílios Inox Grande Pia Premium Inox",
    "D_NQ_NP_747030-MLA111792414776_062026-F.jpg",
    { current: 4270, freeShipping: false },
    ["reflective", "chrome", "thin_parts"],
    "a large stainless steel cutlery drainer",
  ),
  product(
    "casa-escorredor-rosatta",
    "casa",
    "MLB62946808",
    "Escorredor Porta Talheres Pia Rosatta Inox Aço Inoxidável",
    "D_NQ_NP_887254-MLA100667401795_122025-F.jpg",
    { current: 6590, freeShipping: false },
    ["reflective", "chrome"],
    "a stainless steel sink cutlery drainer",
  ),
  product(
    "casa-cesto-dobravel",
    "casa",
    "MLB24403981",
    "Cesto Roupa Suja Dobrável Porto7 40L Tecido Geométrico Organizador",
    "D_NQ_NP_631707-MLU73784457996_012024-F.jpg",
    { current: 2840, list: 2990, freeShipping: false },
    ["soft_material", "pattern", "large"],
    "a foldable 40 L fabric laundry basket with a geometric pattern",
  ),
  product(
    "casa-mop-giratorio",
    "casa",
    "MLB22713201",
    "Mop Esfregão de Limpeza Giratório com balde centrífuga Verde",
    "D_NQ_NP_845136-MLA99419576186_112025-F.jpg",
    { current: 4990, freeShipping: false },
    ["multi_part", "large", "color_matters"],
    "a green spin mop with its centrifuge bucket",
  ),
  product(
    "casa-lixeira-inox",
    "casa",
    "MLB32349767",
    "Lixeira Inox 3 Litros Com Pedal - Balde Removível",
    "D_NQ_NP_806517-MLA99384726406_112025-F.jpg",
    { current: 6140, freeShipping: false },
    ["reflective", "chrome", "small"],
    "a small 3 L stainless steel pedal bin",
  ),
  product(
    "casa-garrafa-termica",
    "casa",
    "MLB35489890",
    "Garrafa Térmica Unitermi Garrafa Térmica De Inox",
    "D_NQ_NP_718527-MLA99943517491_112025-F.jpg",
    { current: 6799, freeShipping: false },
    ["reflective", "logo"],
    "a stainless steel thermos bottle",
  ),
  product(
    "casa-pote-geladeira",
    "casa",
    "MLB66404581",
    "Pote Hermético Organizador Geladeira Acrílico",
    "D_NQ_NP_954460-MLA108434373117_032026-F.jpg",
    { current: 5879, list: 9799, freeShipping: false },
    ["transparent", "multi_part"],
    "clear acrylic airtight fridge organizer containers",
  ),
  product(
    "casa-pote-vidro-bambu",
    "casa",
    "MLB22647197",
    "Pote Hermético Vidro Tampa Bambu",
    "D_NQ_NP_710837-MLA95638147522_102025-F.jpg",
    { current: 4785, freeShipping: false },
    ["transparent", "glass", "wood"],
    "glass storage jars with bamboo lids",
  ),

  // Beleza (Bia)
  product(
    "beleza-organizador-acrilico",
    "beleza",
    "MLB34496036",
    "Organizador Maquiagem Caixa Acrílico Transparente Portátil",
    "asset:dda74583-65e9-498b-86f7-26af5fe2d9c1",
    { current: 5146, list: 7899, discount: 34, freeShipping: false },
    ["transparent", "drawers"],
    "a clear acrylic makeup organizer box with drawers",
  ),
  product(
    "beleza-pincel-10pcs",
    "beleza",
    "MLB70043338",
    "10pcs Pincel Maquiagem Profissionais Multifuncional Macio Kit",
    "asset:1610634a-d33a-4557-878c-7f42c0d25786",
    { current: 2990, freeShipping: false },
    ["count_matters", "thin_parts", "small"],
    "a kit of 10 makeup brushes",
  ),
  product(
    "beleza-organizador-giratorio",
    "beleza",
    "MLB72133214",
    "Organizador Maquiagem Acrílico Giratório Suporte Cosmético",
    "D_NQ_NP_602588-MLA112705610355_062026-F.jpg",
    { current: 5999, freeShipping: true },
    ["transparent", "rotating"],
    "a rotating clear acrylic cosmetics organizer",
  ),
  product(
    "beleza-maleta-led",
    "beleza",
    "MLB62372333",
    "Maleta Maquiagem Divisórias Removíveis Espelho Led Prata",
    "D_NQ_NP_628886-MLA98964886859_112025-F.jpg",
    { current: 19390, list: 26997, freeShipping: true },
    ["reflective", "mirror", "light", "multi_part"],
    "a silver makeup case with removable dividers and an LED mirror",
  ),
  product(
    "beleza-kit-pincel-violeta",
    "beleza",
    "MLB23729646",
    "Kit Pincel Maquiagem 10 Peças Cor Violeta",
    "D_NQ_NP_643345-MLU73428005923_122023-F.jpg",
    { current: 1871, freeShipping: false },
    ["count_matters", "color_matters", "thin_parts"],
    "a violet set of 10 makeup brushes",
  ),
  product(
    "beleza-paleta-sombras",
    "beleza",
    "MLB43984814",
    "Paleta Sombras Matte Ludurana",
    "D_NQ_NP_857234-MLA92622936291_092025-F.jpg",
    { current: 2299, freeShipping: false },
    ["color_matters", "packaging_text", "small"],
    "a matte eyeshadow palette",
  ),
  product(
    "beleza-esponja-gota",
    "beleza",
    "MLB36815774",
    "Esponja Maquiagem Gota",
    "D_NQ_NP_948920-MLU76129355312_052024-F.jpg",
    { current: 1399, freeShipping: false },
    ["small", "soft_material"],
    "a teardrop makeup sponge",
  ),
  product(
    "beleza-escova-raquete",
    "beleza",
    "MLB70097419",
    "Escova Cabelo Raquete Desembaraçadora Preta",
    "D_NQ_NP_736078-MLA112010966543_052026-F.jpg",
    { current: 1599, freeShipping: false },
    ["thin_parts", "dark_product"],
    "a black paddle detangling hairbrush",
  ),
  product(
    "beleza-porta-escova",
    "beleza",
    "MLB68930759",
    "Porta-escova De Dentes Plasútil Estojo Individual Pêssego",
    "D_NQ_NP_886778-MLA111087357869_042026-F.jpg",
    { current: 1605, list: 1690, freeShipping: false },
    ["small", "color_matters"],
    "a peach toothbrush case",
  ),

  // Tech (Rafa)
  product(
    "tech-power-bank",
    "tech",
    "MLB60955911",
    "Power Bank 10000mah Carregador Portátil Turbo Rápido Universal",
    "asset:1d021c78-445c-4597-8fb3-cdaf74c43fc7",
    { current: 4190, list: 6290, discount: 33, freeShipping: false },
    ["printed_text", "rigid_geometry", "ports"],
    "a 10000 mAh power bank",
  ),
  product(
    "tech-fone-tws",
    "tech",
    "MLB78409891",
    "Fone Ouvido Sem Fio Tws Bluetooth 5.3",
    "asset:549edf6c-3a00-4ab9-8410-1524d015d77d",
    { current: 2999, freeShipping: false },
    ["small", "multi_part", "dark_product"],
    "black wireless earbuds with a charging case",
  ),
  product(
    "tech-fone-airdots",
    "tech",
    "MLB37640152",
    "Fone De Ouvido Airdots Sem Fio Fone Bluetooth",
    "D_NQ_NP_722399-MLA100077092857_122025-F.jpg",
    { current: 3935, freeShipping: false },
    ["small", "multi_part", "packaging_text"],
    "wireless earbuds with a charging case",
  ),
  product(
    "tech-suporte-aluminio",
    "tech",
    "MLB22547650",
    "Suporte Ajustável Notebook Alumínio Portátil Antiderrapante",
    "D_NQ_NP_655633-MLA95560442651_102025-F.jpg",
    { current: 4999, freeShipping: false },
    ["reflective", "rigid_geometry", "hinges"],
    "an adjustable aluminium laptop stand",
  ),
  product(
    "tech-carregador-20w",
    "tech",
    "MLB19755483",
    "Fonte Carregador USB-C 20W",
    "D_NQ_NP_630941-MLA99599824754_122025-F.jpg",
    { current: 1827, freeShipping: false },
    ["small", "connector", "printed_text"],
    "a 20 W USB-C wall charger",
  ),
  product(
    "tech-cabo-usbc",
    "tech",
    "MLB44684902",
    "Cabo USB C Anker 100W de 10 pés, cabo USB C para USB C",
    "D_NQ_NP_798226-MLA99966312761_112025-F.jpg",
    { current: 5790, freeShipping: false },
    ["thin_cable", "connector", "logo"],
    "a long braided USB-C to USB-C cable",
  ),
  product(
    "tech-hub-usb",
    "tech",
    "MLB24300925",
    "Hub USB Guadrini Hub USB 3.0",
    "D_NQ_NP_988237-MLA99588740512_122025-F.jpg",
    { current: 4399, freeShipping: true },
    ["ports", "connector", "small"],
    "a USB 3.0 hub with several ports",
  ),
]);
