import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { SessionManager } from "../auth/session";
import { AuthStore } from "../auth/auth-store";
import { MockR2Storage } from "../storage/mock-r2";
import { GitHttpServer } from "../server/git-http-server";
import { GitRepoEngine } from "../engine/git-repo-engine";

describe("Phase 14: Web Authentication, Sessions & In-Browser PAT Management", () => {
  const testPort = 8994;
  const testDir = join(process.cwd(), ".sim_data", "test_web_auth");
  let storage: MockR2Storage;
  let authStore: AuthStore;
  let engine: GitRepoEngine;
  let server: GitHttpServer;

  beforeAll(async () => {
    storage = new MockR2Storage();
    authStore = new AuthStore(storage);
    engine = new GitRepoEngine({
      storage,
      reposDir: join(testDir, "server_repos"),
    });

    server = new GitHttpServer({
      port: testPort,
      storage,
      authStore,
      engine,
      dataDir: join(testDir, "server_repos"),
    });

    await server.start();
  });

  afterAll(async () => {
    server.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  describe("SessionManager Unit Tests", () => {
    test("should sign and verify session tokens with HMAC-SHA256", () => {
      const payload = {
        username: "milan",
        role: "admin" as const,
        email: "milan@example.com",
      };

      const token = SessionManager.sign(payload, 3600);
      expect(token).toBeDefined();
      expect(token).toContain(".");

      const verified = SessionManager.verify(token);
      expect(verified).not.toBeNull();
      expect(verified?.username).toBe("milan");
      expect(verified?.role).toBe("admin");
      expect(verified?.email).toBe("milan@example.com");
    });

    test("should reject tampered or expired session tokens", () => {
      const token = SessionManager.sign({ username: "eve", role: "user" }, 3600);
      const tampered = token.slice(0, -4) + "XXXX";
      expect(SessionManager.verify(tampered)).toBeNull();

      // Expired token (expires in -1 second)
      const expired = SessionManager.sign({ username: "bob", role: "user" }, -1);
      expect(SessionManager.verify(expired)).toBeNull();
    });
  });

  describe("AuthStore Password & OAuth Persistence", () => {
    test("should register a user with Argon2id password hash", async () => {
      const user = await authStore.registerUser({
        username: "developer_one",
        email: "dev1@strata.sh",
        password: "supersecretpassword123",
      });

      expect(user.username).toBe("developer_one");
      expect(user.passwordHash).toBeDefined();
      expect(user.passwordHash?.startsWith("$argon2id$")).toBe(true);

      // Verify password authentication
      const authed = await authStore.authenticateWithPassword("developer_one", "supersecretpassword123");
      expect(authed).toBeDefined();
      expect(authed?.username).toBe("developer_one");

      // Verify email authentication
      const authedByEmail = await authStore.authenticateWithPassword("dev1@strata.sh", "supersecretpassword123");
      expect(authedByEmail).toBeDefined();
      expect(authedByEmail?.username).toBe("developer_one");

      // Bad password
      const wrong = await authStore.authenticateWithPassword("developer_one", "wrongpassword");
      expect(wrong).toBeUndefined();
    });

    test("should link or create GitHub OAuth user account", async () => {
      const ghUser = await authStore.findOrCreateGitHubUser({
        id: 998877,
        login: "octocat",
        email: "octocat@github.com",
        avatar_url: "https://github.com/images/error/octocat_happy.gif",
      });

      expect(ghUser.username).toBe("octocat");
      expect(ghUser.githubId).toBe("998877");
      expect(ghUser.avatarUrl).toContain("octocat_happy.gif");

      // Second login with same GitHub ID should return existing user
      const secondLogin = await authStore.findOrCreateGitHubUser({
        id: 998877,
        login: "octocat",
      });
      expect(secondLogin.username).toBe("octocat");
    });
  });

  describe("Web Authentication & PAT Management HTTP Endpoints", () => {
    let sessionCookie: string;

    test("should render clean / login page without hero banner", async () => {
      const res = await fetch(`http://localhost:${testPort}/login`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Sign in to Strata Git");
      expect(html).toContain("Username or Email");
      expect(html).toContain("Password");
    });

    test("should register a user account over POST /register and receive session cookie", async () => {
      const form = new FormData();
      form.append("username", "webuser");
      form.append("email", "webuser@example.com");
      form.append("password", "securepwd123");

      const res = await fetch(`http://localhost:${testPort}/register`, {
        method: "POST",
        body: form,
        redirect: "manual",
      });

      expect(res.status).toBe(302);
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("strata_session=");

      sessionCookie = setCookie!.split(";")[0]!;
    });

    test("should render Home page with username in top navbar and NO hero banner", async () => {
      const res = await fetch(`http://localhost:${testPort}/`, {
        headers: {
          Accept: "text/html",
          Cookie: sessionCookie,
        },
      });

      expect(res.status).toBe(200);
      const html = await res.text();

      // Confirms hero is gone and repo list is present
      expect(html).not.toContain("panel-hero");
      expect(html).toContain("Hosted Repositories");
      expect(html).toContain("webuser");
      expect(html).toContain("Sign out");
    });

    test("should block unauthenticated access to /settings/tokens with redirect", async () => {
      const res = await fetch(`http://localhost:${testPort}/settings/tokens`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toContain("/login?redirect=/settings/tokens");
    });

    test("should render token settings page when authenticated", async () => {
      const res = await fetch(`http://localhost:${testPort}/settings/tokens`, {
        headers: { Cookie: sessionCookie },
      });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Personal Access Tokens");
      expect(html).toContain("Generate New Personal Access Token");
    });

    test("should generate a new PAT directly in browser via POST /api/tokens", async () => {
      const res = await fetch(`http://localhost:${testPort}/api/tokens`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Cookie: sessionCookie,
        },
        body: JSON.stringify({
          name: "Browser Key",
          scopes: ["read", "write"],
          expiresInDays: 30,
        }),
      });

      expect(res.status).toBe(201);
      const data = await res.json();
      expect(data.status).toBe("success");
      expect(data.rawToken).toMatch(/^pat_[a-f0-9]{48}$/);
      expect(data.token.name).toBe("Browser Key");
      expect(data.token.scopes).toEqual(["read", "write"]);

      // Verify token appears on settings page
      const settingsRes = await fetch(`http://localhost:${testPort}/settings/tokens`, {
        headers: { Cookie: sessionCookie },
      });
      const settingsHtml = await settingsRes.text();
      expect(settingsHtml).toContain("Browser Key");

      // Revoke the token
      const revokeRes = await fetch(`http://localhost:${testPort}/api/tokens/${data.token.id}/revoke`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          Cookie: sessionCookie,
        },
      });
      expect(revokeRes.status).toBe(200);
      const revokeData = await revokeRes.json();
      expect(revokeData.revoked).toBe(true);
    });

    test("should log out and clear session cookie on /logout", async () => {
      const res = await fetch(`http://localhost:${testPort}/logout`, {
        redirect: "manual",
      });
      expect(res.status).toBe(302);
      const setCookie = res.headers.get("set-cookie");
      expect(setCookie).toContain("strata_session=;");
      expect(setCookie).toContain("Max-Age=0");
    });
  });
});
