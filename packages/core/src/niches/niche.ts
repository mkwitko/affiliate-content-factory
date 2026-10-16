import type { WorkspaceId } from "@money-maker/contracts";

export type NicheState = "draft" | "active" | "archived";
/** affiliate: offer-led commerce content; media: audience-first editorial brand (no offers). */
export type NicheKind = "affiliate" | "media";

export type Niche = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  name: string;
  audience: string;
  problem: string;
  editorialVoice: string;
  languages: readonly string[];
  monetizationHypothesis: string;
  state: NicheState;
  kind: NicheKind;
  context?: Record<string, unknown> | null;
  /** Public handle of the niche bio link /go/n/<slug>. */
  slug?: string;
}>;

export type CreateNicheInput = Readonly<{
  id?: string;
  workspaceId: WorkspaceId;
  name: string;
  audience: string;
  problem: string;
  editorialVoice: string;
  languages: readonly string[];
  monetizationHypothesis: string;
  kind?: NicheKind | undefined;
}>;

const required = (value: string, message: string): string => {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(message);
  return normalized;
};

/** Readable, url-safe and unique enough: "Example Shop Tech" -> "example-shop-tech-3f9a1c0d". */
export const nicheSlug = (name: string, suffix = crypto.randomUUID().slice(0, 8)): string =>
  `${
    name
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "nicho"
  }-${suffix}`;
export const createNiche = (input: CreateNicheInput): Niche => {
  const languages = input.languages.map((language) => language.trim()).filter(Boolean);
  if (languages.length === 0) throw new Error("Niche language is required");
  return Object.freeze({
    id: input.id ?? crypto.randomUUID(),
    workspaceId: input.workspaceId,
    name: required(input.name, "Niche name is required"),
    audience: required(input.audience, "Niche audience is required"),
    problem: required(input.problem, "Niche problem is required"),
    editorialVoice: required(input.editorialVoice, "Niche editorial voice is required"),
    languages: Object.freeze([...new Set(languages)]),
    monetizationHypothesis: required(
      input.monetizationHypothesis,
      "Niche monetization hypothesis is required",
    ),
    state: "draft" as const,
    kind: input.kind ?? "affiliate",
    slug: nicheSlug(input.name),
  });
};
