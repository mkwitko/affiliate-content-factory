/**
 * Suggests an Instagram handle from a niche name: brand words joined, then "." and the last word
 * ("Example Shop Beleza" -> "exampleshop.beleza"). The operator can always edit it.
 */
// ponytail: naming heuristic only; store the real handle on the niche if brands stop following it.
export const suggestInstagramHandle = (nicheName: string): string => {
  const words = nicheName
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join("")}.${words.at(-1)}`;
};
