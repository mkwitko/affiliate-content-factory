import type { FastifyReply } from "fastify";

export type SafeError = Readonly<{
  code: string;
  message: string;
  details?: Readonly<Record<string, unknown>>;
}>;

export const sendError = (
  reply: FastifyReply,
  statusCode: number,
  error: SafeError,
): FastifyReply =>
  reply
    .code(statusCode)
    .send({ error: { code: error.code, message: error.message, ...error.details } });

export const unexpectedError = (reply: FastifyReply): FastifyReply =>
  sendError(reply, 500, {
    code: "INTERNAL_ERROR",
    message: "An unexpected error occurred",
  });
