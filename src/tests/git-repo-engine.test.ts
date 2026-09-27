import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { GitRepoEngine } from "../engine/git-repo-engine.ts";
import { WALIndex } from "../models/wal-index.ts";
import { runGit } from "../engine/git-process.ts";

describe("Architecture Improvement: GitRepoEngine & Phase 12 Compaction", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_repo_engine");
  const reposDir = join(testDir, "ephemeral_repos");
  const clientDir = join(testDir, "client");

  let storage: MockR2Storage;
  let engine: GitRepoEngine;

  beforeAll(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(reposDir, { recursive: true });
    await mkdir(clientDir, { recursive: true });

    storage = new MockR2Storage();
    engine = new GitRepoEngine({
      storage,
      reposDir,
      compactionThreshold: 3, // Compact when reaching 3 packfiles
      maxDiskMb: 1, // 1MB threshold to test LRU eviction
    });
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("should serialize concurrent writes using in-process repo locks", async () => {
    const order: number[] = [];

    const p1 = engine.withRepoLock("repo-a", async () => {
      await Bun.sleep(40);
      order.push(1);
    });

    const p2 = engine.withRepoLock("repo-a", async () => {
      await Bun.sleep(10);
      order.push(2);
    });

    await Promise.all([p1, p2]);
    // FIFO execution guarantee
    expect(order).toEqual([1, 2]);
  });

  test("should auto-compact packfiles when threshold is reached (Phase 12)", async () => {
    const repoId = "compaction-repo";
    await engine.ensureRepoReady(repoId, true);

    const repoDir = engine.getRepoPath(repoId);

    // Initialize client repo
    await runGit(["init", "-b", "main"], { cwd: clientDir });

    // Push 1
    await writeFile(join(clientDir, "file1.txt"), "Commit 1\n");
    await runGit(["add", "."], { cwd: clientDir });
    await runGit(["commit", "-m", "commit 1"], { cwd: clientDir });
    await runGit(["push", repoDir, "main"], { cwd: clientDir });
    await engine.syncPushToS3(repoId, new Set());

    // Push 2
    await writeFile(join(clientDir, "file2.txt"), "Commit 2\n");
    await runGit(["add", "."], { cwd: clientDir });
    await runGit(["commit", "-m", "commit 2"], { cwd: clientDir });
    await runGit(["push", repoDir, "main"], { cwd: clientDir });
    await engine.syncPushToS3(repoId, new Set());

    let indexRes = await storage.getObject(`${repoId}/wal_index.json`);
    let wal = WALIndex.fromBytes(indexRes.data!);
    expect(wal.packfiles.length).toBe(2);

    // Push 3: Reaches threshold of 3 -> triggers auto-compaction!
    await writeFile(join(clientDir, "file3.txt"), "Commit 3\n");
    await runGit(["add", "."], { cwd: clientDir });
    await runGit(["commit", "-m", "commit 3"], { cwd: clientDir });
    await runGit(["push", repoDir, "main"], { cwd: clientDir });
    await engine.syncPushToS3(repoId, new Set());

    // Wait briefly for background compaction
    await Bun.sleep(150);

    indexRes = await storage.getObject(`${repoId}/wal_index.json`);
    wal = WALIndex.fromBytes(indexRes.data!);
    // After compaction, the packfiles array is consolidated down to 1 compacted pack!
    expect(wal.packfiles.length).toBe(1);
    expect(wal.packfiles[0]).toContain("wal/compacted/");
  });

  test("should self-heal and re-materialize compacted repository from cold disk", async () => {
    const repoId = "compaction-repo";
    const repoDir = engine.getRepoPath(repoId);

    // Simulate complete disk wipe ("cattle, not pets")
    await rm(repoDir, { recursive: true, force: true });

    // Materialize cold repo
    const ready = await engine.ensureRepoReady(repoId, false);
    expect(ready).toBe(true);

    // Verify commit history is intact from the single compacted packfile
    const log = await runGit(["log", "--oneline"], { cwd: repoDir });
    expect(log).toContain("commit 1");
    expect(log).toContain("commit 2");
    expect(log).toContain("commit 3");
  });

  test("should evict oldest repos from disk when disk quota is exceeded", async () => {
    const repoA = "old-repo-a";
    const repoB = "active-repo-b";

    await engine.ensureRepoReady(repoA, true);
    await Bun.sleep(10);
    await engine.ensureRepoReady(repoB, true);

    const pathA = engine.getRepoPath(repoA);
    const pathB = engine.getRepoPath(repoB);

    // Create a dummy large packfile to trigger quota
    const packDirA = join(pathA, "objects", "pack");
    await mkdir(packDirA, { recursive: true });
    // Write 2MB file (exceeds our 1MB test threshold)
    await Bun.write(join(packDirA, "large.pack"), new Uint8Array(2 * 1024 * 1024));

    await engine.checkAndEvictDiskQuota();

    // Repo A was the oldest, so it must be evicted to free disk
    let existsA = true;
    try {
      await stat(pathA);
    } catch {
      existsA = false;
    }
    expect(existsA).toBe(false);
  });
});
