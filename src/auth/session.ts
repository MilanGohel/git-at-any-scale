/**
 * Stateless HMAC-SHA256 Session Token Management for Strata Git.
 * Provides tamper-proof session cookies without requiring a database or Redis cache.
 */

import { createHmac, timingSafeEqual } from "node:crypto";

export interface SessionPayload {
  username: string;
  role: "admin" | "user";
  email?: string;
  avatarUrl?: string;
  exp: number; // Unix timestamp in seconds
}

export class SessionManager {
  public static readonly COOKIE_NAME = "strata_session";
  private static readonly DEFAULT_SECRET = "strata-serverless-git-session-secret-key-2026";

  /**
   * Resolves the active session secret from environment variables.
   */
  public static getSecret(): string {
    return process.env.SESSION_SECRET || process.env.AUTH_SECRET || this.DEFAULT_SECRET;
  }

  /**
   * Signs a session payload into a cryptographically verified token: <base64url(payload)>.<signature>
   */
  public static sign(payload: Omit<SessionPayload, "exp">, expiresInSeconds: number = 7 * 24 * 3600): string {
    const fullPayload: SessionPayload = {
      ...payload,
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
    };

    const payloadJson = JSON.stringify(fullPayload);
    const encodedPayload = Buffer.from(payloadJson, "utf8").toString("base64url");
    const signature = this.createSignature(encodedPayload, this.getSecret());

    return `${encodedPayload}.${signature}`;
  }

  /**
   * Verifies and extracts the session payload. Returns null if invalid or expired.
   */
  public static verify(token: string): SessionPayload | null {
    if (!token || typeof token !== "string") return null;

    const parts = token.split(".");
    if (parts.length !== 2) return null;

    const [encodedPayload, providedSignature] = parts;
    if (!encodedPayload || !providedSignature) return null;

    const expectedSignature = this.createSignature(encodedPayload, this.getSecret());

    const provBuf = Buffer.from(providedSignature, "utf8");
    const expBuf = Buffer.from(expectedSignature, "utf8");

    if (provBuf.length !== expBuf.length || !timingSafeEqual(provBuf, expBuf)) {
      return null;
    }

    try {
      const json = Buffer.from(encodedPayload, "base64url").toString("utf8");
      const payload = JSON.parse(json) as SessionPayload;

      // Check expiration
      const now = Math.floor(Date.now() / 1000);
      if (payload.exp && payload.exp < now) {
        return null;
      }

      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Parses the active session directly from a standard Request object.
   */
  public static getSessionFromRequest(req: Request): SessionPayload | null {
    const cookieHeader = req.headers.get("cookie");
    if (!cookieHeader) return null;

    const cookies = cookieHeader.split(";");
    for (const cookie of cookies) {
      const [name, ...valParts] = cookie.trim().split("=");
      if (name === this.COOKIE_NAME) {
        const val = decodeURIComponent(valParts.join("="));
        return this.verify(val);
      }
    }

    return null;
  }

  /**
   * Generates a Set-Cookie header string to authenticate the user session.
   */
  public static createCookieHeader(sessionToken: string, isSecure: boolean = false): string {
    const secureFlag = isSecure ? "; Secure" : "";
    return `${this.COOKIE_NAME}=${encodeURIComponent(sessionToken)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800${secureFlag}`;
  }

  /**
   * Generates a Set-Cookie header string to clear/log out the user session.
   */
  public static clearCookieHeader(): string {
    return `${this.COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  private static createSignature(data: string, secret: string): string {
    return createHmac("sha256", secret).update(data).digest("base64url");
  }
}
