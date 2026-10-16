import { randomUUID } from "node:crypto";
import { parseWorkspaceId } from "@money-maker/contracts";
import {
  createPublishContentJob,
  JobClaimLostError,
  RetryLaterJobError,
} from "@money-maker/core/jobs/job";
import type { JobStats } from "@money-maker/core/jobs/job-stats";
import type { JobQueue } from "@money-maker/core/jobs/job";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../database/client.js";

type JobApi = {
  createWorker?: (input: {
    queue: {
      claim: (input: {
        workerId: string;
        leaseDurationMs: number;
        names: readonly string[];
      }) => Promise<unknown>;
      complete: (input: { id: string; workspaceId: string; leaseToken: string }) => Promise<void>;
      retry: (input: {
        id: string;
        workspaceId: string;
        leaseToken: string;
        reason: string;
      }) => Promise<void>;
      failPermanently: (input: {
        id: string;
        workspaceId: string;
        leaseToken: string;
        reason: string;
      }) => Promise<void>;
    };
    handlers: Record<string, (job: unknown) => Promise<void>>;
    workerId: string;
    leaseDurationMs: number;
    pollIntervalMs: number;
    sleep?: (milliseconds: number) => Promise<void>;
  }) => { requestStop: () => void; run: () => Promise<void> };
  parseVersionedIdentifierPayload?: (input: unknown) => unknown;
};

const loadJobApi = async (): Promise<JobApi> => {
  const api = (await import("@money-maker/core/jobs/job").catch(() => ({}))) as JobApi;
  expect(api.createWorker).toBeTypeOf("function");
  expect(api.parseVersionedIdentifierPayload).toBeTypeOf("function");
  return api;
};

