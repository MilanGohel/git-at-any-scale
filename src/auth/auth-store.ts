import type { R2StorageInterface } from "../types/storage";
import type {
  AuthManifest,
  AuthContext,
  UserAccount,
  PersonalAccessToken,
  RepoAccessPolicy,
  RepoVisibility,
  TokenScope,
} from "../types/auth";
import { TokenManager } from "./token-manager";

export class AuthStore {
  private static readonly MANIFEST_KEY = "_auth/auth_manifest.json";
  private cachedManifest?: AuthManifest;
  private cachedETag?: string;

  constructor(private readonly storage: R2StorageInterface) {}

  /**
   * Initializes an empty AuthManifest if one does not already exist.
   */
  async init(): Promise<AuthManifest> {
    return this.getManifest();
  }

  /**
   * Loads the current AuthManifest from S3/R2 storage with ETag cache validation.
   */
  async getManifest(): Promise<AuthManifest> {
    const res = await this.storage.getObject(AuthStore.MANIFEST_KEY, {
      ifNoneMatch: this.cachedETag,
    });

    if (res.status === 304 && this.cachedManifest) {
      return this.cachedManifest;
    }

    if (res.status === 200 && res.data) {
      const text = new TextDecoder().decode(res.data);
      this.cachedManifest = JSON.parse(text) as AuthManifest;
      this.cachedETag = res.etag;
      return this.cachedManifest;
    }

    // Default empty manifest if not yet created in storage
    const emptyManifest: AuthManifest = {
      version: 1,
      users: {},
      repos: {},
      updatedAt: new Date().toISOString(),
    };

    return emptyManifest;
  }

  /**
   * Saves the manifest to storage using Atomic Compare-And-Swap (CAS).
   */
  async saveManifest(manifest: AuthManifest): Promise<void> {
    manifest.version += 1;
    manifest.updatedAt = new Date().toISOString();
    const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

    for (let attempt = 1; attempt <= 5; attempt++) {
      const getRes = await this.storage.getObject(AuthStore.MANIFEST_KEY);
      let ifMatchHeader = "NONE";
      if (getRes.status === 200 && getRes.etag) {
        ifMatchHeader = getRes.etag;
      }

      const putRes = await this.storage.putObject(AuthStore.MANIFEST_KEY, bytes, {
        ifMatch: ifMatchHeader,
      });

      if (putRes.status === 200) {
        this.cachedManifest = manifest;
        this.cachedETag = putRes.etag;
        return;
      }

      if (putRes.status === 412) {
        // Concurrent update race, reload and retry
        await Bun.sleep(25 * attempt);
        const latest = await this.getManifest();
        manifest.version = latest.version + 1;
        continue;
      }

      throw new Error(`Failed to save auth manifest to storage: ${putRes.status} ${putRes.error || ""}`);
    }

    throw new Error("Exceeded maximum retries saving auth manifest due to concurrent CAS conflicts");
  }

  /**
   * Authenticates a user with username and raw Personal Access Token (PAT).
   */
  async authenticate(username: string, rawToken: string): Promise<AuthContext> {
    const manifest = await this.getManifest();
    const user = manifest.users[username.toLowerCase()];

    if (!user) {
      return { authenticated: false, error: "User not found" };
    }

    for (const token of user.tokens) {
      const isValid = await TokenManager.verifyToken(rawToken, token);
      if (isValid) {
        token.lastUsedAt = new Date().toISOString();
        // Optimistically update lastUsedAt in the background without blocking
        this.saveManifest(manifest).catch(() => {});
        return {
          authenticated: true,
          user,
          token,
        };
      }
    }

    return { authenticated: false, error: "Invalid token" };
  }

