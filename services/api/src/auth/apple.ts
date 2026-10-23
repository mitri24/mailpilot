import { createHash } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { ApiError } from "../errors.js";

const APPLE_ISSUER = "https://appleid.apple.com";
const APPLE_KEYS_URL = new URL("https://appleid.apple.com/auth/keys");

export interface AppleIdentity {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

/**
 * Verifies a Sign in with Apple identity token server-side: signature against Apple's JWKS,
 * issuer, audience (our bundle ids), expiry and the nonce the app generated for this request.
 */
export class AppleTokenVerifier {
  private readonly keys: JWTVerifyGetKey;

  constructor(
    private readonly audiences: string[],
    keys?: JWTVerifyGetKey,
  ) {
    this.keys = keys ?? createRemoteJWKSet(APPLE_KEYS_URL, { cooldownDuration: 60_000 });
  }

  async verify(identityToken: string, rawNonce: string): Promise<AppleIdentity> {
    if (this.audiences.length === 0) {
      throw new ApiError(503, "apple_not_configured", "Sign in with Apple ist auf dem Server nicht konfiguriert (APPLE_AUDIENCES)");
    }
    let payload;
    try {
      ({ payload } = await jwtVerify(identityToken, this.keys, {
        issuer: APPLE_ISSUER,
        audience: this.audiences,
        algorithms: ["RS256"],
      }));
    } catch (error) {
      throw new ApiError(401, "apple_token_invalid", "Apple-Anmeldung konnte nicht bestätigt werden", {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    const expectedNonce = createHash("sha256").update(rawNonce).digest("hex");
    if (payload.nonce !== expectedNonce) {
      throw new ApiError(401, "apple_nonce_mismatch", "Apple-Anmeldung passt nicht zu dieser Anfrage");
    }
    if (typeof payload.sub !== "string" || payload.sub.length === 0) {
      throw new ApiError(401, "apple_token_invalid", "Apple-Anmeldung ohne Benutzerkennung");
    }
    const email = typeof payload.email === "string" ? payload.email : null;
    const emailVerified = payload.email_verified === true || payload.email_verified === "true";
    return { sub: payload.sub, email, emailVerified };
  }
}
