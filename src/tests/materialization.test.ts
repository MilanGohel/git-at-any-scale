import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { PrimaryNode } from "../engine/primary-node.ts";
import { ReplicaNode } from "../engine/replica-node.ts";
import { runGit } from "../engine/git-process.ts";

describe("Phase 5: Ephemeral Cold-Start Materialization (Cattle, Not Pets)", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_materialize_suite");
  const authorRepoDir = join(testDir, "author_client");
  const cloneRepoDir = join(testDir, "reader_clone");
  const nodeWorkDir = join(testDir, "cluster_nodes");

  let r2: MockR2Storage;
  let primary: PrimaryNode;
  const repoId = "cattle-demo-repo";

  beforeAll(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(authorRepoDir, { recursive: true });
    await mkdir(nodeWorkDir, { recursive: true });

    // Setup client author repo
    await runGit(["init", "-b", "main"], { cwd: authorRepoDir });

    r2 = new MockR2Storage("test-continuity-bucket");
    primary = new PrimaryNode("primary-1", r2, repoId, nodeWorkDir);
    await primary.initRepo();

    // Push 1: initial commit
    await writeFile(join(authorRepoDir, "doc.txt"), "First revision\n");
    await runGit(["add", "."], { cwd: authorRepoDir });
    await runGit(["commit", "-m", "Commit 1"], { cwd: authorRepoDir });
    await primary.ingestPush(authorRepoDir, "main");

    // Push 2: second commit
    await writeFile(join(authorRepoDir, "doc.txt"), "Second revision\n");
    await writeFile(join(authorRepoDir, "model.ts"), "export const model = 'Claude';\n");
    await runGit(["add", "."], { cwd: authorRepoDir });
    await runGit(["commit", "-m", "Commit 2"], { cwd: authorRepoDir });
    await primary.ingestPush(authorRepoDir, "main");
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should materialize a complete Git repository on an empty disk from S3", async () => {
    // Replica 1 has 0 bytes on local disk (cold server / freshly provisioned)
    const replica1 = new ReplicaNode("cold-replica-1", r2, repoId, nodeWorkDir);
    expect(await replica1.isDiskWarm()).toBe(false);

    // Explicitly trigger materialization
    const matRes = await replica1.materialize();
    expect(matRes.success).toBe(true);
    expect(matRes.version).toBe(2);
    expect(matRes.downloadedPacks.length).toBe(2);
    expect(matRes.refsCount).toBeGreaterThanOrEqual(1);
    expect(await replica1.isDiskWarm()).toBe(true);

    // Verify client can clone directly from materialized replica
    await runGit(["clone", replica1.repoDir, cloneRepoDir]);
    const log = await runGit(["log", "--oneline"], { cwd: cloneRepoDir });
    expect(log).toContain("Commit 1");
    expect(log).toContain("Commit 2");

    const content = await Bun.file(join(cloneRepoDir, "model.ts")).text();
    expect(content).toContain("Claude");
  });

  it("should evict disk (0 bytes) and self-heal automatically on next read", async () => {
    const replica2 = new ReplicaNode("eviction-replica-2", r2, repoId, nodeWorkDir);

    // 1. Initial materialization
    await replica2.materialize();
    expect(await replica2.isDiskWarm()).toBe(true);

    // 2. Simulate cache eviction ("cattle, not pets"): wipe disk completely
    await replica2.evictDisk();
    expect(await replica2.isDiskWarm()).toBe(false);

    // 3. Client read arrives: syncForRead should automatically self-heal!
    const syncRes = await replica2.syncForRead();
    expect(syncRes.status).toBe(200);
    expect(syncRes.version).toBe(2);
    expect(await replica2.isDiskWarm()).toBe(true);

    // 4. Subsequent read should be an instant HTTP 304 hit
    const hotCheck = await replica2.syncForRead();
    expect(hotCheck.status).toBe(304);
    expect(hotCheck.cacheHit).toBe(true);
  });
});
