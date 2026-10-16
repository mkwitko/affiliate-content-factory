import { describe, expect, it } from "vitest";
import { parseUserId, parseWorkspaceId } from "@money-maker/contracts";
import {
  parseCookie,
  sealAuthTransaction,
  sealMercadoLivreState,
  serializeCookie,
  unsealAuthTransaction,
  unsealMercadoLivreState,
} from "./session-cookie.js";

const secret = new TextEncoder().encode("12345678901234567890123456789012");

describe("session cookies", () => {
  it("seals and unseals the short-lived authorization transaction", async () => {
    const sealed = await sealAuthTransaction(
      { state: "state-1", nonce: "nonce-1", codeVerifier: "verifier-1" },
      secret,
    );

    await expect(unsealAuthTransaction(sealed, secret)).resolves.toEqual({
      state: "state-1",
      nonce: "nonce-1",
      codeVerifier: "verifier-1",
    });
    await expect(unsealAuthTransaction(`${sealed}tampered`, secret)).resolves.toBeNull();
  });

  it("serializes secure HttpOnly SameSite=Lax cookies", () => {
    const cookie = serializeCookie("mm_session", "opaque-token", {
      httpOnly: true,
      sameSite: "Lax",
      secure: true,
      path: "/",
      maxAge: 3600,
    });

    expect(cookie).toContain("mm_session=opaque-token");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
    expect(parseCookie(`mm_session=opaque-token; ${cookie.split("; ").slice(1).join("; ")}`)).toBe(
      "opaque-token",
    );
  });

  it("seals and unseals a workspace-bound, single-use Mercado Livre OAuth state", async () => {
    const workspaceId = parseWorkspaceId("0d7702aa-a69d-4f49-842a-c1a13e72160d");
    const userId = parseUserId("033bffd2-d9fb-4795-841d-6d83193a7707");
    const sealed = await sealMercadoLivreState({ workspaceId, userId, nonce: "nonce-1" }, secret);

    await expect(unsealMercadoLivreState(sealed, secret)).resolves.toEqual({
      workspaceId,
      userId,
      nonce: "nonce-1",
    });
    await expect(unsealMercadoLivreState(`${sealed}tampered`, secret)).resolves.toBeNull();
  });
});
