import { parseWorkspaceId, type WorkspaceId } from "@money-maker/contracts";
import type {
  MetricSyncCandidate,
  PerformanceObservation,
  PerformanceRepository,
  PostMetrics,
  VariantPerformance,
} from "@money-maker/core/analytics/performance";
import type { CheckpointDays, CheckpointObservation } from "@money-maker/core/analytics/learnings";
import type { ChannelKind } from "@money-maker/core/channels/channel";
import { Prisma } from "../../generated/prisma/client.js";
import type { DatabaseClient } from "./client.js";

type MetricColumns = {
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  profileVisits: number | null;
  estimatedMinutesWatched: number | null;
  averageViewDurationSeconds: number | null;
  averageViewPercentage: number | null;
  subscribersGained: number | null;
  subscribersLost: number | null;
  engagedViews: number | null;
};

const metricNames = [
  "views",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "profileVisits",
  "estimatedMinutesWatched",
  "averageViewDurationSeconds",
  "averageViewPercentage",
  "subscribersGained",
  "subscribersLost",
  "engagedViews",
] as const;

const toMetrics = (record: MetricColumns): PostMetrics =>
  Object.fromEntries(
    metricNames.flatMap((name) => (record[name] === null ? [] : [[name, Number(record[name])]])),
  ) as PostMetrics;

export class PrismaPerformanceRepository implements PerformanceRepository {
  public constructor(private readonly client: DatabaseClient) {}

  public async listSyncCandidates(since: Date): Promise<readonly MetricSyncCandidate[]> {
    const rows = await this.client.$queryRaw<
      {
        workspace_id: string;
        id: string;
        content_variant_id: string;
        connection_id: string;
        external_id: string;
        published_at: Date;
        observations: number;
      }[]
    >(Prisma.sql`
      SELECT a.workspace_id, a.id, a.content_variant_id, a.connection_id, a.external_id,
             a.published_at, count(p.id)::int AS observations
      FROM publication_attempts a
      LEFT JOIN content_performance p
        ON p.publication_attempt_id = a.id AND p.workspace_id = a.workspace_id
      WHERE a.status = 'PUBLISHED'
        AND a.external_id IS NOT NULL
        AND a.published_at >= ${since}
      GROUP BY a.id
    `);
    return rows.map((row) => ({
      workspaceId: parseWorkspaceId(row.workspace_id),
      publicationAttemptId: row.id,
      contentVariantId: row.content_variant_id,
      connectionId: row.connection_id,
      externalId: row.external_id,
      publishedAt: row.published_at,
      observationCount: row.observations,
    }));
  }

  public async record(observation: PerformanceObservation): Promise<void> {
    await this.client.contentPerformance.create({
      data: {
        workspaceId: observation.workspaceId,
        contentVariantId: observation.contentVariantId,
        publicationAttemptId: observation.publicationAttemptId,
        observedAt: observation.observedAt,
        ...Object.fromEntries(metricNames.map((name) => [name, observation.metrics[name] ?? null])),
        platformUrl: observation.platformUrl ?? null,
      },
    });
  }

  public async latestByVariant(
    workspaceId: WorkspaceId,
    options?: Readonly<{ since?: Date; limit?: number }>,
  ): Promise<readonly VariantPerformance[]> {
    const rows = await this.client.$queryRaw<
      (MetricColumns & {
        content_variant_id: string;
        publication_attempt_id: string;
        observed_at: Date;
        platform_url: string | null;
        channel_id: string;
        published_at: Date | null;
        creative_features: unknown;
      })[]
    >(Prisma.sql`
      SELECT * FROM (
        SELECT DISTINCT ON (p.content_variant_id)
               p.content_variant_id, p.publication_attempt_id, p.observed_at, p.platform_url,
               p.views, p.reach, p.likes, p.comments, p.shares, p.saves,
               p.profile_visits AS "profileVisits", p.estimated_minutes_watched AS "estimatedMinutesWatched",
               p.average_view_duration_seconds AS "averageViewDurationSeconds",
               p.average_view_percentage AS "averageViewPercentage", p.subscribers_gained AS "subscribersGained",
               p.subscribers_lost AS "subscribersLost", p.engaged_views AS "engagedViews", a.channel_id, a.published_at,
               v.creative_features
        FROM content_performance p
        JOIN publication_attempts a
          ON a.id = p.publication_attempt_id AND a.workspace_id = p.workspace_id
        LEFT JOIN content_variants v
          ON v.id = p.content_variant_id AND v.workspace_id = p.workspace_id
        WHERE p.workspace_id = ${workspaceId}::uuid
          AND (a.published_at IS NULL OR a.published_at >= ${options?.since ?? new Date(0)})
        -- A later empty read (post left the feed) never hides earlier real metrics.
        ORDER BY p.content_variant_id,
                 (p.views IS NULL AND p.reach IS NULL AND p.likes IS NULL AND p.comments IS NULL
                   AND p.shares IS NULL AND p.saves IS NULL AND p.profile_visits IS NULL
                   AND p.estimated_minutes_watched IS NULL AND p.average_view_duration_seconds IS NULL
                   AND p.average_view_percentage IS NULL AND p.subscribers_gained IS NULL
                   AND p.subscribers_lost IS NULL AND p.engaged_views IS NULL),
                 p.observed_at DESC
      ) latest
      ORDER BY published_at DESC NULLS LAST
      LIMIT ${Math.min(options?.limit ?? 200, 500)}
    `);
    return rows.map((row) => ({
      workspaceId,
      contentVariantId: row.content_variant_id,
      publicationAttemptId: row.publication_attempt_id,
      observedAt: row.observed_at,
      metrics: toMetrics(row),
      ...(row.platform_url ? { platformUrl: row.platform_url } : {}),
      channelId: row.channel_id,
      publishedAt: row.published_at,
      creativeFeatures: row.creative_features ?? null,
    }));
  }

