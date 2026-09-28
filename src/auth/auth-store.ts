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
    const maxRetries = 8;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      manifest.version += 1;
      manifest.updatedAt = new Date().toISOString();
      const bytes = new TextEncoder().encode(JSON.stringify(manifest, null, 2));

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
        // Full jitter exponential backoff
        const maxBackoff = Math.min(500, 25 * Math.pow(2, attempt));
        const delay = Math.floor(Math.random() * maxBackoff);
        await Bun.sleep(delay);

        const latest = await this.getManifest();
        manifest.version = latest.version;
        // Merge latest users/repos to prevent overwriting parallel modifications
        manifest.users = { ...latest.users, ...manifest.users };
        manifest.repos = { ...latest.repos, ...manifest.repos };
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
   * Authenticates a request using only a raw Personal Access Token (PAT).
   */
  async authenticateWithToken(rawToken: string): Promise<AuthContext> {
    const manifest = await this.getManifest();
    for (const user of Object.values(manifest.users)) {
      for (const token of user.tokens) {
        const isValid = await TokenManager.verifyToken(rawToken, token);
        if (isValid) {
          token.lastUsedAt = new Date().toISOString();
          this.saveManifest(manifest).catch(() => {});
          return {
            authenticated: true,
            user,
            token,
          };
        }
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
   * Registers a user account with optional Argon2id password hash or OAuth metadata.
   */
  async createUser(
    username: string,
    role: "admin" | "user" = "user",
    email?: string,
    password?: string
  ): Promise<UserAccount> {
    return this.registerUser({ username, role, email, password });
  }

  /**
   * Registers a new user account with validation, password hashing, and S3 Atomic CAS persistence.
   */
  async registerUser(params: {
    username: string;
    email?: string;
    password?: string;
    role?: "admin" | "user";
    githubId?: string;
    githubUsername?: string;
    avatarUrl?: string;
  }): Promise<UserAccount> {
    const key = params.username.toLowerCase().trim();
    if (!/^[a-zA-Z0-9_.-]+$/.test(key)) {
      throw new Error(`Invalid username '${params.username}'. Allowed: alphanumeric, dots, hyphens, and underscores.`);
    }

    const manifest = await this.getManifest();
    if (manifest.users[key]) {
      throw new Error(`User '${params.username}' already exists.`);
    }

    // First registered user automatically becomes admin if not specified
    const assignedRole = params.role || (Object.keys(manifest.users).length === 0 ? "admin" : "user");

    let passwordHash: string | undefined;
    if (params.password) {
      if (params.password.length < 6) {
        throw new Error("Password must be at least 6 characters.");
      }
      passwordHash = await Bun.password.hash(params.password, {
        algorithm: "argon2id",
        memoryCost: 19456,
        timeCost: 2,
      });
    }

    const now = new Date().toISOString();
    const user: UserAccount = {
      username: key,
      email: params.email?.trim(),
      passwordHash,
      githubId: params.githubId ? String(params.githubId) : undefined,
      githubUsername: params.githubUsername,
      avatarUrl: params.avatarUrl,
      role: assignedRole,
      tokens: [],
      createdAt: now,
      updatedAt: now,
    };

    manifest.users[key] = user;
    await this.saveManifest(manifest);
    return user;
  }

  /**
   * Authenticates a user using email or username + password.
   */
  async authenticateWithPassword(identifier: string, password: string): Promise<UserAccount | undefined> {
    if (!identifier || !password) return undefined;

    const manifest = await this.getManifest();
    const normalized = identifier.toLowerCase().trim();

    // Match by username or email
    let user: UserAccount | undefined = manifest.users[normalized];
    if (!user) {
      user = Object.values(manifest.users).find((u) => u.email?.toLowerCase().trim() === normalized);
    }

    if (!user || !user.passwordHash) {
      return undefined;
    }

    try {
      const isValid = await Bun.password.verify(password, user.passwordHash);
      return isValid ? user : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Finds an existing user linked to a GitHub account, or creates a new one via S3 Atomic CAS.
   * Security:
   * 1. Matches existing user by immutable githubId.
   * 2. Auto-links to an existing local account ONLY if the GitHub email is verified AND matches the existing account email.
   *    Never links based purely on username (prevents Pre-Account Takeover vulnerabilities).
   * 3. If username is already taken by an unlinked user with a different email, assigns a collision-free username.
   */
  async findOrCreateGitHubUser(ghUser: {
    id: string | number;
    login: string;
    email?: string;
    emailVerified?: boolean;
    avatar_url?: string;
  }): Promise<UserAccount> {
    const ghIdStr = String(ghUser.id);
    const manifest = await this.getManifest();

    // 1. Check if user already exists by immutable githubId
    const existingByGhId = Object.values(manifest.users).find((u) => u.githubId === ghIdStr);
    if (existingByGhId) {
      let updated = false;
      if (ghUser.avatar_url && existingByGhId.avatarUrl !== ghUser.avatar_url) {
        existingByGhId.avatarUrl = ghUser.avatar_url;
        updated = true;
      }
      if (ghUser.email && !existingByGhId.email) {
        existingByGhId.email = ghUser.email;
        updated = true;
      }
      if (ghUser.login && existingByGhId.githubUsername !== ghUser.login) {
        existingByGhId.githubUsername = ghUser.login;
        updated = true;
      }
      if (updated) {
        existingByGhId.updatedAt = new Date().toISOString();
        await this.saveManifest(manifest).catch(() => {});
      }
      return existingByGhId;
    }

    // 2. Secure Account Linking: ONLY if email is verified and matches an existing account
    const verifiedEmail = ghUser.emailVerified !== false && ghUser.email ? ghUser.email.toLowerCase().trim() : undefined;
    if (verifiedEmail) {
      const existingByEmail = Object.values(manifest.users).find(
        (u) => u.email && u.email.toLowerCase().trim() === verifiedEmail && !u.githubId
      );
      if (existingByEmail) {
        existingByEmail.githubId = ghIdStr;
        existingByEmail.githubUsername = ghUser.login;
        if (ghUser.avatar_url) existingByEmail.avatarUrl = ghUser.avatar_url;
        existingByEmail.updatedAt = new Date().toISOString();
        await this.saveManifest(manifest);
        return existingByEmail;
      }
    }

    // 3. Create a new user account linked to GitHub.
    // If the username is already taken by an existing user with a different email, assign a distinct handle!
    const baseUsername = ghUser.login.toLowerCase().trim();
    let targetUsername = baseUsername;
    if (manifest.users[targetUsername]) {
      targetUsername = `${baseUsername}-gh`;
      if (manifest.users[targetUsername]) {
        targetUsername = `${baseUsername}-${ghIdStr.slice(-4)}`;
      }
    }

    return this.registerUser({
      username: targetUsername,
      email: ghUser.email,
      githubId: ghIdStr,
      githubUsername: ghUser.login,
      avatarUrl: ghUser.avatar_url,
      role: Object.keys(manifest.users).length === 0 ? "admin" : "user",
    });
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
   * Fetches a user by username.
   */
  async getUser(username: string): Promise<UserAccount | undefined> {
    const manifest = await this.getManifest();
    return manifest.users[username.toLowerCase().trim()];
  }

  /**
   * Lists all users.
   */
  async listUsers(): Promise<UserAccount[]> {
    const manifest = await this.getManifest();
    return Object.values(manifest.users);
  }
}
