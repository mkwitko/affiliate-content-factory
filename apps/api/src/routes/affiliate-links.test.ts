import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import type { InvitationDependencies } from "@money-maker/core/identity/invitation-repository";
import type { ProductCandidate } from "@money-maker/core/research/product-candidate";
import type { ApiDependencies } from "../app.js";
import { buildApp } from "../app.js";
import { fakeCandidateRepository } from "../mcp/tools/candidate-repository-fake.js";

const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");

const row: ProductCandidate = {
  id: "cand-1",
  workspaceId,
  nicheId: "niche-1",
  policyId: "policy-1",
  providerId: "MLB1",
  title: "Produto 1",
  listingUrl: "https://www.mercadolivre.com.br/p/MLB1",
  seller: "Loja",
  availability: "available",
  priceMinor: 9990,
  currency: "BRL",
  rank: 0,
  discoveredAt: new Date(),
  state: "awaiting_affiliate_link",
};

const setup = (role: "owner" | "operator" | "reviewer", authenticated = true) =>
  buildApp({
    invitation: {} as InvitationDependencies,
    workspaces: {
      create: async () => ({ id: workspaceId, name: "Workspace" }),
      findByIdForMember: async () => ({ id: workspaceId, name: "Workspace" }),
      findMembership: async () => ({ workspaceId, userId, role, status: "active" }),
      addMembership: async () => undefined,
    },
    nicheRepository: { listForWorkspace: async () => [{ id: "niche-1", name: "Cafe" }] },
    productCandidateRepository: fakeCandidateRepository([row]),
    offerRepository: { listForWorkspace: async () => [] },
    audit: { record: async () => "audit-1" },
    affiliateLinkResolver: async () => ({ productId: null, failure: "redirect" }),
    jobQueue: { enqueue: async () => ({ id: "job-1" }) },
    marketplaceCatalog: {},
    authenticate: async () => (authenticated ? { userId } : null),
  } as unknown as ApiDependencies);

const queueUrl = `/v1/workspaces/${workspaceId}/affiliate-link-queue`;
const linksUrl = `/v1/workspaces/${workspaceId}/affiliate-links`;

describe("affiliate link routes", () => {
  it("lists the queue for a reviewer", async () => {
    const response = await setup("reviewer").inject({ method: "GET", url: queueUrl });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      total: 1,
      items: [{ candidateId: "cand-1", nicheName: "Cafe" }],
    });
  });

  it("requires authentication", async () => {
    const app = setup("owner", false);
    expect((await app.inject({ method: "GET", url: queueUrl })).statusCode).toBe(401);
    expect(
      (await app.inject({ method: "POST", url: linksUrl, payload: { links: [] } })).statusCode,
    ).toBe(401);
  });

  it("rejects invalid link bodies", async () => {
    const response = await setup("operator").inject({
      method: "POST",
      url: linksUrl,
      payload: { links: [{ candidateId: "cand-1", affiliateUrl: "nope" }] },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "INVALID_ARGUMENTS" } });
  });

  it("forbids reviewers from submitting links", async () => {
    const response = await setup("reviewer").inject({
      method: "POST",
      url: linksUrl,
      payload: {
        links: [{ candidateId: "cand-1", affiliateUrl: "https://mercadolivre.com/sec/abc" }],
      },
    });
    expect(response.statusCode).toBe(403);
  });
});
