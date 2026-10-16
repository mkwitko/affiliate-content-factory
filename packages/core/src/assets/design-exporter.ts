export type ExportedPage = Readonly<{
  page: number;
  bytes: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
  expiresAt: Date;
}>;
export interface DesignExporter {
  exportPages(input: {
    designId: string;
    pages: readonly number[];
    format: "png" | "jpg";
  }): Promise<readonly ExportedPage[]>;
}