  /**
   * Checks whether a request (read or write) is allowed on the specified repository.
   */
  async checkAccess(params: {
    repoId: string;
    isWrite: boolean;
    authContext?: AuthContext;
  }): Promise<{ allowed: boolean; status: number; reason: string }> {
    const manifest = await this.getManifest();
    const hasUsers = Object.keys(manifest.users).length > 0;

    // If no users have been configured yet, allow open bootstrapping
    if (!hasUsers) {
      return { allowed: true, status: 200, reason: "Open bootstrapping mode (no users configured)" };
    }

    const { repoId, isWrite, authContext } = params;
    const policy = manifest.repos[repoId];

    // Case 1: Unregistered repository
    if (!policy) {
      if (!isWrite) {
        // Read on repo without explicit policy: allowed if not explicitly private
        return { allowed: true, status: 200, reason: "Public read allowed" };
      }

      // Write on unregistered repo: must be authenticated
      if (!authContext?.authenticated || !authContext.user || !authContext.token) {
        return {
          allowed: false,
          status: 401,
          reason: "Authentication required to create or push to a new repository",
        };
      }

      if (!TokenManager.hasScope(authContext.token, "write")) {
        return {
          allowed: false,
          status: 403,
          reason: "Token lacks required 'write' scope",
        };
      }

      return { allowed: true, status: 200, reason: "Authorized to create repository" };
    }

    // Case 2: Registered Repository with explicit policy
    if (policy.visibility === "public" && !isWrite) {
      return { allowed: true, status: 200, reason: "Public read allowed" };
    }

    // All private reads and all writes require authentication!
    if (!authContext?.authenticated || !authContext.user || !authContext.token) {
      return {
        allowed: false,
        status: 401,
        reason: policy.visibility === "private"
          ? "Authentication required for private repository"
          : "Authentication required to push commits",
      };
    }

    const username = authContext.user.username.toLowerCase();
    const isOwner = policy.owner.toLowerCase() === username;
    const isAdmin = authContext.user.role === "admin";
    const collaboratorRole = policy.collaborators?.[username];

    // Check write permissions
    if (isWrite) {
      if (!TokenManager.hasScope(authContext.token, "write")) {
        return {
          allowed: false,
          status: 403,
          reason: "Token lacks required 'write' scope",
        };
      }

      if (isOwner || isAdmin || collaboratorRole === "write" || collaboratorRole === "admin") {
        return { allowed: true, status: 200, reason: "Write authorized" };
      }

      return {
        allowed: false,
        status: 403,
        reason: `User '${username}' does not have write permissions for repository '${repoId}'`,
      };
    }

    // Check read permissions for private repo
    if (!TokenManager.hasScope(authContext.token, "read")) {
      return {
        allowed: false,
        status: 403,
        reason: "Token lacks required 'read' scope",
      };
    }

    if (isOwner || isAdmin || collaboratorRole !== undefined) {
      return { allowed: true, status: 200, reason: "Read authorized" };
    }

    return {
      allowed: false,
      status: 403,
      reason: `User '${username}' does not have read permissions for repository '${repoId}'`,
    };
  }

  /**
   * Registers a user account.
   */
  async createUser(username: string, role: "admin" | "user" = "user"): Promise<UserAccount> {
    const key = username.toLowerCase().trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
      throw new Error(`Invalid username '${username}'. Allowed: alphanumeric, hyphens, and underscores.`);
    }

    const manifest = await this.getManifest();
    if (manifest.users[key]) {
      throw new Error(`User '${username}' already exists.`);
    }

    const now = new Date().toISOString();
    const user: UserAccount = {
      username: key,
      role,
      tokens: [],
      createdAt: now,
      updatedAt: now,
    };

    manifest.users[key] = user;
    await this.saveManifest(manifest);
    return user;
  }

  /**
   * Generates and attaches a Personal Access Token (PAT) for a user.
   */
  async createTokenForUser(params: {
    username: string;
    tokenName: string;
    scopes?: TokenScope[];
    expiresInDays?: number;
  }): Promise<{ rawToken: string; token: PersonalAccessToken }> {
    const key = params.username.toLowerCase().trim();
    const manifest = await this.getManifest();
    const user = manifest.users[key];

    if (!user) {
      throw new Error(`User '${params.username}' not found.`);
    }

    const { rawToken, token } = await TokenManager.generateToken({
      name: params.tokenName,
      scopes: params.scopes,
      expiresInDays: params.expiresInDays,
    });

    user.tokens.push(token);
    user.updatedAt = new Date().toISOString();
    await this.saveManifest(manifest);

    return { rawToken, token };
  }

  /**
   * Revokes a token by ID for a user.
   */
  async revokeToken(username: string, tokenId: string): Promise<boolean> {
    const key = username.toLowerCase().trim();
    const manifest = await this.getManifest();
    const user = manifest.users[key];

    if (!user) return false;

    const initialLen = user.tokens.length;
    user.tokens = user.tokens.filter((t) => t.id !== tokenId);

    if (user.tokens.length !== initialLen) {
      user.updatedAt = new Date().toISOString();
      await this.saveManifest(manifest);
      return true;
    }

    return false;
  }

  /**
   * Sets or updates access policy for a repository.
   */
  async setRepoPolicy(params: {
    repoId: string;
    owner: string;
    visibility: RepoVisibility;
    collaborators?: Record<string, "read" | "write" | "admin">;
  }): Promise<RepoAccessPolicy> {
    const manifest = await this.getManifest();
    const now = new Date().toISOString();
    const existing = manifest.repos[params.repoId];

    const policy: RepoAccessPolicy = {
      repoId: params.repoId,
      owner: params.owner.toLowerCase(),
      visibility: params.visibility,
      collaborators: params.collaborators || existing?.collaborators || {},
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };

    manifest.repos[params.repoId] = policy;
    await this.saveManifest(manifest);
    return policy;
  }

  /**
   * Lists all users.
   */
  async listUsers(): Promise<UserAccount[]> {
    const manifest = await this.getManifest();
    return Object.values(manifest.users);
  }
}
