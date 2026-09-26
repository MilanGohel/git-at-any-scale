import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { PrimaryNode } from "../engine/primary-node.ts";
import { ReplicaNode } from "../engine/replica-node.ts";
import { runGit } from "../engine/git-process.ts";

describe("Phase 6: Amortized Compaction (Trading Bandwidth for CPU)", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_compact_suite");
  const authorDir = join(testDir, "author_client");
  const cloneDir = join(testDir, "reader_clone");
  const nodeDir = join(testDir, "cluster_nodes");

  let r2: MockR2Storage;
  let primary: PrimaryNode;
  let replica: ReplicaNode;
  const repoId = "compact-demo-repo";

  beforeAll(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(authorDir, { recursive: true });
    await mkdir(nodeDir, { recursive: true });

    // Client author setup
    await runGit(["init", "-b", "main"], { cwd: authorDir });

    r2 = new MockR2Storage("test-continuity-bucket");
    primary = new PrimaryNode("primary-1", r2, repoId, nodeDir);
    replica = new ReplicaNode("replica-1", r2, repoId, nodeDir);

    await primary.initRepo();
    await replica.initRepo();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should accumulate multiple packfiles over several pushes", async () => {
    // Commit & Push 1
    await writeFile(join(authorDir, "file1.txt"), "Version 1\n");
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["commit", "-m", "Push 1"], { cwd: authorDir });
    await primary.ingestPush(authorDir, "main");

    // Commit & Push 2
    await writeFile(join(authorDir, "file2.txt"), "Version 2\n");
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["commit", "-m", "Push 2"], { cwd: authorDir });
    await primary.ingestPush(authorDir, "main");

    // Commit & Push 3
    await writeFile(join(authorDir, "file3.txt"), "Version 3\n");
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["commit", "-m", "Push 3"], { cwd: authorDir });
    await primary.ingestPush(authorDir, "main");

    // Verify Primary WAL Index tracks 3 packfiles
    expect(primary.cachedIndex?.version).toBe(3);
    expect(primary.cachedIndex?.packfiles.length).toBe(3);

    // Replica syncs before compaction
    await replica.syncForRead();
    const replicaPacksBefore = (await readdir(join(replica.repoDir, "objects", "pack"))).filter(
      (f) => f.endsWith(".pack")
    );
    expect(replicaPacksBefore.length).toBe(3);
  });

  it("should execute Primary compaction, upload unified pack, and update S3 manifest", async () => {
    const compactRes = await primary.compact();

    expect(compactRes.success).toBe(true);
    expect(compactRes.previousPacksCount).toBe(3);
    expect(compactRes.version).toBe(4);
    expect(compactRes.compactedPackKey).toContain("wal/compacted/");

    // Verify S3 WAL Index now lists only 1 compacted packfile!
    expect(primary.cachedIndex?.packfiles.length).toBe(1);
    expect(primary.cachedIndex?.lastCompactedVersion).toBe(4);

    // Verify compacted packfile exists in S3
    const s3Check = await r2.getObject(compactRes.compactedPackKey);
    expect(s3Check.status).toBe(200);
    expect(s3Check.data!.length).toBeGreaterThan(0);
  });

  it("should allow replica to download compacted pack and prune obsolete packs from disk", async () => {
    // Replica syncs the compaction event
    const syncRes = await replica.syncForRead();
    expect(syncRes.status).toBe(200);
    expect(syncRes.version).toBe(4);

    // Verify replica disk now only contains 1 compacted packfile (old 3 packs pruned!)
    const replicaPackFiles = (await readdir(join(replica.repoDir, "objects", "pack"))).filter(
      (f) => f.endsWith(".pack")
    );
    expect(replicaPackFiles.length).toBe(1);

    // Verify client can clone from replica and see all 3 commits
    await runGit(["clone", replica.repoDir, cloneDir]);
    const log = await runGit(["log", "--oneline"], { cwd: cloneDir });
    expect(log).toContain("Push 1");
    expect(log).toContain("Push 2");
    expect(log).toContain("Push 3");

    // Verify all 3 files exist
    expect(await Bun.file(join(cloneDir, "file1.txt")).text()).toBe("Version 1\n");
    expect(await Bun.file(join(cloneDir, "file2.txt")).text()).toBe("Version 2\n");
    expect(await Bun.file(join(cloneDir, "file3.txt")).text()).toBe("Version 3\n");
  });

  it("should seamlessly ingest new pushes on top of the compacted state", async () => {
    // Commit & Push 4
    await writeFile(join(authorDir, "file4.txt"), "Version 4\n");
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["commit", "-m", "Push 4 after compaction"], { cwd: authorDir });
    const push4Res = await primary.ingestPush(authorDir, "main");

    expect(push4Res.version).toBe(5);
    // S3 now tracks 2 packfiles: the compacted base + the new delta pack
    expect(primary.cachedIndex?.packfiles.length).toBe(2);

    // Replica syncs delta
    await replica.syncForRead();
    const replicaPacksAfter = (await readdir(join(replica.repoDir, "objects", "pack"))).filter(
      (f) => f.endsWith(".pack")
    );
    expect(replicaPacksAfter.length).toBe(2);

    // Pull into clone
    await runGit(["pull"], { cwd: cloneDir });
    expect(await Bun.file(join(cloneDir, "file4.txt")).text()).toBe("Version 4\n");
  });
});
