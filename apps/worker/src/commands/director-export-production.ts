import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  exportProductionFixtures,
  type ProductionExportDeps,
} from "@money-maker/core/explainer/fixtures/scene-director/production-export";
import { createDatabaseClient } from "@money-maker/providers/database/client";
import { PrismaContentRepository } from "@money-maker/providers/database/content-repository";
import { PrismaEditorialRepository } from "@money-maker/providers/database/editorial-repository";
import { PrismaNicheRepository } from "@money-maker/providers/database/niche-repository";

/**
 * Exports approved production scripts as scene director holdout fixtures (spec 5.7.5) plus a
 * report of what was skipped and why. Read-only: it only lists and finds rows. Offline tool,
 * never wired into the queue.
 */
export const DEFAULT_EXPORT_OUT =
  "packages/core/src/explainer/fixtures/scene-director-production/holdout/fixtures.json";
const USAGE =
  "usage: director-export-production.js --workspace <workspaceId> [--limit 1-200] [--out fixtures.json]";

export type ExportArgs = Readonly<{
  workspaceId: ReturnType<typeof parseWorkspaceId>;
  limit: number;
  out: string;
}>;

export const parseExportArgs = (argv: readonly string[]): ExportArgs => {
  const values: Record<string, string> = {};
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      !flag ||
      !["--workspace", "--limit", "--out"].includes(flag) ||
      !value ||
      value.startsWith("--")
    )
      throw new Error(USAGE);
    values[flag] = value;
  }
  if (!values["--workspace"]) throw new Error(USAGE);
  let workspaceId: ExportArgs["workspaceId"];
  try {
    workspaceId = parseWorkspaceId(values["--workspace"]);
  } catch {
    throw new Error(`invalid --workspace: expected a workspace UUID. ${USAGE}`);
  }
  const limit = values["--limit"] === undefined ? 20 : Number(values["--limit"]);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200)
    throw new Error(`invalid --limit: expected an integer from 1 to 200. ${USAGE}`);
  return { workspaceId, limit, out: values["--out"] ?? DEFAULT_EXPORT_OUT };
};

type Write = (path: string, data: string) => Promise<void>;

/** Writes the report always and the fixtures only when at least one script was exported. */
export const runProductionExport = async (
  deps: ProductionExportDeps,
  args: ExportArgs,
  write: Write,
  now: Date,
) => {
  const { file, report } = await exportProductionFixtures(deps, {
    workspaceId: args.workspaceId,
    limit: args.limit,
    generatedAt: now,
  });
  if (report.candidateCount === 0)
    throw new Error(
      `no approved scripts in workspace ${args.workspaceId}: approve scripts with approve_content_script first`,
    );
  const reportPath = join(dirname(args.out), "production-export-report.json");
  await write(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  if (report.exportedCount === 0)
    throw new Error(`no exportable scripts (${report.candidateCount} skipped); see ${reportPath}`);
  await write(args.out, `${JSON.stringify(file, null, 2)}\n`);
  return { report, reportPath };
};

const main = async (): Promise<void> => {
  const args = parseExportArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL?.trim();
  if (!url) throw new Error("DATABASE_URL is not set");
  const client = createDatabaseClient(url);
  try {
    const { report, reportPath } = await runProductionExport(
      {
        scripts: new PrismaEditorialRepository(client),
        content: new PrismaContentRepository(client),
        niches: new PrismaNicheRepository(client),
      },
      args,
      async (path, data) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, data);
      },
      new Date(),
    );
    console.log(
      JSON.stringify({
        candidateCount: report.candidateCount,
        exportedCount: report.exportedCount,
        skipped: report.skipped.length,
        fixtures: args.out,
        report: reportPath,
      }),
    );
  } finally {
    await client.$disconnect();
  }
};

if (process.argv[1]?.endsWith("director-export-production.js")) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "director export failed");
    process.exitCode = 1;
  });
}
