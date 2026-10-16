import { EncryptJWT, jwtDecrypt } from "jose";
import {
  parseUserId,
  parseWorkspaceId,
  type UserId,
  type WorkspaceId,
} from "@money-maker/contracts";

export type AuthTransaction = Readonly<{
  state: string;
  nonce: string;
  codeVerifier: string;
}>;

type CookieOptions = Readonly<{
  httpOnly: boolean;
  sameSite: "Lax" | "Strict";
  secure: boolean;
  path: string;
  maxAge: number;
}>;

export const AUTH_TRANSACTION_COOKIE = "mm_auth_transaction";
export const AUTH_SESSION_COOKIE = "mm_session";
export const MERCADO_LIVRE_STATE_COOKIE = "mm_ml_state";
export const CANVA_STATE_COOKIE = "mm_canva_state";

export const sealAuthTransaction = async (
  transaction: AuthTransaction,
  secret: Uint8Array,
): Promise<string> =>
  new EncryptJWT(transaction)
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("5m")
    .encrypt(secret);

export const unsealAuthTransaction = async (
  value: string,
  secret: Uint8Array,
): Promise<AuthTransaction | null> => {
  try {
    const { payload } = await jwtDecrypt(value, secret, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    if (
      typeof payload.state !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.codeVerifier !== "string"
    ) {
      return null;
    }
    return {
      state: payload.state,
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
    };
  } catch {
    return null;
  }
};

export const sealMercadoLivreState = async (
  state: { workspaceId: WorkspaceId; userId: UserId; nonce: string },
  secret: Uint8Array,
): Promise<string> =>
  new EncryptJWT({ workspaceId: state.workspaceId, userId: state.userId, nonce: state.nonce })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(secret);

export const unsealMercadoLivreState = async (
  value: string,
  secret: Uint8Array,
): Promise<{ workspaceId: WorkspaceId; userId: UserId; nonce: string } | null> => {
  try {
    const { payload } = await jwtDecrypt(value, secret, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    if (
      typeof payload.workspaceId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.nonce !== "string"
    )
      return null;
    return {
      workspaceId: parseWorkspaceId(payload.workspaceId),
      userId: parseUserId(payload.userId),
      nonce: payload.nonce,
    };
  } catch {
    return null;
  }
};

export type CanvaStateTransaction = Readonly<{
  workspaceId: WorkspaceId;
  userId: UserId;
  nonce: string;
  /** PKCE code_verifier; carried only in this sealed, httpOnly cookie — never in the authorize
   * URL, the OAuth `state` query parameter, or anywhere else visible to the browser. */
  codeVerifier: string;
}>;

export const sealCanvaState = async (
  transaction: CanvaStateTransaction,
  secret: Uint8Array,
): Promise<string> =>
  new EncryptJWT({
    workspaceId: transaction.workspaceId,
    userId: transaction.userId,
    nonce: transaction.nonce,
    codeVerifier: transaction.codeVerifier,
  })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("10m")
    .encrypt(secret);

export const unsealCanvaState = async (
  value: string,
  secret: Uint8Array,
): Promise<CanvaStateTransaction | null> => {
  try {
    const { payload } = await jwtDecrypt(value, secret, {
      keyManagementAlgorithms: ["dir"],
      contentEncryptionAlgorithms: ["A256GCM"],
    });
    if (
      typeof payload.workspaceId !== "string" ||
      typeof payload.userId !== "string" ||
      typeof payload.nonce !== "string" ||
      typeof payload.codeVerifier !== "string"
    )
      return null;
    return {
      workspaceId: parseWorkspaceId(payload.workspaceId),
      userId: parseUserId(payload.userId),
      nonce: payload.nonce,
      codeVerifier: payload.codeVerifier,
    };
  } catch {
    return null;
  }
};

export const serializeCookie = (name: string, value: string, options: CookieOptions): string => {
  const attributes = [
    `${name}=${encodeURIComponent(value)}`,
    `Max-Age=${options.maxAge}`,
    `Path=${options.path}`,
    `SameSite=${options.sameSite}`,
    ...(options.httpOnly ? ["HttpOnly"] : []),
    ...(options.secure ? ["Secure"] : []),
  ];
  return attributes.join("; ");
};

export const parseCookie = (
  header: string | undefined,
  name = AUTH_SESSION_COOKIE,
): string | null => {
  const entry = header
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  if (!entry) return null;
  return decodeURIComponent(entry.slice(name.length + 1));
};
