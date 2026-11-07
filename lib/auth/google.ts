import "server-only";
import type { Account, NextAuthOptions, Profile, Session } from "next-auth";
import type { JWT } from "next-auth/jwt";
import { decryptRefreshToken, encryptRefreshToken } from "../crypto.ts";
import { GOOGLE_SCOPES, GoogleIntegrationError } from "../google.ts";
import { WorkflowError } from "../requests/workflow.ts";

export const GOOGLE_AUTHORIZATION_PARAMS = {
  scope: GOOGLE_SCOPES.join(" "),
  access_type: "offline",
  prompt: "consent",
} as const;

/** Durable operations only. Never persist the account or unencrypted tokens. */
export interface AccountStore {
  // Unique email + atomic upsert must keep the same app_user.id on repeat login.
  findOrCreateUserByEmail(verifiedEmail: string): Promise<{ id: string }>;
  loadEncryptedRefreshToken(userId: string): Promise<{ email: string; ciphertext: Uint8Array | null }>;
  // UPDATE by this app_user.id; do not create a user or change its email here.
  saveEncryptedRefreshToken(userId: string, ciphertext: Uint8Array): Promise<void>;
}

export class GoogleAuthError extends Error {
  code: "google_signin_denied" | "google_reauth_required" | "auth_not_configured" | "auth_store_failed" | "invalid_session";
  constructor(code: GoogleAuthError["code"]) {
    super(code);
    this.code = code;
  }
}

export interface AppSession extends Session {
  user: { id: string; email: string; name: string | null };
}

type Callbacks = NonNullable<NextAuthOptions["callbacks"]>;
type GoogleCallbacks = Required<Pick<Callbacks, "signIn" | "jwt" | "session">>;

const EMAIL = /^[^\s@<>,;\r\n]+@[^\s@<>,;\r\n]+$/;
const SCOPE_ALIASES: Record<string, string> = {
  "https://www.googleapis.com/auth/userinfo.email": "email",
  "https://www.googleapis.com/auth/userinfo.profile": "profile",
};

function verifiedIdentity(account: Account | null, profile?: Profile) {
  if (account?.provider !== "google" || account.type !== "oauth" ||
      !profile || !("email_verified" in profile) || profile.email_verified !== true || typeof profile.sub !== "string" || !profile.sub ||
      account.providerAccountId !== profile.sub || typeof profile.email !== "string" || !EMAIL.test(profile.email)) {
    throw new GoogleAuthError("google_signin_denied");
  }
  const scopes = new Set((typeof account.scope === "string" ? account.scope : "").split(/\s+/).map((scope) => SCOPE_ALIASES[scope] ?? scope));
  if (!GOOGLE_SCOPES.every((scope) => scopes.has(scope))) throw new GoogleAuthError("google_signin_denied");
  return { email: profile.email.toLowerCase(), name: typeof profile.name === "string" ? profile.name : null };
}

function identityToken(token: JWT): JWT & { appUserId: string; email: string; name: string | null } {
  if (typeof token.appUserId !== "string" || !token.appUserId || token.sub !== token.appUserId ||
      typeof token.email !== "string" || !EMAIL.test(token.email)) throw new GoogleAuthError("invalid_session");
  // Never spread the incoming token or client-supplied session update. Only these
  // identity fields survive; NextAuth adds its own iat/exp/jti during encoding.
  return {
    sub: token.appUserId, appUserId: token.appUserId, email: token.email,
    name: typeof token.name === "string" ? token.name : null,
  };
}

/** Attach to NextAuth 4 with JWT sessions and the Google params exported above. */
export function createGoogleAuthCallbacks(dependencies: { store: AccountStore; encryptionKey: string }): GoogleCallbacks {
  if (Buffer.from(dependencies.encryptionKey, "base64").length !== 32) throw new GoogleAuthError("auth_not_configured");
  return {
    signIn({ account, profile }) {
      try { verifiedIdentity(account, profile); return true; }
      catch { return false; }
    },

    async jwt({ token, account, profile }) {
      if (!account) return identityToken(token);
      // Recheck here as well: persistence must not rely on a separate callback.
      const identity = verifiedIdentity(account, profile);
      let user: { id: string };
      try { user = await dependencies.store.findOrCreateUserByEmail(identity.email); }
      catch { throw new GoogleAuthError("auth_store_failed"); }
      if (typeof user?.id !== "string" || !user.id) throw new GoogleAuthError("auth_store_failed");

      if (typeof account.refresh_token === "string" && account.refresh_token.trim()) {
        const encrypted = encryptRefreshToken(account.refresh_token, user.id, dependencies.encryptionKey);
        try { await dependencies.store.saveEncryptedRefreshToken(user.id, new Uint8Array(Buffer.from(encrypted, "base64"))); }
        catch { throw new GoogleAuthError("auth_store_failed"); }
      } else {
        // Google may omit a refresh token on repeat consent. Preserve a valid
        // saved token; never overwrite it with null or issue a connected session
        // on the first login without an offline grant.
        let saved: Awaited<ReturnType<AccountStore["loadEncryptedRefreshToken"]>>;
        try { saved = await dependencies.store.loadEncryptedRefreshToken(user.id); }
        catch { throw new GoogleAuthError("auth_store_failed"); }
        try {
          if (saved.email.toLowerCase() !== identity.email || !saved.ciphertext ||
              !decryptRefreshToken(Buffer.from(saved.ciphertext).toString("base64"), user.id, dependencies.encryptionKey).trim()) {
            throw new GoogleAuthError("google_reauth_required");
          }
        } catch { throw new GoogleAuthError("google_reauth_required"); }
      }
      return identityToken({ sub: user.id, appUserId: user.id, ...identity });
    },

    session({ session, token }): AppSession {
      const identity = identityToken(token);
      return {
        expires: session.expires,
        user: { id: identity.appUserId, email: identity.email, name: identity.name },
      };
    },
  };
}

/** Inject into googleClient; plaintext exists only for the server-side call. */
export function googleAccountLoader(dependencies: { store: AccountStore; encryptionKey: string }) {
  return async (userId: string): Promise<{ email: string; refreshToken: string }> => {
    let saved: Awaited<ReturnType<AccountStore["loadEncryptedRefreshToken"]>>;
    try { saved = await dependencies.store.loadEncryptedRefreshToken(userId); }
    catch (error) {
      throw new GoogleIntegrationError(error instanceof WorkflowError && error.code === "not_found" ? "google_reauth_required" : "google_request_failed");
    }
    try {
      if (!saved.ciphertext || !EMAIL.test(saved.email)) throw new Error();
      const refreshToken = decryptRefreshToken(Buffer.from(saved.ciphertext).toString("base64"), userId, dependencies.encryptionKey);
      if (!refreshToken.trim()) throw new Error();
      return { email: saved.email, refreshToken };
    } catch { throw new GoogleIntegrationError("google_reauth_required"); }
  };
}

// NextAuth's default logger can include provider metadata. Wire this logger and
// debug:false at the root auth entry; never forward the logger's raw arguments.
export const SAFE_AUTH_LOGGER: NonNullable<NextAuthOptions["logger"]> = {
  error() { console.error("auth_failed"); },
  warn() { console.warn("auth_warning"); },
  debug() {},
};