describe("versioned job payloads", () => {
  it("rejects malformed identifier payloads before a handler can receive them", async () => {
    const { parseVersionedIdentifierPayload } = await loadJobApi();
    expect(() =>
      parseVersionedIdentifierPayload?.({
        version: 2,
        workspaceId: "not-a-uuid",
        identifiers: { contentId: "not-a-uuid" },
      }),
    ).toThrow();
  });

  it("rejects oversized identifier payloads", async () => {
    const { parseVersionedIdentifierPayload } = await loadJobApi();
    const workspaceId = randomUUID();
    const identifier = randomUUID();
    expect(() =>
      parseVersionedIdentifierPayload?.({
        version: 1,
        workspaceId,
        identifiers: Object.fromEntries(
          Array.from({ length: 17 }, (_, index) => [`identifier${index}`, identifier]),
        ),
      }),
    ).toThrow("Job payload has too many identifiers.");
    expect(() =>
      parseVersionedIdentifierPayload?.({
        version: 1,
        workspaceId,
        identifiers: { ["x".repeat(65)]: identifier },
      }),
    ).toThrow("Job payload identifier names are too long.");
    expect(() =>
      parseVersionedIdentifierPayload?.({
        version: 1,
        workspaceId,
        identifiers: Object.fromEntries(
          Array.from({ length: 16 }, (_, index) => [
            `${"x".repeat(62)}${index.toString().padStart(2, "0")}`,
            identifier,
          ]),
        ),
      }),
    ).toThrow("Job payload is too large.");
  });

  it("normalizes UUIDs in a versioned identifier payload", async () => {
    const { parseVersionedIdentifierPayload } = await loadJobApi();
    const workspaceId = randomUUID();
    const contentId = randomUUID();
    expect(
      parseVersionedIdentifierPayload?.({
        version: 1,
        workspaceId: workspaceId.toUpperCase(),
        identifiers: { contentId: contentId.toUpperCase() },
      }),
    ).toMatchObject({
      workspaceId,
      identifiers: { contentId },
    });
  });

  it("stops after the current job when shutdown is requested", async () => {
    const { createWorker } = await loadJobApi();
    const claimed = {
      id: randomUUID(),
      name: "content.publish",
      payload: {
        version: 1,
        workspaceId: randomUUID(),
        identifiers: { contentId: randomUUID() },
      },
      workspaceId: randomUUID(),
      leaseToken: randomUUID(),
      idempotencyKey: "publish-once",
    };
    const queue = {
      claim: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null),
      complete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      failPermanently: vi.fn().mockResolvedValue(undefined),
    };
    let requestStop: (() => void) | undefined;
    const worker = createWorker?.({
      queue,
      handlers: {
        "content.publish": async (): Promise<void> => requestStop?.(),
      },
      workerId: "test-worker",
      leaseDurationMs: 1_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    requestStop = worker?.requestStop;

    await worker?.run();

    expect(queue.complete).toHaveBeenCalledWith({
      id: claimed.id,
      workspaceId: claimed.workspaceId,
      leaseToken: claimed.leaseToken,
    });
    expect(queue.claim).toHaveBeenCalledTimes(1);
  });

  it("passes a claimed job idempotency key to its handler", async () => {
    const { createWorker } = await loadJobApi();
    const claimed = {
      id: randomUUID(),
      name: "content.publish",
      payload: {
        version: 1,
        workspaceId: randomUUID(),
        identifiers: { contentId: randomUUID() },
      },
      workspaceId: randomUUID(),
      leaseToken: randomUUID(),
      idempotencyKey: "external-effect-once",
    };
    const queue = {
      claim: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null),
      complete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      failPermanently: vi.fn().mockResolvedValue(undefined),
    };
    let receivedIdempotencyKey: string | undefined;
    let requestStop: (() => void) | undefined;
    const worker = createWorker?.({
      queue,
      handlers: {
        "content.publish": async (job): Promise<void> => {
          receivedIdempotencyKey = (job as { idempotencyKey?: string }).idempotencyKey;
          requestStop?.();
        },
      },
      workerId: "test-worker",
      leaseDurationMs: 1_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    requestStop = worker?.requestStop;

    await worker?.run();

    expect(receivedIdempotencyKey).toBe(claimed.idempotencyKey);
  });

  it("passes a RetryLaterJobError's retryAt through to queue.retry", async () => {
    const { createWorker } = await loadJobApi();
    const claimed = {
      id: randomUUID(),
      name: "content.publish",
      payload: {
        version: 1,
        workspaceId: randomUUID(),
        identifiers: { contentId: randomUUID() },
      },
      workspaceId: randomUUID(),
      leaseToken: randomUUID(),
      idempotencyKey: "still-processing",
    };
    const retryAt = new Date(Date.now() + 30_000);
    const queue = {
      claim: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null),
      complete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn().mockResolvedValue(undefined),
      failPermanently: vi.fn().mockResolvedValue(undefined),
    };
    let requestStop: (() => void) | undefined;
    const worker = createWorker?.({
      queue,
      handlers: {
        "content.publish": async (): Promise<void> => {
          requestStop?.();
          throw new RetryLaterJobError("provider_still_processing", retryAt);
        },
      },
      workerId: "test-worker",
      leaseDurationMs: 1_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    requestStop = worker?.requestStop;

    await worker?.run();

    expect(queue.retry).toHaveBeenCalledWith({
      id: claimed.id,
      workspaceId: claimed.workspaceId,
      leaseToken: claimed.leaseToken,
      reason: "provider_still_processing",
      retryAt,
    });
  });

  it("does not invoke inherited properties as job handlers", async () => {
    const { createWorker } = await loadJobApi();
    const claimed = {
      id: randomUUID(),
      name: "constructor",
      payload: {
        version: 1,
        workspaceId: randomUUID(),
        identifiers: { contentId: randomUUID() },
      },
      workspaceId: randomUUID(),
      leaseToken: randomUUID(),
      idempotencyKey: "reserved-handler-name",
    };
    let requestStop: (() => void) | undefined;
    const queue = {
      claim: vi.fn().mockResolvedValueOnce(claimed).mockResolvedValue(null),
      complete: vi.fn().mockResolvedValue(undefined),
      retry: vi.fn(async () => requestStop?.()),
      failPermanently: vi.fn(async () => requestStop?.()),
    };
    const worker = createWorker?.({
      queue,
      handlers: {},
      workerId: "test-worker",
      leaseDurationMs: 1_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    requestStop = worker?.requestStop;

    await worker?.run();

    expect(queue.failPermanently).toHaveBeenCalledWith({
      id: claimed.id,
      workspaceId: claimed.workspaceId,
      leaseToken: claimed.leaseToken,
      reason: "unsupported_job",
    });
    expect(queue.retry).not.toHaveBeenCalled();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

integration("PostgresJobQueue", { timeout: 30_000 }, () => {
  let client: DatabaseClient;
  let PostgresJobQueue:
    | (new (
        client: DatabaseClient,
      ) => {
        enqueue: (input: unknown) => Promise<Record<string, unknown>>;
        claim: (input: {
          workerId: string;
          leaseDurationMs: number;
          names: readonly string[];
          workspaceId?: string;
        }) => Promise<Record<string, unknown> | null>;
        takeLease: (input: {
          id: string;
          workspaceId: string;
          leaseToken: string;
        }) => Promise<Record<string, unknown> | null>;
        complete: (input: { id: string; workspaceId: string; leaseToken: string }) => Promise<void>;
        retry: (input: {
          id: string;
          workspaceId: string;
          leaseToken: string;
          reason: string;
          retryAt?: Date;
        }) => Promise<void>;
        failPermanently: (input: {
          id: string;
          workspaceId: string;
          leaseToken: string;
          reason: string;
        }) => Promise<void>;
      })
    | undefined;

  beforeAll(async () => {
    const clientApi = await import("../database/client.js");
    const queueApi = (await import("./postgres-job-queue.js").catch(() => ({}))) as {
      PostgresJobQueue?: typeof PostgresJobQueue;
    };
    client = clientApi.createDatabaseClient(databaseUrl as string);
    PostgresJobQueue = queueApi.PostgresJobQueue as typeof PostgresJobQueue;
    expect(PostgresJobQueue).toBeTypeOf("function");
  });

  beforeEach(async () => {
    await client.publicationAttempt.deleteMany();
    await client.job.deleteMany();
    await client.auditEvent.deleteMany();
    await client.invitation.deleteMany();
    await client.membership.deleteMany();
    await client.workspace.deleteMany();
    await client.user.deleteMany();
  });

  afterAll(async () => {
    await client?.$disconnect();
  });

  const queue = () => new (PostgresJobQueue as NonNullable<typeof PostgresJobQueue>)(client);
  const allNames = [
    "content.publish",
    "publish_content",
    "render_creatives",
    "render_long_form",
    "render_reel",
    "render_owned_clip",
  ] as const;
  const stats = () => queue() as unknown as JobStats;
  const reviver = () => queue() as unknown as Required<Pick<JobQueue, "revive">>;
  const createWorkspace = async (): Promise<string> => {
    const userId = randomUUID();
    const workspaceId = randomUUID();
    await client.user.create({ data: { id: userId, email: `${userId}@example.test` } });
    await client.workspace.create({ data: { id: workspaceId, name: `Workspace ${workspaceId}` } });
    return workspaceId;
  };
  const payload = (workspaceId?: string) => ({
    version: 1,
    workspaceId: workspaceId ?? randomUUID(),
    identifiers: { contentId: randomUUID() },
  });
  const enqueue = async (
    input: { workspaceId?: string; key?: string; maxAttempts?: number } = {},
  ) =>
    queue().enqueue({
      name: "content.publish",
      payload: payload(input.workspaceId ?? (await createWorkspace())),
      idempotencyKey: input.key ?? randomUUID(),
      attemptPolicy: { maxAttempts: input.maxAttempts ?? 3 },
    });

  const enqueueNamed = async (name: string, workspaceId: string) =>
    queue().enqueue({
      name,
      payload: payload(workspaceId),
      idempotencyKey: randomUUID(),
      attemptPolicy: { maxAttempts: 2 },
    });

  it("claims only the given workspace's jobs and takes a live lease once (ADR 0012)", async () => {
    const mine = await createWorkspace();
    const other = await createWorkspace();
    await enqueueNamed("render_reel", other);
    await enqueueNamed("render_reel", mine);
    const claimed = await queue().claim({
      workerId: "home:token-1",
      leaseDurationMs: 60_000,
      names: ["render_reel"],
      workspaceId: mine,
    });
    expect(claimed).toMatchObject({ workspaceId: mine, name: "render_reel" });
    await expect(
      queue().claim({
        workerId: "home:token-1",
        leaseDurationMs: 60_000,
        names: ["render_reel"],
        workspaceId: mine,
      }),
    ).resolves.toBeNull();
    const lease = {
      id: String(claimed?.id),
      workspaceId: mine,
      leaseToken: String(claimed?.leaseToken),
    };
    await expect(queue().takeLease({ ...lease, workspaceId: other })).resolves.toBeNull();
    await expect(queue().takeLease({ ...lease, leaseToken: randomUUID() })).resolves.toBeNull();
    const taken = await queue().takeLease(lease);
    expect(taken).toMatchObject({ id: lease.id, name: "render_reel" });
    expect(taken?.leaseToken).not.toBe(lease.leaseToken);
    // The old token is spent: a replayed result finds nothing.
    await expect(queue().takeLease(lease)).resolves.toBeNull();
    const current = { ...lease, leaseToken: String(taken?.leaseToken) };
    await queue().complete(current);
    await expect(queue().takeLease(current)).resolves.toBeNull();
  });

  it("lets one workspace's home claim hold only that workspace's local-AI slot (ADR 0012)", async () => {
    const first = await createWorkspace();
    const second = await createWorkspace();
    await enqueueNamed("direct_scenes", first);
    await enqueueNamed("direct_scenes", first);
    await enqueueNamed("direct_scenes", second);
    const home = (workspaceId: string) =>
      queue().claim({
        workerId: `home:${workspaceId}`,
        leaseDurationMs: 60_000,
        names: ["direct_scenes"],
        workspaceId,
      });
    await expect(home(first)).resolves.toMatchObject({ workspaceId: first });
    await expect(home(first)).resolves.toBeNull();
    await expect(home(second)).resolves.toMatchObject({ workspaceId: second });
    // A shared local_ai worker still sees one global slot.
    await expect(
      queue().claim({ workerId: "local", leaseDurationMs: 60_000, names: ["direct_scenes"] }),
    ).resolves.toBeNull();
  });

  it("skips a second heavy render while one holds a live lease, but still serves light jobs", async () => {
    const workspaceId = await createWorkspace();
    await enqueueNamed("render_long_form", workspaceId);
    const first = await queue().claim({
      workerId: "worker-one",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    expect(first).toMatchObject({ name: "render_long_form" });
    await enqueueNamed("render_reel", workspaceId);
    await enqueueNamed("publish_content", workspaceId);
    const second = await queue().claim({
      workerId: "worker-two",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    expect(second).toMatchObject({ name: "publish_content" });
    await expect(
      queue().claim({ workerId: "worker-two", leaseDurationMs: 60_000, names: allNames }),
    ).resolves.toBeNull();
    await queue().complete({
      id: first?.id as string,
      workspaceId,
      leaseToken: first?.leaseToken as string,
    });
    await expect(
      queue().claim({ workerId: "worker-two", leaseDurationMs: 60_000, names: allNames }),
    ).resolves.toMatchObject({ name: "render_reel" });
  });

  it("serialises local-AI jobs among themselves, apart from heavy renders", async () => {
    const workspaceId = await createWorkspace();
    const names = [...allNames, "direct_scenes", "generate_plates"];
    await enqueueNamed("direct_scenes", workspaceId);
    await enqueueNamed("generate_plates", workspaceId);
    await enqueueNamed("render_reel", workspaceId);
    const first = await queue().claim({ workerId: "desktop", leaseDurationMs: 60_000, names });
    expect(first).toMatchObject({ name: "direct_scenes" });
    // A second local-AI job waits; a render is a different exclusive set and still runs.
    const second = await queue().claim({ workerId: "linux", leaseDurationMs: 60_000, names });
    expect(second).toMatchObject({ name: "render_reel" });
    await expect(
      queue().claim({ workerId: "desktop-2", leaseDurationMs: 60_000, names }),
    ).resolves.toBeNull();
    await queue().complete({
      id: first?.id as string,
      workspaceId,
      leaseToken: first?.leaseToken as string,
    });
    await expect(
      queue().claim({ workerId: "desktop-2", leaseDurationMs: 60_000, names }),
    ).resolves.toMatchObject({ name: "generate_plates" });
  });

  it("does not let an expired heavy lease block recovery", async () => {
    const workspaceId = await createWorkspace();
    await enqueueNamed("render_long_form", workspaceId);
    await enqueueNamed("render_reel", workspaceId);
    const stale = await queue().claim({
      workerId: "dead-worker",
      leaseDurationMs: 1,
      names: allNames,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const next = await queue().claim({
      workerId: "worker-two",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    expect(next).not.toBeNull();
    // Either the expired job is reclaimed or the other heavy job runs; never both at once.
    const again = await queue().claim({
      workerId: "worker-three",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    expect(again).toBeNull();
    expect([stale?.name, next?.name]).toContain("render_long_form");
  });

  it("never hands two heavy jobs to concurrent claimants", async () => {
    const workspaceId = await createWorkspace();
    for (let index = 0; index < 4; index += 1) await enqueueNamed("render_reel", workspaceId);
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        queue().claim({ workerId: `worker-${index}`, leaseDurationMs: 60_000, names: allNames }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
  });

  it("allows one claimant for a job", async () => {
    await enqueue();
    const [first, second] = await Promise.all([
      queue().claim({ workerId: "worker-one", leaseDurationMs: 60_000, names: allNames }),
      queue().claim({ workerId: "worker-two", leaseDurationMs: 60_000, names: allNames }),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
  });

  it("never hands a restricted worker a job outside its names under concurrent claims", async () => {
    const workspaceId = await createWorkspace();
    for (let index = 0; index < 5; index += 1) {
      await enqueueNamed("publish_content", workspaceId);
      await enqueueNamed("render_creatives", workspaceId);
    }
    const drain = async (workerId: string, names: readonly string[]) => {
      const claimed: Record<string, unknown>[] = [];
      for (;;) {
        const job = await queue().claim({ workerId, leaseDurationMs: 60_000, names });
        if (!job) return claimed;
        claimed.push(job);
      }
    };
    const [renderOnly, full] = await Promise.all([
      drain("render-only", ["render_creatives"]),
      drain("full", allNames),
    ]);
    expect(renderOnly.every((job) => job.name === "render_creatives")).toBe(true);
    expect(full.filter((job) => job.name === "publish_content")).toHaveLength(5);
    const ids = [...renderOnly, ...full].map((job) => job.id);
    expect(ids).toHaveLength(10);
    expect(new Set(ids).size).toBe(10);
  });

  it("leaves a job pending when no claimant lists its name", async () => {
    const workspaceId = await createWorkspace();
    await enqueueNamed("publish_content", workspaceId);
    await expect(
      queue().claim({ workerId: "render-only", leaseDurationMs: 60_000, names: ["render_reel"] }),
    ).resolves.toBeNull();
    await expect(client.job.count({ where: { status: "PENDING" } })).resolves.toBe(1);
  });

  it("rejects an empty or malformed names list", async () => {
    await expect(
      queue().claim({ workerId: "w", leaseDurationMs: 60_000, names: [] }),
    ).rejects.toThrow("Job names are invalid.");
    await expect(
      queue().claim({ workerId: "w", leaseDurationMs: 60_000, names: ["Render Reel"] }),
    ).rejects.toThrow("Job names are invalid.");
  });
  it("deduplicates an idempotency key within a workspace without crossing tenants", async () => {
    const workspaceId = await createWorkspace();
    const key = "publish-once";
    const first = await enqueue({ workspaceId, key });
    const duplicate = await enqueue({ workspaceId, key });
    const otherWorkspace = await enqueue({ workspaceId: await createWorkspace(), key });
    expect(duplicate.id).toBe(first.id);
    expect(otherWorkspace.id).not.toBe(first.id);
  });

  it("does not hand out a scheduled job before its time", async () => {
    const workspaceId = await createWorkspace();
    await queue().enqueue(
      createPublishContentJob({
        workspaceId: parseWorkspaceId(workspaceId),
        attemptId: randomUUID(),
        availableAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    );
    await expect(
      queue().claim({ workerId: "worker-one", leaseDurationMs: 60_000, names: allNames }),
    ).resolves.toBeNull();
  });

  it("accepts the identifier-only publish_content job contract", async () => {
    const workspaceId = await createWorkspace();
    const attemptId = randomUUID();
    const queued = await queue().enqueue(
      createPublishContentJob({
        workspaceId: parseWorkspaceId(workspaceId),
        attemptId,
      }),
    );

    expect(queued).toMatchObject({
      name: "publish_content",
      workspaceId,
      payload: { version: 1, workspaceId, identifiers: { attemptId } },
    });
    expect(JSON.stringify(queued.payload)).not.toContain("caption");
  });

  it("returns the idempotency key and workspace context to a claimant", async () => {
    const workspaceId = await createWorkspace();
    const idempotencyKey = "external-effect-once";
    const queued = await enqueue({ workspaceId, key: idempotencyKey });
    await expect(
      queue().claim({ workerId: "worker", leaseDurationMs: 60_000, names: allNames }),
    ).resolves.toMatchObject({
      id: queued.id,
      workspaceId,
      idempotencyKey,
    });
  });

  it("schedules a retry and caps attempts with a terminal failure", async () => {
    await enqueue({ maxAttempts: 2 });
    const first = await queue().claim({
      workerId: "worker",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    if (!first) throw new Error("Expected claimed job");
    const retryAt = new Date(Date.now() + 60_000);
    await queue().retry({
      id: first.id as string,
      workspaceId: first.workspaceId as string,
      leaseToken: first.leaseToken as string,
      reason: "timeout",
      retryAt,
    });
    expect(
      await queue().claim({ workerId: "worker", leaseDurationMs: 60_000, names: allNames }),
    ).toBeNull();
    await client.job.update({
      where: { id: first.id as string },
      data: { availableAt: new Date(Date.now() - 1) },
    });
    const second = await queue().claim({
      workerId: "worker",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    if (!second) throw new Error("Expected retried job");
    await queue().retry({
      id: second.id as string,
      workspaceId: second.workspaceId as string,
      leaseToken: second.leaseToken as string,
      reason: "timeout",
    });
    await expect(
      client.job.findUniqueOrThrow({ where: { id: first.id as string } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      terminalReason: "attempts_exhausted",
      attemptCount: 2,
    });
  });

  it("records an explicit permanent failure", async () => {
    await enqueue();
    const claimed = await queue().claim({
      workerId: "worker",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    if (!claimed) throw new Error("Expected claimed job");
    await queue().failPermanently({
      id: claimed.id as string,
      workspaceId: claimed.workspaceId as string,
      leaseToken: claimed.leaseToken as string,
      reason: "invalid_provider_configuration",
    });
    await expect(
      client.job.findUniqueOrThrow({ where: { id: claimed.id as string } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      terminalReason: "invalid_provider_configuration",
    });
  });

  it("recovers a job whose lease expired", async () => {
    await enqueue();
    const first = await queue().claim({
      workerId: "worker-one",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    if (!first) throw new Error("Expected claimed job");
    await client.job.update({
      where: { id: first.id as string },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    const recovered = await queue().claim({
      workerId: "worker-two",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    expect(recovered).toMatchObject({ id: first.id, attemptCount: 2 });
    expect(recovered?.leaseToken).not.toBe(first.leaseToken);
  });

  it("refuses every transition from a worker whose expired lease another worker re-claimed", async () => {
    await enqueue();
    const first = await queue().claim({
      workerId: "worker-one",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    if (!first) throw new Error("Expected claimed job");
    await client.job.update({
      where: { id: first.id as string },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });
    const second = await queue().claim({
      workerId: "worker-two",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    expect(second).toMatchObject({ id: first.id, attemptCount: 2 });

    const stale = {
      id: first.id as string,
      workspaceId: first.workspaceId as string,
      leaseToken: first.leaseToken as string,
    };
    await expect(queue().complete(stale)).rejects.toBeInstanceOf(JobClaimLostError);
    await expect(queue().retry({ ...stale, reason: "handler_failed" })).rejects.toBeInstanceOf(
      JobClaimLostError,
    );
    await expect(
      queue().failPermanently({ ...stale, reason: "render_timeout" }),
    ).rejects.toBeInstanceOf(JobClaimLostError);
    await expect(
      client.job.findUniqueOrThrow({ where: { id: first.id as string } }),
    ).resolves.toMatchObject({ status: "RUNNING", leaseToken: second?.leaseToken });

    await queue().complete({
      id: second?.id as string,
      workspaceId: second?.workspaceId as string,
      leaseToken: second?.leaseToken as string,
    });
    await expect(
      client.job.findUniqueOrThrow({ where: { id: first.id as string } }),
    ).resolves.toMatchObject({ status: "COMPLETED", attemptCount: 2, leaseToken: null });
  });

  it("terminalizes an expired lease that already exhausted its attempts", async () => {
    const queued = await enqueue({ maxAttempts: 1 });
    const claimed = await queue().claim({
      workerId: "worker-one",
      leaseDurationMs: 60_000,
      names: allNames,
    });
    if (!claimed) throw new Error("Expected claimed job");
    await client.job.update({
      where: { id: claimed.id as string },
      data: { leaseExpiresAt: new Date(Date.now() - 1) },
    });

    await expect(
      queue().claim({ workerId: "worker-two", leaseDurationMs: 60_000, names: allNames }),
    ).resolves.toBeNull();
    await expect(
      client.job.findUniqueOrThrow({ where: { id: queued.id as string } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      attemptCount: 1,
      terminalReason: "attempts_exhausted",
      leaseToken: null,
      leaseExpiresAt: null,
    });
  });

  it("rejects malformed payloads before persisting a job", async () => {
    await expect(
      queue().enqueue({
        name: "content.publish",
        payload: {
          version: 1,
          workspaceId: randomUUID(),
          identifiers: { contentId: "not-a-uuid" },
        },
        idempotencyKey: "malformed-payload",
        attemptPolicy: { maxAttempts: 3 },
      }),
    ).rejects.toThrow("Job payload identifiers must be valid UUIDs.");
    expect(await client.job.count()).toBe(0);
  });

  it("fails malformed and workspace-mismatched stored payloads without leaving them running", async () => {
    const workspaceId = await createWorkspace();
    const otherWorkspaceId = await createWorkspace();
    const malformed = await enqueue({ workspaceId });
    await client.job.update({
      where: { id: malformed.id as string },
      data: {
        availableAt: new Date(Date.now() - 1_000),
        payload: { version: 2, workspaceId, identifiers: { contentId: randomUUID() } },
      },
    });

    await expect(
      queue().claim({ workerId: "worker", leaseDurationMs: 60_000, names: allNames }),
    ).resolves.toBeNull();
    await expect(
      client.job.findUniqueOrThrow({ where: { id: malformed.id as string } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      terminalReason: "malformed_payload",
      leaseToken: null,
    });

    const mismatched = await enqueue({ workspaceId });
    await client.job.update({
      where: { id: mismatched.id as string },
      data: { payload: payload(otherWorkspaceId) },
    });

    await expect(
      queue().claim({ workerId: "worker", leaseDurationMs: 60_000, names: allNames }),
    ).resolves.toBeNull();
    await expect(
      client.job.findUniqueOrThrow({ where: { id: mismatched.id as string } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      terminalReason: "malformed_payload",
      leaseToken: null,
    });
  });

  it("claims a stored payload whose UUID casing differs from PostgreSQL", async () => {
    const workspaceId = await createWorkspace();
    const queued = await enqueue({ workspaceId });
    await client.job.update({
      where: { id: queued.id as string },
      data: { payload: payload(workspaceId.toUpperCase()) },
    });

    await expect(
      queue().claim({ workerId: "worker", leaseDurationMs: 60_000, names: allNames }),
    ).resolves.toMatchObject({
      id: queued.id,
      workspaceId,
    });
    await expect(
      client.job.findUniqueOrThrow({ where: { id: queued.id as string } }),
    ).resolves.toMatchObject({
      status: "RUNNING",
      terminalReason: null,
    });
  });

  it("continues to a valid job after terminally failing a malformed stored job", async () => {
    const { createWorker } = await loadJobApi();
    const workspaceId = await createWorkspace();
    const malformed = await enqueue({ workspaceId });
    await client.job.update({
      where: { id: malformed.id as string },
      data: {
        availableAt: new Date(Date.now() - 1_000),
        payload: { version: 2, workspaceId, identifiers: { contentId: randomUUID() } },
      },
    });
    const valid = await enqueue({ workspaceId });
    let handled = false;
    let requestStop: (() => void) | undefined;
    const worker = createWorker?.({
      queue: queue(),
      handlers: {
        "content.publish": async (): Promise<void> => {
          handled = true;
          requestStop?.();
        },
      },
      workerId: "worker",
      leaseDurationMs: 60_000,
      pollIntervalMs: 1,
      sleep: async () => undefined,
    });
    requestStop = worker?.requestStop;

    await worker?.run();

    expect(handled).toBe(true);
    await expect(
      client.job.findUniqueOrThrow({ where: { id: malformed.id as string } }),
    ).resolves.toMatchObject({
      status: "FAILED",
      terminalReason: "malformed_payload",
    });
    await expect(
      client.job.findUniqueOrThrow({ where: { id: valid.id as string } }),
    ).resolves.toMatchObject({
      status: "COMPLETED",
    });
  });

  it("rejects cross-workspace transitions without mutating the claimed job", async () => {
    const workspaceId = await createWorkspace();
    const otherWorkspaceId = await createWorkspace();
    const transitions = ["complete", "retry", "failPermanently"] as const;

    for (const transition of transitions) {
      await enqueue({ workspaceId });
      const claimed = await queue().claim({
        workerId: "worker",
        leaseDurationMs: 60_000,
        names: allNames,
      });
      if (!claimed) throw new Error("Expected claimed job");
      const input = {
        id: claimed.id as string,
        workspaceId: otherWorkspaceId,
        leaseToken: claimed.leaseToken as string,
      };

      if (transition === "complete") await expect(queue().complete(input)).rejects.toThrow();
      if (transition === "retry")
        await expect(queue().retry({ ...input, reason: "timeout" })).rejects.toThrow();
      if (transition === "failPermanently")
        await expect(
          queue().failPermanently({ ...input, reason: "invalid_provider_configuration" }),
        ).rejects.toThrow();

      await expect(
        client.job.findUniqueOrThrow({ where: { id: claimed.id as string } }),
      ).resolves.toMatchObject({
        workspaceId,
        status: "RUNNING",
        leaseToken: claimed.leaseToken,
      });
      await queue().complete({
        id: claimed.id as string,
        workspaceId,
        leaseToken: claimed.leaseToken as string,
      });
    }
  });

  it("counts jobs by name and status and lists failures, scoped to one workspace", async () => {
    const workspaceId = await createWorkspace();
    const otherWorkspaceId = await createWorkspace();
    await enqueueNamed("render_reel", workspaceId);
    await enqueueNamed("publish_content", workspaceId);
    await enqueueNamed("publish_content", otherWorkspaceId);
    const claimed = await queue().claim({
      workerId: "worker",
      leaseDurationMs: 60_000,
      names: ["publish_content"],
      workspaceId: workspaceId as never,
    });
    if (!claimed) throw new Error("Expected claimed job");
    await queue().failPermanently({
      id: claimed.id as string,
      workspaceId,
      leaseToken: claimed.leaseToken as string,
      reason: "offer_not_active",
    });

    const counts = await stats().countByStatus({
      workspaceId: workspaceId as never,
    });
    expect(counts).toHaveLength(2);
    expect(counts).toEqual(
      expect.arrayContaining([
        { name: "render_reel", status: "PENDING", count: 1 },
        { name: "publish_content", status: "FAILED", count: 1 },
      ]),
    );
    await expect(
      stats().countByStatus({
        workspaceId: workspaceId as never,
        names: ["render_reel"],
      }),
    ).resolves.toEqual([{ name: "render_reel", status: "PENDING", count: 1 }]);

    const since = new Date(Date.now() - 60_000);
    const failed = await stats().listFailed({
      workspaceId: workspaceId as never,
      since,
      take: 5,
    });
    expect(failed).toEqual([
      expect.objectContaining({
        id: claimed.id,
        name: "publish_content",
        terminalReason: "offer_not_active",
      }),
    ]);
    await expect(
      stats().listFailed({
        workspaceId: workspaceId as never,
        since: new Date(Date.now() + 60_000),
        take: 5,
      }),
    ).resolves.toEqual([]);
  });

  it("revives only a failed job of the same workspace with fresh attempts", async () => {
    const workspaceId = await createWorkspace();
    const otherWorkspaceId = await createWorkspace();
    await enqueueNamed("render_reel", workspaceId);
    const claimed = await queue().claim({
      workerId: "worker",
      leaseDurationMs: 60_000,
      names: ["render_reel"],
      workspaceId: workspaceId as never,
    });
    if (!claimed) throw new Error("Expected claimed job");
    const id = claimed.id as string;
    await expect(reviver().revive({ workspaceId: workspaceId as never, jobId: id })).resolves.toBe(
      false,
    );
    await queue().failPermanently({
      id,
      workspaceId,
      leaseToken: claimed.leaseToken as string,
      reason: "render_timeout",
    });
    await expect(
      reviver().revive({ workspaceId: otherWorkspaceId as never, jobId: id }),
    ).resolves.toBe(false);
    await expect(reviver().revive({ workspaceId: workspaceId as never, jobId: id })).resolves.toBe(
      true,
    );
    await expect(client.job.findUniqueOrThrow({ where: { id } })).resolves.toMatchObject({
      status: "PENDING",
      attemptCount: 0,
      terminalReason: null,
      leaseToken: null,
    });
  });
});
