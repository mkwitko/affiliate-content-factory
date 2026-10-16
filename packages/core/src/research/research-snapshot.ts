import { createHash, randomUUID } from "node:crypto";
import type { UserId, WorkspaceId } from "@money-maker/contracts";

export type ResearchProvider = "vidiq" | "hook_layer" | "mercado_livre" | "manual";
export type ResearchObservation = Readonly<{
  id: string;
  key: string;
  value: string;
  sourceUrl: string;
}>;
export type ResearchSnapshot = Readonly<{
  id: string;
  workspaceId: WorkspaceId;
  provider: ResearchProvider;
  nicheId: string | null;
  query: string;
  locale: string;
  observedAt: Date;
  expiresAt: Date;
  observations: readonly ResearchObservation[];
  contentHash: string;
  actorId: UserId;
}>;

const canonical = (nicheId: string | null, observations: readonly ResearchObservation[]) =>
  JSON.stringify({
    nicheId,
    observations: [...observations]
      .sort((a, b) => `${a.key}\u0000${a.sourceUrl}`.localeCompare(`${b.key}\u0000${b.sourceUrl}`))
      .map(({ key, value, sourceUrl }) => ({ key, value, sourceUrl })),
  });

export const createResearchSnapshot = (
  input: Readonly<{
    id?: string;
    workspaceId: WorkspaceId;
    provider: ResearchProvider;
    nicheId?: string | null | undefined;
    query: string;
    locale: string;
    observedAt: Date;
    expiresAt: Date;
    observations: readonly (Omit<ResearchObservation, "id"> & { id?: string })[];
    actorId: UserId;
  }>,
): ResearchSnapshot => {
  if (!input.query.trim() || !input.locale.trim())
    throw new Error("Research query and locale are required");
  if (!input.observations.length) throw new Error("Research observations are required");
  if (input.observations.length > 200) throw new Error("Too many research observations");
  if (input.expiresAt <= input.observedAt)
    throw new Error("Research expiry must follow observation time");
  const normalized = input.observations.map((observation) => {
    if (!observation.key.trim() || !observation.value.trim())
      throw new Error("Research observation fields are required");
    try {
      const url = new URL(observation.sourceUrl);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
    } catch {
      throw new Error("Research observation URL is invalid");
    }
    return Object.freeze({
      id: observation.id ?? randomUUID(),
      key: observation.key.trim(),
      value: observation.value.trim(),
      sourceUrl: observation.sourceUrl,
    });
  });
  if (
    new Set(normalized.map((observation) => `${observation.key}\u0000${observation.sourceUrl}`))
      .size !== normalized.length
  )
    throw new Error("Research observations must be unique");
  const nicheId = input.nicheId ?? null;
  return Object.freeze({
    id: input.id ?? randomUUID(),
    workspaceId: input.workspaceId,
    provider: input.provider,
    nicheId,
    query: input.query.trim(),
    locale: input.locale.trim(),
    observedAt: new Date(input.observedAt),
    expiresAt: new Date(input.expiresAt),
    observations: Object.freeze(normalized),
    contentHash: createHash("sha256").update(canonical(nicheId, normalized)).digest("hex"),
    actorId: input.actorId,
  });
};
