import type { FastifyInstance } from "fastify";
import { releaseVersion } from "../release.js";

export const registerHealthRoute = async (app: FastifyInstance): Promise<void> => {
  app.get("/health", async () => ({ status: "ok", version: releaseVersion }));
};
