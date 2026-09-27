import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2";
import { TokenManager } from "../auth/token-manager";
import { AuthStore } from "../auth/auth-store";
import { GitHttpServer } from "../server/git-http-server";
import { runGit } from "../engine/git-process";

describe("Phase 11: Authentication & Access Control (Tokens, Basic Auth & Namespaces)", () => {
  const TEST_DIR = "./.sim_data/test_auth";
  const SERVER_REPOS = join(TEST_DIR, "server_repos");
  const CLIENT_DIR = join(TEST_DIR, "client_repo");
  const CLONE_DIR = join(TEST_DIR, "clone_repo");
  const TEST_PORT = 8998;

  let storage: MockR2Storage;
  let authStore: AuthStore;
  let server: GitHttpServer;

  beforeEach(async () => {
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
    await mkdir(SERVER_REPOS, { recursive: true });
    await mkdir(CLIENT_DIR, { recursive: true });

    storage = new MockR2Storage();
    authStore = new AuthStore(storage);
    server = new GitHttpServer({
      port: TEST_PORT,
      host: "127.0.0.1",
      storage,
      dataDir: SERVER_REPOS,
      authStore,
    });
    await server.start();
  });

  afterEach(async () => {
    server.stop();
    await rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
  });

  describe("TokenManager Unit Tests", () => {
    it("should generate a secure raw token and valid Argon2id hash", async () => {
      const { rawToken, token } = await TokenManager.generateToken({
        name: "Test Token",
        scopes: ["read", "write"],
      });

      expect(rawToken.startsWith("pat_")).toBe(true);
      expect(rawToken.length).toBeGreaterThan(30);
      expect(token.name).toBe("Test Token");
      expect(token.scopes).toEqual(["read", "write"]);
      expect(token.tokenHash.length).toBeGreaterThan(20);

      const isValid = await TokenManager.verifyToken(rawToken, token);
      expect(isValid).toBe(true);

      const isInvalid = await TokenManager.verifyToken("pat_wrongsecret", token);
      expect(isInvalid).toBe(false);
    });

    it("should reject expired tokens", async () => {
      const { rawToken, token } = await TokenManager.generateToken({
        name: "Expiring Token",
      });

      // Manually set expiration in the past
      token.expiresAt = new Date(Date.now() - 10000).toISOString();

      const isValid = await TokenManager.verifyToken(rawToken, token);
      expect(isValid).toBe(false);
    });

    it("should correctly validate scopes", async () => {
      const { token: readToken } = await TokenManager.generateToken({
        name: "Read Token",
        scopes: ["read"],
      });
      const { token: writeToken } = await TokenManager.generateToken({
        name: "Write Token",
        scopes: ["write"],
      });
      const { token: adminToken } = await TokenManager.generateToken({
        name: "Admin Token",
        scopes: ["admin"],
      });

      expect(TokenManager.hasScope(readToken, "read")).toBe(true);
      expect(TokenManager.hasScope(readToken, "write")).toBe(false);

      expect(TokenManager.hasScope(writeToken, "read")).toBe(true);
      expect(TokenManager.hasScope(writeToken, "write")).toBe(true);

      // Admin has all scopes
      expect(TokenManager.hasScope(adminToken, "read")).toBe(true);
      expect(TokenManager.hasScope(adminToken, "write")).toBe(true);
      expect(TokenManager.hasScope(adminToken, "admin")).toBe(true);
    });
  });

  describe("AuthStore Persistence & Access Control", () => {
    it("should manage users, tokens, and repo policies in storage with Atomic CAS", async () => {
      const user = await authStore.createUser("milan", "admin");
      expect(user.username).toBe("milan");
      expect(user.role).toBe("admin");

      const { rawToken, token } = await authStore.createTokenForUser({
        username: "milan",
        tokenName: "Laptop",
        scopes: ["read", "write"],
      });

      expect(token.name).toBe("Laptop");

      // Verify authentication
      const auth = await authStore.authenticate("milan", rawToken);
      expect(auth.authenticated).toBe(true);
      expect(auth.user?.username).toBe("milan");
      expect(auth.token?.id).toBe(token.id);

      // Wrong token
      const failedAuth = await authStore.authenticate("milan", "pat_invalid");
      expect(failedAuth.authenticated).toBe(false);

      // Wrong user
      const wrongUser = await authStore.authenticate("unknown", rawToken);
      expect(wrongUser.authenticated).toBe(false);

      // Token revocation
      const revoked = await authStore.revokeToken("milan", token.id);
      expect(revoked).toBe(true);
      const postRevoke = await authStore.authenticate("milan", rawToken);
      expect(postRevoke.authenticated).toBe(false);
    });
  });

  describe("Native Git CLI HTTP Server Integration Tests", () => {
    it("should enforce authentication for private repositories and allow authorized Git pushes", async () => {
      // 1. Create admin user 'milan' and collaborator 'alice'
      await authStore.createUser("milan", "admin");
      const { rawToken: milanToken } = await authStore.createTokenForUser({
        username: "milan",
        tokenName: "Milan Key",
        scopes: ["read", "write"],
      });

      await authStore.createUser("alice", "user");
      const { rawToken: aliceToken } = await authStore.createTokenForUser({
        username: "alice",
        tokenName: "Alice ReadOnly",
        scopes: ["read"],
      });

      // 2. Set repository 'vault' as private, owned by 'milan'
      await authStore.setRepoPolicy({
        repoId: "vault",
        owner: "milan",
        visibility: "private",
        collaborators: {
          alice: "read", // Alice can read, but cannot write
        },
      });

      // 3. Initialize local client repository
      await runGit(["init", "-b", "main"], { cwd: CLIENT_DIR });
      await Bun.write(join(CLIENT_DIR, "secret.txt"), "Classified Content");
      await runGit(["add", "."], { cwd: CLIENT_DIR });
      await runGit(["commit", "-m", "init: secure commit"], { cwd: CLIENT_DIR });

      // 4. Test Unauthenticated push -> must fail with HTTP 401
      const unauthPush = runGit(
        ["push", `http://127.0.0.1:${TEST_PORT}/vault.git`, "main"],
        { cwd: CLIENT_DIR }
      );
      await expect(unauthPush).rejects.toThrow();

      // 5. Test Authenticated push by owner 'milan' -> must SUCCEED!
      const milanRemote = `http://milan:${milanToken}@127.0.0.1:${TEST_PORT}/vault.git`;
      await runGit(["remote", "add", "origin", milanRemote], { cwd: CLIENT_DIR });
      const pushOutput = await runGit(["push", "-u", "origin", "main"], { cwd: CLIENT_DIR });
      expect(pushOutput).toBeDefined();

      // Verify S3 WAL holds the commit
      const walRes = await storage.getObject("vault/wal_index.json");
      expect(walRes.status).toBe(200);

      // 6. Test Unauthenticated clone on private repo -> must fail with 401
      const unauthClone = runGit(
        ["clone", `http://127.0.0.1:${TEST_PORT}/vault.git`, CLONE_DIR]
      );
      await expect(unauthClone).rejects.toThrow();

      // 7. Test Authenticated clone by 'alice' (collaborator with read scope) -> must SUCCEED!
      const aliceCloneRemote = `http://alice:${aliceToken}@127.0.0.1:${TEST_PORT}/vault.git`;
      await runGit(["clone", aliceCloneRemote, CLONE_DIR]);
      const cloneSecret = await Bun.file(join(CLONE_DIR, "secret.txt")).text();
      expect(cloneSecret).toBe("Classified Content");

      // 8. Test Authenticated push by 'alice' (read-only scope) -> must FAIL with 403 Forbidden!
      await Bun.write(join(CLONE_DIR, "hacked.txt"), "unauthorized write");
      await runGit(["add", "."], { cwd: CLONE_DIR });
      await runGit(["commit", "-m", "evil: write attempt"], { cwd: CLONE_DIR });

      const alicePush = runGit(["push", "origin", "main"], { cwd: CLONE_DIR });
      await expect(alicePush).rejects.toThrow();
    });

    it("should support multi-tenant namespace paths (e.g. milan/project-x.git)", async () => {
      await authStore.createUser("milan", "admin");
      const { rawToken } = await authStore.createTokenForUser({
        username: "milan",
        tokenName: "CLI",
      });

      const multiDir = join(TEST_DIR, "multi_client");
      await mkdir(multiDir, { recursive: true });
      await runGit(["init", "-b", "main"], { cwd: multiDir });
      await Bun.write(join(multiDir, "app.ts"), "console.log('Multi-tenant');");
      await runGit(["add", "."], { cwd: multiDir });
      await runGit(["commit", "-m", "feat: initial commit in namespace"], { cwd: multiDir });

      const repoUrl = `http://milan:${rawToken}@127.0.0.1:${TEST_PORT}/milan/project-x.git`;
      await runGit(["remote", "add", "origin", repoUrl], { cwd: multiDir });
      const pushOut = await runGit(["push", "-u", "origin", "main"], { cwd: multiDir });
      expect(pushOut).toBeDefined();

      // Verify WAL index created under 'milan/project-x'
      const walRes = await storage.getObject("milan/project-x/wal_index.json");
      expect(walRes.status).toBe(200);
    });

    it("should support path-based token authentication (/t/<token>/<repo>.git)", async () => {
      await authStore.createUser("milan", "admin");
      const { rawToken } = await authStore.createTokenForUser({
        username: "milan",
        tokenName: "PathToken",
      });

      // Set repo to private
      await authStore.setRepoPolicy({
        repoId: "token-vault",
        owner: "milan",
        visibility: "private",
      });

      const tokenDir = join(TEST_DIR, "token_client");
      await mkdir(tokenDir, { recursive: true });
      await runGit(["init", "-b", "main"], { cwd: tokenDir });
      await Bun.write(join(tokenDir, "token.txt"), "authenticated via url path");
      await runGit(["add", "."], { cwd: tokenDir });
      await runGit(["commit", "-m", "init: url token"], { cwd: tokenDir });

      // Push using path-based token: /t/<pat_...>/<repo>.git
      const repoUrl = `http://127.0.0.1:${TEST_PORT}/t/${rawToken}/token-vault.git`;
      await runGit(["remote", "add", "origin", repoUrl], { cwd: tokenDir });
      const pushOut = await runGit(["push", "-u", "origin", "main"], { cwd: tokenDir });
      expect(pushOut).toBeDefined();

      // Clone using path-based token
      const tokenCloneDir = join(TEST_DIR, "token_clone");
      await runGit(["clone", repoUrl, tokenCloneDir]);
      const content = await Bun.file(join(tokenCloneDir, "token.txt")).text();
      expect(content).toBe("authenticated via url path");
    });
  });
});
