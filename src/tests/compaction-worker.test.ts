import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { GitRepoEngine } from "../engine/git-repo-engine.ts";
import { GitHttpServer } from "../server/git-http-server.ts";
import { AuthStore } from "../auth/auth-store.ts";
import { WALIndex } from "../models/wal-index.ts";
import { runGit } from "../engine/git-process.ts";
import {
  compactRepository,
  compactAllRepositories,
  handler as lambdaCompactionHandler,
} from "../workers/compaction-worker.ts";

describe("Phase 12: Asynchronous Serverless Compaction Worker", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_phase12_worker");
  const reposDir = join(testDir, "worker_repos");
  const clientDir = join(testDir, "client");
  const testPort = 8996;

  let storage: MockR2Storage;
  let engine: GitRepoEngine;
  let authStore: AuthStore;
  let server: GitHttpServer;
  let adminToken: string;

  beforeAll(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(reposDir, { recursive: true });
    await mkdir(clientDir, { recursive: true });

    storage = new MockR2Storage();
    engine = new GitRepoEngine({
      storage,
      reposDir,
      compactionThreshold: 99, // Set high so auto-compaction does not fire during setup
    });

    authStore = new AuthStore(storage);
    await authStore.createUser("admin-user", "admin");
    const tok = await authStore.createTokenForUser({
      username: "admin-user",
      tokenName: "Admin Compaction Key",
      scopes: ["read", "write", "admin"],
    });
    adminToken = tok.rawToken;

    server = new GitHttpServer({
      port: testPort,
      storage,
      dataDir: reposDir,
      authStore,
      engine,
    });
    await server.start();
  });

  afterAll(async () => {
    server.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test("should compact a fragmented repository using standalone compactRepository()", async () => {
    const repoId = "frag-repo-1";
    await engine.ensureRepoReady(repoId, true);
    const repoDir = engine.getRepoPath(repoId);

    // Client pushes 3 commits to generate 3 fragmented packfiles
    await runGit(["init", "-b", "main"], { cwd: clientDir });
    for (let i = 1; i <= 3; i++) {
      await writeFile(join(clientDir, `file_${i}.txt`), `Commit ${i}`);
      await runGit(["add", "."], { cwd: clientDir });
      await runGit(["commit", "-m", `push ${i}`], { cwd: clientDir });
      await runGit(["push", repoDir, "main"], { cwd: clientDir });
      await engine.syncPushToS3(repoId, new Set());
    }

    let walRes = await storage.getObject(`${repoId}/wal_index.json`);
    let wal = WALIndex.fromBytes(walRes.data!);
    expect(wal.packfiles.length).toBe(3);

    // Run standalone worker function
    const result = await compactRepository(repoId, engine, 2);
    expect(result.status).toBe("compacted");
    expect(result.initialPacksCount).toBe(3);
    expect(result.finalPacksCount).toBe(1);
    expect(result.compactedPackKey).toContain("wal/compacted/");

    // Verify S3 WAL Index now tracks exactly 1 packfile
    walRes = await storage.getObject(`${repoId}/wal_index.json`);
    wal = WALIndex.fromBytes(walRes.data!);
    expect(wal.packfiles.length).toBe(1);
  });

  test("should batch-compact only fragmented repos using compactAllRepositories()", async () => {
    const cleanRepo = "clean-repo";
    await engine.ensureRepoReady(cleanRepo, true);
    const cleanPath = engine.getRepoPath(cleanRepo);

    // Push only 1 commit
    await writeFile(join(clientDir, "clean.txt"), "Single commit");
    await runGit(["add", "."], { cwd: clientDir });
    await runGit(["commit", "-m", "single commit"], { cwd: clientDir });
    await runGit(["push", cleanPath, "main"], { cwd: clientDir });
    await engine.syncPushToS3(cleanRepo, new Set());

    // Run batch compaction with threshold 2
    const batchResults = await compactAllRepositories(engine, 2);
    const cleanResult = batchResults.find((r) => r.repoId === cleanRepo);
    expect(cleanResult).toBeDefined();
    // Clean repo with only 1 packfile should be skipped
    expect(cleanResult?.status).toBe("skipped");
  });

  test("should trigger compaction on-demand via HTTP API POST /api/compaction/:repoId", async () => {
    const repoId = "api-frag-repo";
    await engine.ensureRepoReady(repoId, true);
    const repoDir = engine.getRepoPath(repoId);

    // Create 2 packfiles
    for (let i = 1; i <= 2; i++) {
      await writeFile(join(clientDir, `api_${i}.txt`), `API commit ${i}`);
      await runGit(["add", "."], { cwd: clientDir });
      await runGit(["commit", "-m", `api push ${i}`], { cwd: clientDir });
      await runGit(["push", repoDir, "main"], { cwd: clientDir });
      await engine.syncPushToS3(repoId, new Set());
    }

    // Call API endpoint with Bearer token
    const res = await fetch(`http://localhost:${testPort}/api/compaction/${repoId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${adminToken}`,
      },
    });

    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("compacted");
    expect(data.repoId).toBe(repoId);
    expect(data.finalPacksCount).toBe(1);
  });

  test("should reject compaction API call from unauthorized users", async () => {
    const res = await fetch(`http://localhost:${testPort}/api/compaction/any-repo`, {
      method: "POST",
      // No authorization header
    });
    expect(res.status).toBe(403);
  });

  test("should execute via AWS Lambda handler signature", async () => {
    const res = await lambdaCompactionHandler({ repoId: "api-frag-repo" });
    expect(res.statusCode).toBe(200);
    const parsed = JSON.parse(res.body);
    expect(Array.isArray(parsed)).toBe(true);
  });
});
