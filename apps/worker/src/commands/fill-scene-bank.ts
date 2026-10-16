import { parseWorkerEnvironment } from "@money-maker/config";
import { parseWorkspaceId } from "@money-maker/contracts";
import { fillSceneBank } from "@money-maker/core/creatives/fill-scene-bank";
import { decideSceneBudget } from "@money-maker/core/usage/generation-budget";
import { PrismaAssetRepository } from "@money-maker/providers/database/asset-repository";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PrismaNicheRepository } from "@money-maker/providers/database/niche-repository";
import { PrismaUsageRepository } from "@money-maker/providers/database/usage-repository";
import { postProcessPlate } from "@money-maker/providers/media/plate-postprocess";
import { R2AssetStore } from "@money-maker/providers/storage/r2-asset-store";
import { createR2S3SigningClient } from "@money-maker/providers/storage/r2-s3-signing-client";
import { sceneGeneratorFor } from "../scene-generator.js";

export {
  fillSceneBank,
  type PlatePostProcessor,
  plateRequestsFor,
} from "@money-maker/core/creatives/fill-scene-bank";

const main = async (): Promise<void> => {
  const workspaceId = process.argv[2];
  let client: ReturnType<typeof createDatabaseClient> | undefined;
  try {
    const environment = parseWorkerEnvironment(process.env);
    if (!workspaceId) throw new Error("Usage: pnpm fill-scene-bank <workspaceId>");
    const generator = sceneGeneratorFor(environment);
    if (!generator)
      throw new Error(
        "Set SCENE_GENERATOR_CMD and SCENE_GENERATOR_MODEL, or CLOUDFLARE_ACCOUNT_ID, CLOUDFLARE_API_TOKEN, and CLOUDFLARE_AI_GATEWAY.",
      );
    if (
      !environment.R2_ACCOUNT_ID ||
      !environment.R2_ACCESS_KEY_ID ||
      !environment.R2_SECRET_ACCESS_KEY ||
      !environment.R2_BUCKET
    )
      throw new Error("Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, and R2_BUCKET.");
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    client = createDatabaseClient(environment.DATABASE_URL);
    const assets = new PrismaAssetRepository(client);
    const niches = (
      await new PrismaNicheRepository(client).listForWorkspace(parsedWorkspaceId)
    ).filter((niche) => niche.state === "active");
    const result = await fillSceneBank(
      {
        assets,
        store: new R2AssetStore(
          createR2S3SigningClient({
            accountId: environment.R2_ACCOUNT_ID,
            accessKeyId: environment.R2_ACCESS_KEY_ID,
            secretAccessKey: environment.R2_SECRET_ACCESS_KEY,
            bucketName: environment.R2_BUCKET,
          }),
          environment.R2_BUCKET,
          environment.R2_SIGNED_URL_TTL ?? 900,
        ),
        generator,
        usage: new PrismaUsageRepository(client),
        budget: decideSceneBudget,
        now: () => new Date(),
        postProcess: postProcessPlate,
      },
      { workspaceId: parsedWorkspaceId, niches },
    );
    console.log(JSON.stringify(result));
  } finally {
    await client?.$disconnect();
  }
};

if (process.argv[1] && process.argv[1].endsWith("fill-scene-bank.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Scene Bank fill failed.");
    process.exitCode = 1;
  });
}
