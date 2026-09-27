import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { GitRepoEngine } from "../engine/git-repo-engine.ts";
import { GitHttpServer } from "../server/git-http-server.ts";
import { AuthStore } from "../auth/auth-store.ts";
import { runGit } from "../engine/git-process.ts";

describe("Phase 13: Minimalist Web UI & Repository Explorer ('Mini-GitHub')", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_web_ui");
  const reposDir = join(testDir, "server_repos");
  const clientDir = join(testDir, "client_project");
  const testPort = 8995;

  let storage: MockR2Storage;
  let engine: GitRepoEngine;
  let authStore: AuthStore;
  let server: GitHttpServer;
  let userToken: string;

  const publicRepoId = "public-demo";
  const privateRepoId = "milan/secret-vault";

  beforeAll(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(reposDir, { recursive: true });
    await mkdir(clientDir, { recursive: true });

    storage = new MockR2Storage();
    engine = new GitRepoEngine({
      storage,
      reposDir,
    });
    authStore = new AuthStore(storage);

    // Setup user 'milan'
    await authStore.createUser("milan", "admin");
    const tok = await authStore.createTokenForUser({
      username: "milan",
      tokenName: "Web UI Test Key",
      scopes: ["read", "write"],
    });
    userToken = tok.rawToken;

    // Set policies
    await authStore.setRepoPolicy({ repoId: publicRepoId, owner: "milan", visibility: "public" });
    await authStore.setRepoPolicy({ repoId: privateRepoId, owner: "milan", visibility: "private" });

    server = new GitHttpServer({
      port: testPort,
      storage,
      dataDir: reposDir,
      authStore,
      engine,
    });
    await server.start();

    // Seed public repo with commits and files
    await engine.ensureRepoReady(publicRepoId, true);
    const pubRepoPath = engine.getRepoPath(publicRepoId);

    await runGit(["init", "-b", "main"], { cwd: clientDir });
    await writeFile(join(clientDir, "README.md"), "# Public Demo Project\n\nWelcome to **Continuity** Web Explorer!\n\n```ts\nconsole.log('Hello Web UI');\n```\n");
    await mkdir(join(clientDir, "src"), { recursive: true });
    await writeFile(join(clientDir, "src", "index.ts"), "export const version = '1.0.0';\nexport function hello() {\n  return 'world';\n}\n");
    await runGit(["add", "."], { cwd: clientDir });
    await runGit(["commit", "-m", "feat: initial commit with README and src"], { cwd: clientDir });
    await runGit(["push", pubRepoPath, "main"], { cwd: clientDir });
    await engine.syncPushToS3(publicRepoId, new Set());

    // Seed private repo
    await engine.ensureRepoReady(privateRepoId, true);
    const privRepoPath = engine.getRepoPath(privateRepoId);
    await writeFile(join(clientDir, "secret.key"), "SECRET_TOKEN_42\n");
    await runGit(["add", "."], { cwd: clientDir });
    await runGit(["commit", "-m", "secret commit"], { cwd: clientDir });
    await runGit(["push", privRepoPath, "main"], { cwd: clientDir });
    await engine.syncPushToS3(privateRepoId, new Set());
  });

  afterAll(async () => {
    server.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test("should render the Home directory at GET / for web browsers", async () => {
    const res = await fetch(`http://localhost:${testPort}/`, {
      headers: { Accept: "text/html" },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).toContain("Repositories");
    expect(html).toContain(publicRepoId);
    expect(html).toContain(privateRepoId);
  });

  test("should render repository overview at GET /:repoId with README and file tree", async () => {
    const res = await fetch(`http://localhost:${testPort}/${publicRepoId}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain(publicRepoId);
    expect(html).toContain("badge-public");
    expect(html).toContain("README.md");
    expect(html).toContain("src");
    expect(html).toContain("Public Demo Project");
    expect(html).toContain("Hello Web UI");
  });

  test("should render subdirectory tree at GET /:repoId/tree/:branch/:subpath", async () => {
    const res = await fetch(`http://localhost:${testPort}/${publicRepoId}/tree/main/src`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("index.ts");
    expect(html).toContain("..");
  });

  test("should render file code viewer at GET /:repoId/blob/:branch/:filepath", async () => {
    const res = await fetch(`http://localhost:${testPort}/${publicRepoId}/blob/main/src/index.ts`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("index.ts");
    expect(html).toContain("blob-lines-table");
    expect(html).toContain("export const version = &#039;1.0.0&#039;;");
    expect(html).toContain("Copy Raw");
  });

  test("should serve raw file content when requested with ?raw=true", async () => {
    const res = await fetch(`http://localhost:${testPort}/${publicRepoId}/blob/main/src/index.ts?raw=true`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const text = await res.text();
    expect(text).toContain("export const version = '1.0.0';");
  });

  test("should render commit history timeline at GET /:repoId/commits/:branch", async () => {
    const res = await fetch(`http://localhost:${testPort}/${publicRepoId}/commits/main`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain("feat: initial commit with README and src");
    expect(html).toContain("commit-item");
  });

  test("should block unauthenticated access to private repos with auth gate", async () => {
    const res = await fetch(`http://localhost:${testPort}/${privateRepoId}`);
    expect(res.status).toBe(401);
    const html = await res.text();

    expect(html).toContain("Private Repository");
    expect(html).toContain("Enter Personal Access Token");
  });

  test("should unlock private repository when token is provided in query param ?t=...", async () => {
    const res = await fetch(`http://localhost:${testPort}/${privateRepoId}?t=${userToken}`);
    expect(res.status).toBe(200);
    const html = await res.text();

    expect(html).toContain(privateRepoId);
    expect(html).toContain("badge-private");
    expect(html).toContain("secret.key");
    expect(res.headers.get("set-cookie")).toContain("git_token=");
  });

  test("should unlock private repository when token is provided via Cookie", async () => {
    const res = await fetch(`http://localhost:${testPort}/${privateRepoId}`, {
      headers: {
        Cookie: `git_token=${userToken}`,
      },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("secret.key");
  });

  test("should ensure native Git CLI smart HTTP operations continue to work without conflict", async () => {
    const cloneUrl = `http://localhost:${testPort}/t/${userToken}/${privateRepoId}.git`;
    const checkDir = join(testDir, "cli_clone_verify");
    await runGit(["clone", cloneUrl, checkDir]);

    const secretContent = await Bun.file(join(checkDir, "secret.key")).text();
    expect(secretContent.trim()).toBe("SECRET_TOKEN_42");
  });
});
