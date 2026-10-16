export const mergeEditorialContext = (
  layers: readonly (Record<string, unknown> | null | undefined)[],
): Record<string, unknown> => Object.assign({}, ...layers.map((layer) => layer ?? {}));
