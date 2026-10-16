import { fitImage } from "../http/fit-image.js";
import { fetchSafeMedia } from "../http/safe-media-fetch.js";

export type CanvaClient = Readonly<{
  exportPages(input: {
    designId: string;
    pages: readonly number[];
    format: "png" | "jpg";
  }): Promise<
    readonly { page: number; bytes: Uint8Array; width: number; height: number; expiresAt: Date }[]
  >;
}>;

export class CanvaExportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CanvaExportError";
  }
}

const exportsUrl = "https://api.canva.com/rest/v1/exports";
// ponytail: bounded poll (30 attempts x 2s = 1 minute ceiling); raise if large designs need longer.
const maxPollAttempts = 30;
const pollIntervalMs = 2000;
// Canva does not return an expiry for a completed job's download URLs; bytes are already
// downloaded by the time this resolves, so a short safety window is enough for callers.
const downloadedPageTtlMs = 5 * 60 * 1000;

type ExportJob = Readonly<{
  status?: string;
  urls?: readonly string[];
  error?: Readonly<{ code?: string; message?: string }>;
}>;

// A 401 on an export call means the access token was revoked before its expiry: the operator
// must reconnect Canva, which is a different action from fixing the design.
const rejectRevokedToken = (response: Response): void => {
  if (response.status === 401) throw new CanvaExportError("canva_token_invalid");
};

export const createCanvaClient = (deps: {
  accessToken: string;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): CanvaClient => {
  const fetcher = deps.fetcher ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const authorization = `Bearer ${deps.accessToken}`;

  const createExportJob = async (input: {
    designId: string;
    pages: readonly number[];
    format: "png" | "jpg";
  }): Promise<string> => {
    const response = await fetcher(exportsUrl, {
      method: "POST",
      headers: { authorization, "content-type": "application/json" },
      body: JSON.stringify({
        design_id: input.designId,
        format: {
          type: input.format,
          pages: [...input.pages],
          ...(input.format === "jpg" ? { quality: 90 } : {}),
        },
      }),
    });
    rejectRevokedToken(response);
    if (!response.ok) throw new CanvaExportError("canva_export_request_failed");
    const body = (await response.json()) as { job?: { id?: unknown } };
    if (typeof body.job?.id !== "string") throw new CanvaExportError("canva_export_request_failed");
    return body.job.id;
  };

  const pollExportJob = async (jobId: string): Promise<ExportJob> => {
    for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
      const response = await fetcher(`${exportsUrl}/${jobId}`, { headers: { authorization } });
      rejectRevokedToken(response);
      if (!response.ok) throw new CanvaExportError("canva_export_poll_failed");
      const body = (await response.json()) as { job?: ExportJob };
      const job = body.job;
      if (job?.status === "success" || job?.status === "failed") return job;
      await sleep(pollIntervalMs);
    }
    throw new CanvaExportError("canva_export_timed_out");
  };

  return {
    exportPages: async (input) => {
      if (!input.pages.length) throw new CanvaExportError("canva_export_no_pages");
      const jobId = await createExportJob(input);
      const job = await pollExportJob(jobId);
      if (job.status !== "success" || !job.urls?.length) {
        throw new CanvaExportError(job.error?.code ?? "canva_export_failed");
      }
      // Canva does not tag each url with its page number; assume the download order matches
      // the requested `pages` order (the order sent in the export job's format.pages).
      return Promise.all(
        job.urls.map(async (url, index) => {
          const media = await fetchSafeMedia(
            new URL(url),
            { maxBytes: 10_000_000, allowedMimeTypes: ["image/png", "image/jpeg"] },
            fetcher,
          );
          const measured = await fitImage(media.bytes);
          return {
            page: input.pages[index] ?? index + 1,
            bytes: measured.bytes,
            width: measured.width,
            height: measured.height,
            expiresAt: new Date(Date.now() + downloadedPageTtlMs),
          };
        }),
      );
    },
  };
};
