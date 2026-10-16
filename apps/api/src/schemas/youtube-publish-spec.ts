import { z } from "zod";

const identifier = z.string().trim().min(1).max(200);

export const youtubePublishSpecV1Schema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().trim().min(1).max(100),
    intendedFormat: z.enum(["long_form", "short"]),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
    categoryId: z.string().regex(/^\d+$/).optional(),
    defaultLanguage: z
      .string()
      .regex(/^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/)
      .optional(),
    privacyStatus: z.enum(["private", "unlisted"]),
    madeForKids: z.boolean(),
    containsSyntheticMedia: z.boolean(),
    disclosureReason: z.string().trim().min(1).max(1000).optional(),
    thumbnailAssetId: identifier.optional(),
  })
  .strict()
  .superRefine((spec, context) => {
    if (spec.tags && spec.tags.join(",").length > 500)
      context.addIssue({ code: "custom", path: ["tags"], message: "tags exceed 500 characters" });
    if (spec.containsSyntheticMedia && !spec.disclosureReason)
      context.addIssue({
        code: "custom",
        path: ["disclosureReason"],
        message: "disclosureReason required",
      });
  });
