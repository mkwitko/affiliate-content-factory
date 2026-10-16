/**
 * VLM check for generated background plates: the renderer adds the product, the text and the
 * people later, so a plate must hold none of them. A plate is clean only when every answer is false.
 */
export const plateCheckJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["text", "person", "product"],
  properties: {
    text: { type: "boolean" },
    person: { type: "boolean" },
    product: { type: "boolean" },
  },
} as const;

export const PLATE_CHECK_PROMPT = `This image must be an empty background for an advert. Answer three questions with true or false:
text: are any letters, numbers, signs or logos visible?
person: is any person, face or body part visible?
product: is one object clearly presented as the featured product in focus?
Reply with JSON only.`;

export const parsePlateCheck = (
  raw: unknown,
): Readonly<{ text: boolean; person: boolean; product: boolean; clean: boolean }> | null => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (
    typeof r.text !== "boolean" ||
    typeof r.person !== "boolean" ||
    typeof r.product !== "boolean"
  )
    return null;
  return {
    text: r.text,
    person: r.person,
    product: r.product,
    clean: !r.text && !r.person && !r.product,
  };
};
