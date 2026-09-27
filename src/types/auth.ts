/**
 * Types and interfaces for Authentication and Access Control (Phase 11).
 */

export type TokenScope = "read" | "write" | "admin";

export type RepoVisibility = "public" | "private";

export interface PersonalAccessToken {
  id: string; // e.g., "tok_abc123"
  name: string; // e.g., "MacBook Pro CLI"
  tokenHash: string; // Argon2id or bcrypt hash of the secret
  tokenPrefix: string; // e.g., "pat_xxxx..." (first 8 chars for identification)
  scopes: TokenScope[];
  createdAt: string; // ISO 8601
  expiresAt?: string; // Optional expiration ISO 8601
  lastUsedAt?: string;
}

export interface UserAccount {
  username: string; 
  email?: string; 
  role: "admin" | "user";
  tokens: PersonalAccessToken[];
  createdAt: string;
  updatedAt: string;
}

export interface RepoAccessPolicy {
  repoId: string; // e.g., "lambda-demo" or "milan/ondc-scrapper"
  owner: string; // Username of owner
  visibility: RepoVisibility; // "public" (free read, auth push) or "private" (auth read & push)
  collaborators?: Record<string, "read" | "write" | "admin">; // Specific user access overrides
  createdAt: string;
  updatedAt: string;
}

export interface AuthManifest {
  version: number;
  users: Record<string, UserAccount>; // Keyed by username
  repos: Record<string, RepoAccessPolicy>; // Keyed by repoId
  updatedAt: string;
}

export interface AuthContext {
  authenticated: boolean;
  user?: UserAccount;
  token?: PersonalAccessToken;
  error?: string;
}
