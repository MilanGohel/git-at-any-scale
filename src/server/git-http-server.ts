/**
 * Git Smart HTTP Server Daemon for EC2 & AWS Serverless Lambda Hosting
 *
 * Implements:
 * 1. Official Git Smart HTTP protocol (git-upload-pack & git-receive-pack)
 * 2. Minimalist Web UI & Repository Explorer ("Mini-GitHub", Phase 13)
 * 3. Asynchronous Auto-Compaction & API triggers (Phase 12)
 * 4. Token & Basic Auth Access Control (Phase 11)
 */

import { mkdir, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { R2StorageInterface } from "../types/storage.ts";
import type { AuthContext } from "../types/auth.ts";
import { AuthStore } from "../auth/auth-store.ts";
import { AwsS3Storage } from "../storage/aws-s3.ts";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { GitRepoEngine } from "../engine/git-repo-engine.ts";
import { compactRepository, compactAllRepositories } from "../workers/compaction-worker.ts";
import { GitReader } from "../ui/git-reader.ts";
import { SessionManager, type SessionPayload } from "../auth/session.ts";
import {
  renderHome,
  renderTokensGuide,
  renderLogin,
  renderRegister,
  renderTokenSettings,
  renderRepoOverview,
  renderSubTree,
  renderBlobView,
  renderCommitsView,
  renderAuthGate,
  type RepoContext,
  type CurrentUser,
} from "../ui/views.ts";

export interface GitServerOptions {
  port?: number;
  host?: string;
  storage: R2StorageInterface;
  dataDir?: string;
  authStore?: AuthStore;
  engine?: GitRepoEngine;
}

export class GitHttpServer {
  public readonly port: number;
  public readonly host: string;
  public readonly storage: R2StorageInterface;
  public readonly reposDir: string;
  public readonly authStore: AuthStore;
  public readonly engine: GitRepoEngine;
  private server?: ReturnType<typeof Bun.serve>;

  constructor(options: GitServerOptions) {
    this.port = options.port || Number(process.env.PORT) || 3000;
    this.host = options.host || "0.0.0.0";
    this.storage = options.storage;
    this.reposDir = resolve(options.dataDir || process.env.GIT_DATA_DIR || "./.sim_data/ec2_server/repos");
    this.authStore = options.authStore || new AuthStore(this.storage);
    this.engine = options.engine || new GitRepoEngine({
      storage: this.storage,
      reposDir: this.reposDir,
    });
  }

  async start(): Promise<void> {
    await mkdir(this.reposDir, { recursive: true });

    this.server = Bun.serve({
      port: this.port,
      hostname: this.host,
      fetch: this.handleRequest.bind(this),
    });

    console.log(`\n================================================================================`);
    console.log(` 🚀 GIT SMART HTTP & WEB EXPLORER ACTIVE`);
    console.log(`================================================================================`);
    console.log(`  - URL:         http://${this.host}:${this.port}/`);
    console.log(`  - Repos Root:  ${this.reposDir}`);
    console.log(`  - Storage:     ${this.storage.constructor.name}`);
    console.log(`  - Features:    Git CLI Smart HTTP + Web UI Explorer + Auto-Compaction`);
    console.log(`\nReady to accept:`);
    console.log(`  Web Explorer:  http://${this.host === "0.0.0.0" ? "localhost" : this.host}:${this.port}/<repo-id>`);
    console.log(`  Git Clone:     git clone http://${this.host === "0.0.0.0" ? "localhost" : this.host}:${this.port}/<repo-id>.git`);
    console.log(`================================================================================\n`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = undefined;
    }
  }

  getRepoPath(repoId: string): string {
    return this.engine.getRepoPath(repoId);
  }

  async ensureRepoReady(repoId: string, isWrite: boolean): Promise<boolean> {
    return this.engine.ensureRepoReady(repoId, isWrite);
  }

  async syncPushToS3(repoId: string, prePacks: Set<string>): Promise<{ version: number; packfiles: string[] } | null> {
    return this.engine.syncPushToS3(repoId, prePacks);
  }

  private parseCookie(req: Request, name: string): string | undefined {
    const cookieHeader = req.headers.get("cookie");
    if (!cookieHeader) return undefined;
    const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
    return match ? decodeURIComponent(match[1]!) : undefined;
  }

  private parseBasicAuth(req: Request): { username: string; token: string } | null {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return null;
    }
    try {
      const base64 = authHeader.slice(6).trim();
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx === -1) return null;
      return {
        username: decoded.slice(0, colonIdx),
        token: decoded.slice(colonIdx + 1),
      };
    } catch {
      return null;
    }
  }

  /**
   * Main HTTP request router for the Git server and Web Explorer.
   */
  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    const host = req.headers.get("host") || `${this.host}:${this.port}`;
    const proto = req.headers.get("x-forwarded-proto") || (host.includes("lambda-url") ? "https" : "http");
    const serverUrl = `${proto}://${host}`;
    const isSecure = proto === "https";

    const session = SessionManager.getSessionFromRequest(req);
    const currentUser: CurrentUser | undefined = session
      ? { username: session.username, avatarUrl: session.avatarUrl, role: session.role }
      : undefined;

    // Home route: browser view vs healthcheck
    if (pathname === "/") {
      if (req.headers.get("accept")?.includes("text/html")) {
        const manifest = await this.authStore.getManifest().catch(() => undefined);
        const repoMap = new Map<string, { repoId: string; visibility: string; owner?: string }>();
        if (manifest) {
          for (const [id, pol] of Object.entries(manifest.repos)) {
            const derivedOwner = pol.owner || (id.includes("/") ? id.split("/")[0] : "milan");
            repoMap.set(id, { repoId: id, visibility: pol.visibility, owner: derivedOwner });
          }
        }
        try {
          const allObjects = await this.storage.listObjects("");
          for (const key of allObjects) {
            if (key.endsWith("/wal_index.json")) {
              const repoId = key.slice(0, -"/wal_index.json".length);
              if (repoId && !repoMap.has(repoId)) {
                const derivedOwner = repoId.includes("/") ? repoId.split("/")[0] : "milan";
                repoMap.set(repoId, { repoId, visibility: "public", owner: derivedOwner });
              }
            }
          }
        } catch {
          // ignore storage listing errors
        }

        return new Response(renderHome(Array.from(repoMap.values()), serverUrl, currentUser), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    }

    // Healthcheck endpoint
    if (pathname === "/health" || pathname === "/") {
      const manifest = await this.authStore.getManifest().catch(() => undefined);
      return new Response(
        JSON.stringify({
          status: "healthy",
          server: "Strata Git Server",
          version: "1.3.0",
          storage: this.storage.constructor.name,
          engine: {
            name: "GitRepoEngine",
            maxDiskMb: Math.round(this.engine.maxDiskBytes / 1024 / 1024),
            compactionThreshold: this.engine.compactionThreshold,
          },
          auth: {
            enabled: Boolean(manifest && Object.keys(manifest.users).length > 0),
            userCount: manifest ? Object.keys(manifest.users).length : 0,
            repoCount: manifest ? Object.keys(manifest.repos).length : 0,
          },
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // ─── AUTHENTICATION ROUTES ─────────────────────────────────────────────

    // Sign In (GET /login, POST /login)
    if (pathname === "/login") {
      const redirect = url.searchParams.get("redirect") || "/";
      const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID);

      if (req.method === "GET") {
        if (currentUser) {
          return new Response(null, { status: 302, headers: { Location: redirect } });
        }
        return new Response(renderLogin({ redirect, githubEnabled }), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "POST") {
        const form = await req.formData().catch(() => null);
        const identifier = form?.get("identifier")?.toString() || "";
        const password = form?.get("password")?.toString() || "";
        const formRedirect = form?.get("redirect")?.toString() || redirect;

        const user = await this.authStore.authenticateWithPassword(identifier, password);
        if (!user) {
          return new Response(
            renderLogin({
              error: "Invalid username/email or password.",
              redirect: formRedirect,
              githubEnabled,
            }),
            { status: 401, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        const sessionToken = SessionManager.sign({
          username: user.username,
          role: user.role,
          email: user.email,
          avatarUrl: user.avatarUrl,
        });

        return new Response(null, {
          status: 302,
          headers: {
            Location: formRedirect,
            "Set-Cookie": SessionManager.createCookieHeader(sessionToken, isSecure),
          },
        });
      }
    }

    // Sign Up / Register (GET /register, POST /register)
    if (pathname === "/register") {
      const redirect = url.searchParams.get("redirect") || "/";
      const githubEnabled = Boolean(process.env.GITHUB_CLIENT_ID);

      if (req.method === "GET") {
        if (currentUser) {
          return new Response(null, { status: 302, headers: { Location: redirect } });
        }
        return new Response(renderRegister({ redirect, githubEnabled }), {
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }

      if (req.method === "POST") {
        const form = await req.formData().catch(() => null);
        const username = form?.get("username")?.toString() || "";
        const email = form?.get("email")?.toString() || undefined;
        const password = form?.get("password")?.toString() || "";
        const formRedirect = form?.get("redirect")?.toString() || redirect;

        try {
          const user = await this.authStore.registerUser({ username, email, password });
          const sessionToken = SessionManager.sign({
            username: user.username,
            role: user.role,
            email: user.email,
            avatarUrl: user.avatarUrl,
          });

          return new Response(null, {
            status: 302,
            headers: {
              Location: formRedirect,
              "Set-Cookie": SessionManager.createCookieHeader(sessionToken, isSecure),
            },
          });
        } catch (err: any) {
          return new Response(
            renderRegister({
              error: err.message || "Failed to create account.",
              redirect: formRedirect,
              githubEnabled,
            }),
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }
      }
    }

    // Sign Out (GET /logout, POST /logout)
    if (pathname === "/logout") {
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": SessionManager.clearCookieHeader(),
        },
      });
    }

    // GitHub OAuth Initiation (GET /auth/github)
    if (pathname === "/auth/github") {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) {
        return new Response("GitHub OAuth is not configured on this instance. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET.", {
          status: 400,
          headers: { "Content-Type": "text/plain" },
        });
      }
      const redirect = url.searchParams.get("redirect") || "/settings/tokens";
      const callbackUrl = `${serverUrl}/auth/github/callback`;
      const ghUrl = `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(
        clientId
      )}&scope=read:user,user:email&redirect_uri=${encodeURIComponent(callbackUrl)}&state=${encodeURIComponent(redirect)}`;

      return new Response(null, { status: 302, headers: { Location: ghUrl } });
    }

    // GitHub OAuth Callback (GET /auth/github/callback)
    if (pathname === "/auth/github/callback") {
      const code = url.searchParams.get("code");
      const stateRedirect = url.searchParams.get("state") || "/settings/tokens";

      if (!code) {
        return new Response(null, { status: 302, headers: { Location: "/login?error=GitHub+authorization+failed" } });
      }

      try {
        const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: process.env.GITHUB_CLIENT_ID,
            client_secret: process.env.GITHUB_CLIENT_SECRET,
            code,
          }),
        });

        const tokenData = (await tokenRes.json()) as any;
        if (!tokenData.access_token) {
          return new Response(
            renderLogin({
              error: `GitHub OAuth failed: ${tokenData.error_description || "missing access token"}`,
              githubEnabled: true,
            }),
            { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } }
          );
        }

        const ghUserRes = await fetch("https://api.github.com/user", {
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            "User-Agent": "Strata-Git",
          },
        });
        const ghUser = (await ghUserRes.json()) as any;

        let email = ghUser.email;
        if (!email) {
          const emailsRes = await fetch("https://api.github.com/user/emails", {
            headers: {
              Authorization: `Bearer ${tokenData.access_token}`,
              "User-Agent": "Strata-Git",
            },
          }).catch(() => null);
          if (emailsRes && emailsRes.ok) {
            const emails = (await emailsRes.json()) as any[];
            const primary = emails.find((e) => e.primary && e.verified);
            if (primary) email = primary.email;
          }
        }

        const user = await this.authStore.findOrCreateGitHubUser({
          id: ghUser.id,
          login: ghUser.login,
          email,
          avatar_url: ghUser.avatar_url,
        });

        const sessionToken = SessionManager.sign({
          username: user.username,
          role: user.role,
          email: user.email,
          avatarUrl: user.avatarUrl,
        });

        return new Response(null, {
          status: 302,
          headers: {
            Location: stateRedirect,
            "Set-Cookie": SessionManager.createCookieHeader(sessionToken, isSecure),
          },
        });
      } catch (err: any) {
        return new Response(
          renderLogin({
            error: `GitHub OAuth error: ${err.message}`,
            githubEnabled: true,
          }),
          { status: 500, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }
    }

    // ─── USER SETTINGS & TOKEN MANAGEMENT ─────────────────────────────────

    // View Token Settings Page (GET /settings/tokens)
    if (pathname === "/settings/tokens") {
      if (!currentUser) {
        return new Response(null, {
          status: 302,
          headers: { Location: "/login?redirect=/settings/tokens" },
        });
      }

      const user = await this.authStore.getUser(currentUser.username);
      if (!user) {
        return new Response(null, { status: 302, headers: { Location: "/logout" } });
      }

      return new Response(
        renderTokenSettings({
          user,
          serverUrl,
          currentUser,
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // Generate Personal Access Token (POST /settings/tokens/generate or POST /api/tokens)
    if (pathname === "/settings/tokens/generate" || (pathname === "/api/tokens" && req.method === "POST")) {
      if (!currentUser) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      let name = "CLI Token";
      let scopes: ("read" | "write" | "admin")[] = ["read", "write"];
      let expiresInDays = 90;

      const contentType = req.headers.get("content-type") || "";
      if (contentType.includes("application/json")) {
        const body = (await req.json().catch(() => ({}))) as any;
        if (body.name) name = body.name;
        if (Array.isArray(body.scopes)) scopes = body.scopes;
        if (typeof body.expiresInDays === "number") expiresInDays = body.expiresInDays;
      } else {
        const form = await req.formData().catch(() => null);
        if (form) {
          if (form.get("name")) name = form.get("name")!.toString();
          const formScopes = form.getAll("scopes").map((s) => s.toString()) as ("read" | "write" | "admin")[];
          if (formScopes.length > 0) scopes = formScopes;
          if (form.get("expiresInDays")) expiresInDays = parseInt(form.get("expiresInDays")!.toString(), 10);
        }
      }

      const { rawToken, token } = await this.authStore.createTokenForUser({
        username: currentUser.username,
        tokenName: name,
        scopes,
        expiresInDays,
      });

      if (req.headers.get("accept")?.includes("application/json")) {
        return new Response(JSON.stringify({ status: "success", rawToken, token }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        });
      }

      const updatedUser = await this.authStore.getUser(currentUser.username);
      return new Response(
        renderTokenSettings({
          user: updatedUser!,
          newToken: rawToken,
          serverUrl,
          currentUser,
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // Revoke Token (POST /settings/tokens/revoke or POST /api/tokens/:id/revoke)
    const revokeMatch = pathname.match(/^\/api\/tokens\/([a-zA-Z0-9_\-]+)\/revoke$/);
    if (pathname === "/settings/tokens/revoke" || (revokeMatch && req.method === "POST")) {
      if (!currentUser) {
        return new Response(JSON.stringify({ error: "Unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      let tokenId = revokeMatch ? revokeMatch[1] : "";
      if (!tokenId) {
        const form = await req.formData().catch(() => null);
        tokenId = form?.get("tokenId")?.toString() || "";
      }

      const revoked = await this.authStore.revokeToken(currentUser.username, tokenId);

      if (req.headers.get("accept")?.includes("application/json")) {
        return new Response(JSON.stringify({ status: "success", revoked }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(null, {
        status: 302,
        headers: { Location: "/settings/tokens" },
      });
    }

    // Documentation / Tokens Guide (GET /docs, /docs/tokens, /tokens)
    if (pathname === "/docs" || pathname === "/docs/tokens" || pathname === "/tokens") {
      return new Response(renderTokensGuide(serverUrl, currentUser), {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // API endpoint: Trigger Compaction Worker (Phase 12)
    const compactMatch = pathname.match(/^\/api\/compaction(?:\/(.+))?$/);
    if (compactMatch && req.method === "POST") {
      const authHeader = req.headers.get("authorization");
      let authCtx: AuthContext | undefined;
      if (authHeader?.startsWith("Bearer ")) {
        authCtx = await this.authStore.authenticateWithToken(authHeader.slice(7).trim());
      } else {
        const creds = this.parseBasicAuth(req);
        if (creds) authCtx = await this.authStore.authenticate(creds.username, creds.token);
      }

      const manifest = await this.authStore.getManifest();
      const hasUsers = Object.keys(manifest.users).length > 0;
      if (hasUsers && (!authCtx?.authenticated || (authCtx.user?.role !== "admin" && !authCtx.token?.scopes.includes("admin")))) {
        return new Response(JSON.stringify({ error: "Unauthorized: Admin privileges required" }), {
          status: 403,
          headers: { "Content-Type": "application/json" },
        });
      }

      const targetRepo = compactMatch[1];
      if (targetRepo) {
        const res = await compactRepository(targetRepo, this.engine, 1);
        return new Response(JSON.stringify(res), {
          status: res.status === "error" ? 500 : 200,
          headers: { "Content-Type": "application/json" },
        });
      } else {
        const results = await compactAllRepositories(this.engine, 2);
        return new Response(JSON.stringify(results), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
    }

    // Match optional token in URL path: /t/<pat_token>/<repo>.git/...
    const tokenMatch = pathname.match(/^\/t\/(pat_[a-zA-Z0-9_-]+)\/(.+)$/);
    let pathWithoutToken = pathname;
    let urlToken: string | undefined;

    if (tokenMatch) {
      urlToken = tokenMatch[1];
      pathWithoutToken = `/${tokenMatch[2]}`;
    }

    // Match Git smart HTTP paths: /:repoId.git/... or /:owner/:repoId.git/...
    const gitMatch = pathWithoutToken.match(/^\/((?:[a-zA-Z0-9_\-\.]+\/)?[a-zA-Z0-9_\-\.]+)\.git(\/.*)?$/);

    // If not a .git smart HTTP path, check for Web UI Explorer routes (Phase 13)
    if (!gitMatch) {
      const uiMatch = pathname.match(/^\/((?:[a-zA-Z0-9_\-\.]+\/)?[a-zA-Z0-9_\-\.]+)(?:\/(tree|blob|commits)(?:\/([^\/]+)(?:\/(.*))?)?)?\/?$/);
      if (uiMatch && !pathname.endsWith(".git") && !pathname.startsWith("/api/")) {
        const repoId = uiMatch[1]!;
        const action = uiMatch[2] as "tree" | "blob" | "commits" | undefined;
        const branchParam = uiMatch[3];
        const subpath = uiMatch[4] || "";

        return this.handleWebUiRequest(req, repoId, action, branchParam, subpath);
      }
      return new Response("Not Found", { status: 404 });
    }

    const repoId = gitMatch[1]!;
    const subpath = gitMatch[2] || "";
    const isWrite = pathname.includes("git-receive-pack") || url.search.includes("git-receive-pack");

    // 1. Authenticate credentials (from URL token, Bearer header, or Basic auth)
    let authContext: AuthContext | undefined;
    if (urlToken) {
      authContext = await this.authStore.authenticateWithToken(urlToken);
    } else {
      const authHeader = req.headers.get("authorization");
      if (authHeader?.startsWith("Bearer ")) {
        const bearerToken = authHeader.slice(7).trim();
        authContext = await this.authStore.authenticateWithToken(bearerToken);
      } else {
        const creds = this.parseBasicAuth(req);
        if (creds) {
          authContext = await this.authStore.authenticate(creds.username, creds.token);
        }
      }
    }

    // 2. Enforce Access Control Policy
    const access = await this.authStore.checkAccess({
      repoId,
      isWrite,
      authContext,
    });

    if (!access.allowed) {
      if (access.status === 401) {
        return new Response(access.reason, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Strata Git Server"',
            "Content-Type": "text/plain",
          },
        });
      }
      return new Response(`Forbidden: ${access.reason}`, {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Ensure repository exists on disk (or auto-materialize from S3)
    const exists = await this.engine.ensureRepoReady(repoId, isWrite);
    if (!exists) {
      return new Response(`Repository '${repoId}' not found`, { status: 404 });
    }

    const repoDir = this.engine.getRepoPath(repoId);

    // Track existing packfiles before potential push
    const packDir = join(repoDir, "objects", "pack");
    let prePacks = new Set<string>();
    if (isWrite) {
      try {
        const files = await readdir(packDir);
        prePacks = new Set(files.filter((f) => f.endsWith(".pack")));
      } catch {}
    }

    // Run git http-backend CGI
    const queryString = url.search.startsWith("?") ? url.search.slice(1) : "";
    const pathInfo = `/${repoId}.git${subpath}`;

    const proc = Bun.spawn(["git", "http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: this.reposDir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        REQUEST_METHOD: req.method,
        QUERY_STRING: queryString,
        CONTENT_TYPE: req.headers.get("content-type") || "",
      },
      stdin: req.body ? await req.arrayBuffer() : undefined,
    });

    const [cgiArrayBuffer, stderrText] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    const cgiBytes = new Uint8Array(cgiArrayBuffer);
    await proc.exited;

    if (proc.exitCode !== 0 && cgiBytes.length === 0) {
      console.error(`[CGI Error] git http-backend exited with code ${proc.exitCode}: ${stderrText}`);
      return new Response(`Git CGI Error: ${stderrText}`, { status: 500 });
    }

    // If this was a successful push, upload the packfile to S3 and commit WAL via CAS!
    if (req.method === "POST" && pathname.includes("git-receive-pack") && proc.exitCode === 0) {
      await this.engine.syncPushToS3(repoId, prePacks);

      // Auto-assign repository ownership to authenticated user if newly created
      if (authContext?.user) {
        const manifest = await this.authStore.getManifest();
        if (!manifest.repos[repoId]) {
          await this.authStore.setRepoPolicy({
            repoId,
            owner: authContext.user.username,
            visibility: "public",
          }).catch(() => {});
        }
      }
    }

    return this.parseCgiResponse(cgiBytes);
  }

  /**
   * Handles browser Web UI requests (Phase 13).
   */
  private async handleWebUiRequest(
    req: Request,
    repoId: string,
    action?: "tree" | "blob" | "commits",
    branchParam?: string,
    subpath?: string
  ): Promise<Response> {
    const url = new URL(req.url);
    const queryToken = url.searchParams.get("t");
    const cookieToken = this.parseCookie(req, "git_token");
    const userToken = queryToken || cookieToken;

    const session = SessionManager.getSessionFromRequest(req);
    const currentUser: CurrentUser | undefined = session
      ? { username: session.username, avatarUrl: session.avatarUrl, role: session.role }
      : undefined;

    // 1. Authenticate credentials
    let authContext: AuthContext | undefined;
    if (userToken) {
      authContext = await this.authStore.authenticateWithToken(userToken);
    } else if (session) {
      const user = await this.authStore.getUser(session.username);
      if (user) {
        authContext = { authenticated: true, user };
      }
    } else {
      const authHeader = req.headers.get("authorization");
      if (authHeader?.startsWith("Bearer ")) {
        authContext = await this.authStore.authenticateWithToken(authHeader.slice(7).trim());
      } else {
        const creds = this.parseBasicAuth(req);
        if (creds) {
          authContext = await this.authStore.authenticate(creds.username, creds.token);
        }
      }
    }

    // 2. Check access policy
    const access = await this.authStore.checkAccess({
      repoId,
      isWrite: false,
      authContext,
    });

    if (!access.allowed) {
      const errorMsg = userToken && !authContext?.authenticated ? "Invalid Personal Access Token" : undefined;
      return new Response(renderAuthGate(repoId, errorMsg, currentUser), {
        status: 401,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    }

    // 3. Ensure repo is materialized
    const exists = await this.engine.ensureRepoReady(repoId, false);
    if (!exists) {
      return new Response(
        `<!DOCTYPE html><html><body style="font-family:sans-serif;padding:48px;text-align:center;"><h2>Repository '${repoId}' not found</h2><p><a href="/">Return Home</a></p></body></html>`,
        { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    const repoDir = this.engine.getRepoPath(repoId);
    const branches = await GitReader.getBranches(repoDir);
    const defaultBranch = await GitReader.getDefaultBranch(repoDir);
    const currentBranch = branchParam || defaultBranch;

    const host = req.headers.get("host") || `${this.host}:${this.port}`;
    const proto = req.headers.get("x-forwarded-proto") || (host.includes("lambda-url") ? "https" : "http");
    const serverUrl = `${proto}://${host}`;

    const manifest = await this.authStore.getManifest();
    const policy = manifest.repos[repoId];
    const visibility = policy?.visibility || "public";
    const nameParts = repoId.split("/");
    const name = nameParts[nameParts.length - 1]!;
    const owner = policy?.owner || (nameParts.length > 1 ? nameParts[0] : "milan");

    const ctx: RepoContext = {
      repoId,
      owner,
      name,
      defaultBranch,
      currentBranch,
      branches,
      visibility,
      serverUrl,
      token: userToken,
      cloneUrlToken: `${serverUrl}/t/${userToken || "<token>"}/${repoId}.git`,
      cloneUrlBasic: `${serverUrl}/${repoId}.git`,
      currentUser,
    };

    const headers: Record<string, string> = {
      "Content-Type": "text/html; charset=utf-8",
    };
    if (queryToken && authContext?.authenticated) {
      headers["Set-Cookie"] = `git_token=${encodeURIComponent(queryToken)}; Path=/; SameSite=Lax; HttpOnly`;
    }

    // 4. Render requested view
    if (action === "commits") {
      const commits = await GitReader.getCommits(repoDir, currentBranch, 50);
      return new Response(renderCommitsView(ctx, commits), { headers });
    }

    if (action === "blob") {
      const cleanFile = subpath || "";
      const blob = await GitReader.getBlob(repoDir, currentBranch, cleanFile);
      if (!blob) {
        return new Response("File not found", { status: 404 });
      }
      if (url.searchParams.get("raw") === "true") {
        return new Response(blob.content, {
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      return new Response(renderBlobView(ctx, blob), { headers });
    }

    if (action === "tree") {
      const cleanSubpath = subpath || "";
      const tree = await GitReader.getTree(repoDir, currentBranch, cleanSubpath);
      return new Response(renderSubTree(ctx, cleanSubpath, tree), { headers });
    }

    // Root overview view: tree + README
    const tree = await GitReader.getTree(repoDir, currentBranch, "");
    const latestCommit = await GitReader.getLatestCommit(repoDir, currentBranch);
    let readmeContent: string | null = null;
    const readmeEntry = tree.find((e) => e.name.toLowerCase() === "readme.md");
    if (readmeEntry) {
      const blob = await GitReader.getBlob(repoDir, currentBranch, readmeEntry.name);
      if (blob && !blob.isBinary) {
        readmeContent = blob.content;
      }
    }

    return new Response(renderRepoOverview(ctx, tree, latestCommit, readmeContent), { headers });
  }

  private parseCgiResponse(cgiBytes: Uint8Array): Response {
    let headerEndIndex = -1;
    let separatorLength = 4; // \r\n\r\n

    for (let i = 0; i < cgiBytes.length - 3; i++) {
      if (
        cgiBytes[i] === 13 &&
        cgiBytes[i + 1] === 10 &&
        cgiBytes[i + 2] === 13 &&
        cgiBytes[i + 3] === 10
      ) {
        headerEndIndex = i;
        separatorLength = 4;
        break;
      }
    }

    if (headerEndIndex === -1) {
      for (let i = 0; i < cgiBytes.length - 1; i++) {
        if (cgiBytes[i] === 10 && cgiBytes[i + 1] === 10) {
          headerEndIndex = i;
          separatorLength = 2;
          break;
        }
      }
    }

    if (headerEndIndex === -1) {
      return new Response(cgiBytes, { status: 200 });
    }

    const headerText = new TextDecoder().decode(cgiBytes.subarray(0, headerEndIndex));
    const bodyBytes = cgiBytes.subarray(headerEndIndex + separatorLength);

    const headers = new Headers();
    let status = 200;

    for (const line of headerText.split(/\r?\n/)) {
      if (!line) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const val = line.slice(colonIdx + 1).trim();

      if (key === "status") {
        status = parseInt(val.split(" ")[0] || "200", 10);
      } else {
        headers.set(key, val);
      }
    }

    return new Response(bodyBytes, { status, headers });
  }
}

// Standalone runner when executed directly via 'bun run src/server/git-http-server.ts'
if (import.meta.main) {
  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "eu-north-1";

  let storage: R2StorageInterface;
  if (bucketName) {
    storage = new AwsS3Storage({ bucketName, region });
  } else {
    console.log("No AWS_S3_BUCKET specified in environment. Running with in-memory Mock storage.");
    storage = new MockR2Storage();
  }

  const server = new GitHttpServer({ storage });
  await server.start();
}
