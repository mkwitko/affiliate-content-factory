import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { parseWorkspaceId } from "@money-maker/contracts";
import { createReconcilePublicationJob } from "@money-maker/core/jobs/job";
import { z } from "zod";
import { sendError, unexpectedError } from "../http/errors.js";
import type { ApiDependencies } from "../app.js";
import { authorizeMember } from "./provider-connections.js";

type Options = Readonly<{ dependencies: ApiDependencies }>;
type ConnectionParams = { workspaceId: string; connectionId: string };

const events = new Set([
  "social.post.created",
  "social.post.updated",
  "social.post.deleted",
  "social.post.result.created",
]);

const envelopeSchema = z
  .object({ event_type: z.string(), data: z.record(z.string(), z.unknown()) })
  .strict();
const workspace = (value: string) => {
  try {
    return parseWorkspaceId(value);
  } catch {
    return null;
  }
};

const equalSecret = (expected: string, actual: string | undefined): boolean => {
  if (!actual) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
};

const stringField = (data: Record<string, unknown>, ...names: string[]): string | null => {
  for (const name of names) {
    const value = data[name];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
};

export const registerPostForMeWebhookRoutes = async (
  app: FastifyInstance,
  options: Options,
): Promise<void> => {
  app.post<{ Params: ConnectionParams; Body: unknown }>(
    "/v1/workspaces/:workspaceId/provider-connections/:connectionId/webhook",
    async (request, reply) => {
      const authentication = await options.dependencies.authenticate(request);
      if (!authentication)
        return sendError(reply, 401, {
          code: "UNAUTHENTICATED",
          message: "Authentication required",
        });
      const workspaceId = workspace(request.params.workspaceId);
      if (
        !workspaceId ||
        !request.params.connectionId ||
        !options.dependencies.providerConnections?.configureWebhook ||
        !options.dependencies.postForMeClient ||
        !options.dependencies.secretStoreForWorkspace ||
        !options.dependencies.publicApiUrl
      )
        return sendError(reply, 400, {
          code: "INVALID_REQUEST",
          message: "Webhook setup is not configured",
        });
      const authorization = await authorizeMember(
        options.dependencies,
        workspaceId,
        authentication.userId,
        ["owner", "operator"],
      );
      if (!authorization.ok)
        return authorization.status === 404
          ? sendError(reply, 404, { code: "NOT_FOUND", message: "Workspace not found" })
          : sendError(reply, 403, { code: "FORBIDDEN", message: "Access denied" });
      const connection = await options.dependencies.providerConnections.findForWorkspace({
        workspaceId,
        connectionId: request.params.connectionId,
      });
      if (!connection)
        return sendError(reply, 404, { code: "NOT_FOUND", message: "Connection not found" });
      try {
        const secrets = options.dependencies.secretStoreForWorkspace(workspaceId);
        const apiKey = await secrets.get(connection.secretReference);
        if (!apiKey)
          return sendError(reply, 409, {
            code: "CONNECTION_SECRET_MISSING",
            message: "Provider credential is unavailable",
          });
        const webhook = await options.dependencies.postForMeClient.createWebhook({
          apiKey,
          url: `${options.dependencies.publicApiUrl.replace(/\/$/, "")}/v1/provider-webhooks/post-for-me/${connection.id}`,
          eventTypes: [...events],
        });
        const webhookSecretReference = `secret://workspace/${workspaceId}/provider-webhook/${randomUUID()}`;
        await secrets.put({ reference: webhookSecretReference, secret: webhook.secret });
        try {
          const updated = await options.dependencies.providerConnections.configureWebhook({
            workspaceId,
            connectionId: connection.id,
            webhookId: webhook.id,
            webhookSecretReference,
          });
          if (!updated) {
            await secrets.delete(webhookSecretReference);
            return sendError(reply, 404, { code: "NOT_FOUND", message: "Connection not found" });
          }
          return reply.code(201).send({ webhook: { id: webhook.id, configured: true } });
        } catch (error) {
          await secrets.delete(webhookSecretReference);
          throw error;
        }
      } catch {
        return unexpectedError(reply);
      }
    },
  );

  app.post<{ Params: { connectionId: string }; Body: unknown }>(
    "/v1/provider-webhooks/post-for-me/:connectionId",
    async (request, reply) => {
      if (
        !options.dependencies.providerConnections ||
        !options.dependencies.webhookInbox ||
        !options.dependencies.jobQueue ||
        !options.dependencies.secretStoreForWorkspace
      )
        return sendError(reply, 500, {
          code: "INTERNAL_ERROR",
          message: "Webhook dependencies are not configured",
        });
      const parsed = envelopeSchema.safeParse(request.body);
      if (!parsed.success || !events.has(parsed.data.event_type))
        return sendError(reply, 400, {
          code: "INVALID_WEBHOOK",
          message: "Webhook payload is invalid",
        });
      const serialized = JSON.stringify(parsed.data);
      if (Buffer.byteLength(serialized, "utf8") > 32_768)
        return sendError(reply, 413, {
          code: "PAYLOAD_TOO_LARGE",
          message: "Webhook payload is too large",
        });
      if (!options.dependencies.providerConnections.findById)
        return sendError(reply, 500, {
          code: "INTERNAL_ERROR",
          message: "Webhook dependencies are not configured",
        });
      const resolved = await options.dependencies.providerConnections.findById(
        request.params.connectionId,
      );
      if (!resolved)
        return sendError(reply, 401, {
          code: "INVALID_WEBHOOK",
          message: "Webhook credentials are invalid",
        });
      const secretReference = resolved.webhookSecretReference;
      if (!secretReference)
        return sendError(reply, 401, {
          code: "INVALID_WEBHOOK",
          message: "Webhook credentials are invalid",
        });
      const secret = await options.dependencies
        .secretStoreForWorkspace(resolved.workspaceId)
        .get(secretReference);
      if (
        !equalSecret(
          secret ?? "",
          request.headers["post-for-me-webhook-secret"] as string | undefined,
        )
      )
        return sendError(reply, 401, {
          code: "INVALID_WEBHOOK",
          message: "Webhook credentials are invalid",
        });
      const providerResourceId = stringField(parsed.data.data, "external_id", "id", "post_id");
      if (!providerResourceId)
        return sendError(reply, 400, {
          code: "INVALID_WEBHOOK",
          message: "Webhook resource ID is missing",
        });
      const providerEventId = stringField(parsed.data.data, "event_id", "delivery_id");
      const deliveryKey = providerEventId ?? createHash("sha256").update(serialized).digest("hex");
      const stored = await options.dependencies.webhookInbox.createIfAbsent({
        deliveryKey,
        workspaceId: resolved.workspaceId,
        connectionId: resolved.id,
        eventType: parsed.data.event_type,
        providerResourceId,
      });
      if (stored.created) {
        try {
          await options.dependencies.jobQueue.enqueue(
            createReconcilePublicationJob({
              workspaceId: resolved.workspaceId,
              attemptId: providerResourceId,
            }),
          );
        } catch {
          return sendError(reply, 500, {
            code: "INTERNAL_ERROR",
            message: "Webhook could not be queued",
          });
        }
      }
      return reply.code(202).send({ accepted: true });
    },
  );
};
