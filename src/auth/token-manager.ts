import { randomBytes } from "crypto";
import type { PersonalAccessToken, TokenScope } from "../types/auth";

export class TokenManager {
  /**
   * Generates a new Personal Access Token (PAT).
   * Returns the raw secret (only visible once) and the token entity with the secure hash.
   */
  static async generateToken(params: {
    name: string;
    scopes?: TokenScope[];
    expiresInDays?: number;
  }): Promise<{ rawToken: string; token: PersonalAccessToken }> {
    const rawSecret = `pat_${randomBytes(24).toString("hex")}`;
    const tokenHash = await Bun.password.hash(rawSecret, {
      algorithm: "argon2id",
      memoryCost: 19456,
      timeCost: 2,
    });

    const now = new Date();
    let expiresAt: string | undefined;
    if (params.expiresInDays && params.expiresInDays > 0) {
      const exp = new Date(now.getTime() + params.expiresInDays * 24 * 60 * 60 * 1000);
      expiresAt = exp.toISOString();
    }

    const token: PersonalAccessToken = {
      id: `tok_${randomBytes(6).toString("hex")}`,
      name: params.name,
      tokenHash,
      tokenPrefix: `${rawSecret.slice(0, 10)}...`,
      scopes: params.scopes && params.scopes.length > 0 ? params.scopes : ["read", "write"],
      createdAt: now.toISOString(),
      expiresAt,
    };

    return { rawToken: rawSecret, token };
  }

  /**
   * Verifies a raw token against a stored token entity.
   */
  static async verifyToken(
    rawToken: string,
    storedToken: PersonalAccessToken
  ): Promise<boolean> {
    // Check expiration
    if (storedToken.expiresAt) {
      const expiresAt = new Date(storedToken.expiresAt).getTime();
      if (Date.now() > expiresAt) {
        return false;
      }
    }

    // Verify cryptographic hash
    try {
      return await Bun.password.verify(rawToken, storedToken.tokenHash);
    } catch {
      return false;
    }
  }

  /**
   * Checks whether a token has the required scope.
   * Note: "admin" scope automatically implies "read" and "write".
   */
  static hasScope(token: PersonalAccessToken, requiredScope: TokenScope): boolean {
    if (token.scopes.includes("admin")) {
      return true;
    }
    if (requiredScope === "read" && (token.scopes.includes("read") || token.scopes.includes("write"))) {
      return true;
    }
    return token.scopes.includes(requiredScope);
  }
}
