import type { DesignExporter, ExportedPage } from "@money-maker/core/assets/design-exporter";
import type { CanvaClient } from "./client.js";
export class CanvaDesignExporter implements DesignExporter {
  public constructor(private readonly client: CanvaClient) {}
  public async exportPages(input: {
    designId: string;
    pages: readonly number[];
    format: "png" | "jpg";
  }): Promise<readonly ExportedPage[]> {
    if (!input.pages.length) throw new Error("invalid_page_selection");
    const pages = await this.client.exportPages(input);
    const ordered = input.pages.map((page) => pages.find((candidate) => candidate.page === page));
    if (ordered.some((page) => !page)) throw new Error("page_export_missing");
    return ordered
      .filter((page): page is NonNullable<typeof page> => page !== undefined)
      .map((page) => ({
        ...page,
        mimeType: input.format === "png" ? ("image/png" as const) : ("image/jpeg" as const),
      }));
  }
}
