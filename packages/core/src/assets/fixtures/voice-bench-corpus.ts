/** Fixed en-US Cost Curious lines for the voice bench. Raw text; the bench applies the production spoken-form step. */
export type VoiceBenchCase = Readonly<{ id: string; text: string }>;

export const VOICE_BENCH_CORPUS: readonly VoiceBenchCase[] = [
  {
    id: "narration",
    text: "Every price tag is a small story. The store wants you to feel that the number is fair, so it frames the choice before you even look at the product. Once you notice the frame, the story starts to lose its grip on you.",
  },
  { id: "numbers", text: "Out of 12 shoppers, 7 picked the middle option, and 3 walked away." },
  {
    id: "currency",
    text: "The sticker said $19.99, but the premium plan was $1,250 for the year.",
  },
  { id: "percentages", text: "Nearly 37% of buyers choose the item that sits next to a decoy." },
  {
    id: "long-sentence",
    text: "When a store places an expensive item beside a slightly cheaper one, the cheaper one suddenly feels like a bargain, even though you never planned to spend that much, and that quiet shift in your sense of value is exactly what the pricing team was hoping for.",
  },
  { id: "hook", text: "You are paying for the frame." },
  { id: "question", text: "Why does the second cheapest option always look so tempting?" },
  {
    id: "dialogue",
    text: 'Sam said, "Wait, so the big one was only there to make the small one look good?"',
  },
];

/** pt-BR Reels narration lines (conversational: problem, product, price, CTA). Raw text; the bench applies expandSpokenPtBr. */
export const VOICE_BENCH_CORPUS_PT_BR: readonly VoiceBenchCase[] = [
  { id: "problem", text: "Cansou de passar o dia procurando onde guardar a bagunça da cozinha?" },
  { id: "problem-2", text: "Todo mundo já passou por isso: a gaveta não fecha e você desiste." },
  {
    id: "product",
    text: "Esse organizador de gavetas separa tudo em minutos e cabe em qualquer armário.",
  },
  { id: "price", text: "E o melhor: hoje ele está saindo por R$ 36,85." },
  { id: "dialogue", text: 'A Carla olhou a gaveta e disse: "Agora sim, achei tudo de primeira!"' },
  { id: "cta", text: "Quer o seu? É só tocar no link na bio." },
  // Brief E2 (docs/content-generation/experiments.md): numbers, units, names, emotions.
  { id: "price-cents", text: "De R$ 78,99 por R$ 48,99, e o frete é grátis." },
  { id: "price-thousand", text: "O notebook sai por R$ 1.299 no Mercado Livre." },
  { id: "tech-specs", text: "Bateria de 10.000 mAh, 128 GB e USB-C com USB 3.2." },
  { id: "tech-wireless", text: "Tem Wi-Fi, Bluetooth 5.3 e funciona em 127 V ou 220 V." },
  { id: "measures", text: "Com 30 cm de largura, ocupa 50% menos espaço." },
  { id: "names", text: "A Carla, a Bia e o Rafa testaram para o Example Shop." },
  { id: "surprise", text: "Gente, eu não acredito que coube tudo aqui!" },
  { id: "relief", text: "Ufa. Finalmente a bancada ficou livre." },
  {
    id: "recommendation",
    text: "Se eu fosse você, levava logo dois, um pra casa e outro pro trabalho.",
  },
  {
    id: "long",
    text: "Sabe aquela manhã corrida em que você procura o carregador pela casa inteira, se atrasa e ainda sai com o celular quase sem bateria? Pois é, com esse aqui isso acabou.",
  },
];
