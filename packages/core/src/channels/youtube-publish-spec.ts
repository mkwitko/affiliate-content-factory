export type YouTubePublishSpecV1 = Readonly<{
  schemaVersion: 1;
  title: string;
  intendedFormat: "long_form" | "short";
  tags?: readonly string[] | undefined;
  categoryId?: string | undefined;
  defaultLanguage?: string | undefined;
  privacyStatus: "private" | "unlisted";
  madeForKids: boolean;
  containsSyntheticMedia: boolean;
  disclosureReason?: string | undefined;
  thumbnailAssetId?: string | undefined;
}>;
