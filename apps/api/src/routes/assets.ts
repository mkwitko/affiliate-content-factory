import type { FastifyInstance } from "fastify";
import { parseWorkspaceId, type UserId } from "@money-maker/contracts";
import { authorizeWorkspace } from "@money-maker/core/identity/authorization";
import { createAsset } from "@money-maker/core/assets/asset";
import { z } from "zod";
import { sendError, unexpectedError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type Params = { workspaceId: string };
type AssetParams = { workspaceId: string; assetId: string };

const assetSchema = z
  .object({
    mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    checksum: z.string().trim().min(1).max(256),
    width: z.number().int().positive().max(20_000),
    height: z.number().int().positive().max(20_000),
    provenance: z.enum(["operator_upload", "generated", "provider_import", "stock", "rendered"]),
    license: z.string().trim().min(1).max(500),
    commercialUse: z.union([z.boolean(), z.null()]).optional(),
    sourceUrl: z.url().optional(),
    creator: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

const workspace = (value: string) => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

const authorizeMember = async (
  dependencies: ApiDependencies,
  workspaceId: ReturnType<typeof parseWorkspaceId>,
  userId: UserId,
) => {
  const member = await dependencies.workspaces.findByIdForMember({ workspaceId, userId });
  if (!member) return { ok: false as const, status: 404 as const };
  const authorization = authorizeWorkspace({
    actorId: userId,
    workspaceId,
    membership: await dependencies.workspaces.findMembership({ workspaceId, userId }),
    allowedRoles: ["owner", "operator"],
  });
  return authorization.ok ? { ok: true as const } : { ok: false as const, status: 403 as const };
};

// scene_preview: explainer stills the operator opens from chat before approving a render.
// listing_picture / canonical_product: copies of public marketplace photos, fetched as reference
// images by the local edit bench; ids are random UUIDs.
const publicRoles = new Set([
  "logo",
  "character",
  "scene_preview",
  "listing_picture",
  "canonical_product",
]);

export const registerAssetRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  // Stable link for public-safe assets only (logos, character sheets, marketplace photo copies): redirects to a short-lived
  // signed object URL so the bucket stays private and the id never changes.
  app.get<{ Params: AssetParams }>(
    "/v1/public/workspaces/:workspaceId/assets/:assetId",
    async (request, reply) => {
      reply.header("cache-control", "no-store");
      const workspaceId = workspace(request.params.workspaceId);
      const { assetRepository, assetStore } = options.dependencies;
      if (!workspaceId || !assetRepository || !assetStore)
        return sendError(reply, 404, { code: "NOT_FOUND", message: "Asset not found" });
      const asset = await assetRepository.findForWorkspace({
        workspaceId,
        assetId: request.params.assetId,
      });
      const role = asset?.metadata?.role;
      if (!asset || asset.state !== "active" || typeof role !== "string" || !publicRoles.has(role))
        return sendError(reply, 404, { code: "NOT_FOUND", message: "Asset not found" });
      const download = await assetStore.createDownload({ workspaceId, assetId: asset.id });
      return reply.redirect(download.url, 302);
    },
  );

  app.post<{ Params: Params; Body: unknown }>(
    "/v1/workspaces/:workspaceId/assets",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      const body = assetSchema.safeParse(request.body);
      if (!workspaceId || !body.success)
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      if (!options.dependencies.assetRepository || !options.dependencies.assetStore) {
        return unexpectedError(reply);
      }
      try {
        const { commercialUse, sourceUrl, creator, ...assetInput } = body.data;
        const result = createAsset({
          ...assetInput,
          workspaceId,
          ...(commercialUse !== undefined ? { commercialUse } : {}),
          ...(sourceUrl !== undefined ? { sourceUrl } : {}),
          ...(creator !== undefined ? { creator } : {}),
        });
        if (!result.ok) {
          return sendError(reply, 400, {
            code: result.code.toUpperCase(),
            message: "Asset metadata is invalid",
          });
        }
        const asset = await options.dependencies.assetRepository.create(result.asset);
        const upload = await options.dependencies.assetStore.createUpload({
          workspaceId,
          assetId: asset.id,
          mimeType: asset.mimeType,
          checksum: asset.checksum,
          width: asset.width,
          height: asset.height,
        });
        return reply.code(201).send({ asset, upload });
      } catch {
        return unexpectedError(reply);
      }
    },
  );

  app.post<{ Params: AssetParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/assets/:assetId/complete",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      if (!workspaceId || !request.params.assetId || request.body !== undefined) {
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Request validation failed",
        });
      }
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      if (!options.dependencies.assetRepository || !options.dependencies.assetStore) {
        return unexpectedError(reply);
      }
      try {
        const asset = await options.dependencies.assetRepository.findForWorkspace({
          workspaceId,
          assetId: request.params.assetId,
        });
        if (!asset) return sendError(reply, 404, { code: "NOT_FOUND", message: "Asset not found" });
        const verified = await options.dependencies.assetStore.verifyUpload({
          workspaceId,
          assetId: asset.id,
        });
        if (
          verified.checksum !== asset.checksum ||
          verified.mimeType !== asset.mimeType ||
          verified.width !== asset.width ||
          verified.height !== asset.height
        ) {
          return sendError(reply, 409, {
            code: "UPLOAD_VERIFICATION_FAILED",
            message: "Uploaded asset metadata does not match the declared metadata",
          });
        }
        const active = await options.dependencies.assetRepository.updateState({
          workspaceId,
          assetId: asset.id,
          state: "active",
        });
        return active
          ? reply.code(200).send({ asset: active })
          : sendError(reply, 404, { code: "NOT_FOUND", message: "Asset not found" });
      } catch {
        return unexpectedError(reply);
      }
    },
  );
};
