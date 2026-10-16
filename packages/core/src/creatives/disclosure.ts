import type { ChannelKind } from "../channels/channel.js";

export type Disclosure = Readonly<{ caption?: string; slide?: string }>;
export const disclosurePolicy: Readonly<Record<ChannelKind, Disclosure>> = Object.freeze({
  instagram_carousel: { caption: "#publi", slide: "Link de afiliado" },
  instagram_stories: { slide: "#publi · link de afiliado" },
  instagram_reels: { caption: "#publi" },
  threads: { caption: "#publi" },
  tiktok_photo_post: { caption: "#publi", slide: "#publi" },
  tiktok_video: { caption: "#publi" },
  youtube: {
    caption:
      "Este vídeo contém links de afiliado; posso receber comissão sem custo extra para você.",
  },
});