  public async observationsAtCheckpoint(
    workspaceId: WorkspaceId,
    options: Readonly<{ checkpointDays: CheckpointDays; since?: Date }>,
  ): Promise<readonly CheckpointObservation[]> {
    const rows = await this.client.$queryRaw<
      (MetricColumns & {
        content_variant_id: string;
        channel_id: string;
        channel_kind: string;
        published_at: Date | null;
        observed_at: Date;
        creative_features: unknown;
        unique_clicks: number | null;
      })[]
    >(Prisma.sql`
      SELECT * FROM (
        SELECT DISTINCT ON (p.content_variant_id)
               p.content_variant_id, a.channel_id, ch.kind::text AS channel_kind, a.published_at,
               p.observed_at, v.creative_features,
               p.views, p.reach, p.likes, p.comments, p.shares, p.saves,
               p.profile_visits AS "profileVisits", p.estimated_minutes_watched AS "estimatedMinutesWatched",
               p.average_view_duration_seconds AS "averageViewDurationSeconds",
               p.average_view_percentage AS "averageViewPercentage", p.subscribers_gained AS "subscribersGained",
               p.subscribers_lost AS "subscribersLost", p.engaged_views AS "engagedViews",
               (SELECT CASE WHEN EXISTS (SELECT 1 FROM tracked_links t
                                        WHERE t.workspace_id = p.workspace_id
                                          AND t.content_variant_id = p.content_variant_id)
                      THEN count(DISTINCT c.visitor_hash)::int END
                  FROM click_events c
                 WHERE c.workspace_id = p.workspace_id AND c.content_variant_id = p.content_variant_id) AS unique_clicks
        FROM content_performance p
        JOIN publication_attempts a
          ON a.id = p.publication_attempt_id AND a.workspace_id = p.workspace_id
        JOIN channels ch ON ch.id = a.channel_id AND ch.workspace_id = a.workspace_id
        JOIN content_variants v
          ON v.id = p.content_variant_id AND v.workspace_id = p.workspace_id
        WHERE p.workspace_id = ${workspaceId}::uuid
          AND a.published_at IS NOT NULL
          AND a.published_at >= ${options.since ?? new Date(0)}
          AND p.observed_at >= a.published_at + make_interval(days => ${options.checkpointDays}::int)
          -- A refused read (all metrics empty) is not an observation.
          AND NOT (p.views IS NULL AND p.reach IS NULL AND p.likes IS NULL AND p.comments IS NULL
                   AND p.shares IS NULL AND p.saves IS NULL AND p.profile_visits IS NULL
                   AND p.estimated_minutes_watched IS NULL AND p.average_view_duration_seconds IS NULL
                   AND p.average_view_percentage IS NULL AND p.subscribers_gained IS NULL
                   AND p.subscribers_lost IS NULL AND p.engaged_views IS NULL)
        ORDER BY p.content_variant_id, p.observed_at ASC
      ) checkpointed
      ORDER BY published_at DESC
    `);
    return rows.map((row) => ({
      contentVariantId: row.content_variant_id,
      channelId: row.channel_id,
      channelKind: row.channel_kind.toLowerCase() as ChannelKind,
      publishedAt: row.published_at,
      observedAt: row.observed_at,
      metrics: toMetrics(row),
      creativeFeatures: row.creative_features ?? null,
      uniqueClicks: row.unique_clicks,
    }));
  }
}
