import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { PrimaryNode } from "../engine/primary-node.ts";
import { ReplicaNode } from "../engine/replica-node.ts";
import { runGit } from "../engine/git-process.ts";

describe("Phase 4: Replica Node Engine (Conditional GET 304 & Delta Catchup)", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_replica_suite");
  const clientRepoDir = join(testDir, "client_author");
  const cloneRepoDir = join(testDir, "client_reader");
  const nodeWorkDir = join(testDir, "cluster_nodes");

  let r2: MockR2Storage;
  let primary: PrimaryNode;
  let replica: ReplicaNode;
  const repoId = "replica-demo-repo";

  beforeAll(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(clientRepoDir, { recursive: true });
    await mkdir(nodeWorkDir, { recursive: true });

    // Client author setup
    await runGit(["init", "-b", "main"], { cwd: clientRepoDir });

    // R2 and cluster setup
    r2 = new MockR2Storage("test-continuity-bucket");
    primary = new PrimaryNode("primary-1", r2, repoId, nodeWorkDir);
    replica = new ReplicaNode("replica-1", r2, repoId, nodeWorkDir);

    await primary.initRepo();
    await replica.initRepo();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should sync newly pushed commits on cold read (HTTP 200)", async () => {
    // 1. Primary ingests first push
    await writeFile(join(clientRepoDir, "app.ts"), 'console.log("Serving from replica");\n');
    await runGit(["add", "."], { cwd: clientRepoDir });
    await runGit(["commit", "-m", "First push to primary"], { cwd: clientRepoDir });
    const commit1Sha = await runGit(["rev-parse", "HEAD"], { cwd: clientRepoDir });

    await primary.ingestPush(clientRepoDir, "main");

    // 2. Replica syncs from S3
    const syncRes = await replica.syncForRead();
    expect(syncRes.status).toBe(200);
    expect(syncRes.cacheHit).toBe(false);
    expect(syncRes.version).toBe(1);
    expect(syncRes.downloadedPacks.length).toBe(1);

    // 3. Client clones directly from ReplicaNode
    await runGit(["clone", replica.repoDir, cloneRepoDir]);
    const clonedSha = await runGit(["rev-parse", "HEAD"], { cwd: cloneRepoDir });
    expect(clonedSha).toBe(commit1Sha);

    const clonedContent = await Bun.file(join(cloneRepoDir, "app.ts")).text();
    expect(clonedContent).toContain("Serving from replica");
  });

  it("should return HTTP 304 Not Modified when no new commits exist (Hot Path)", async () => {
    // Read request on an already-up-to-date replica
    const sync304 = await replica.syncForRead();

    expect(sync304.status).toBe(304);
    expect(sync304.cacheHit).toBe(true);
    expect(sync304.downloadedPacks.length).toBe(0); // Zero payload downloaded!
    expect(sync304.version).toBe(1);
  });

  it("should download only delta packfiles when new pushes arrive", async () => {
    // 1. Author pushes a second commit to Primary
    await writeFile(join(clientRepoDir, "feature.ts"), 'export const scale = "infinite";\n');
    await runGit(["add", "."], { cwd: clientRepoDir });
    await runGit(["commit", "-m", "Second commit to primary"], { cwd: clientRepoDir });
    const commit2Sha = await runGit(["rev-parse", "HEAD"], { cwd: clientRepoDir });

    await primary.ingestPush(clientRepoDir, "main");

    // 2. Replica syncs again
    const syncDelta = await replica.syncForRead();

    expect(syncDelta.status).toBe(200);
    expect(syncDelta.cacheHit).toBe(false);
    expect(syncDelta.version).toBe(2);
    // Crucial: replica only downloaded 1 packfile (the new delta), not both!
    expect(syncDelta.downloadedPacks.length).toBe(1);

    // 3. Client pulls from replica
    await runGit(["pull"], { cwd: cloneRepoDir });
    const updatedClonedSha = await runGit(["rev-parse", "HEAD"], { cwd: cloneRepoDir });
    expect(updatedClonedSha).toBe(commit2Sha);

    const featureContent = await Bun.file(join(cloneRepoDir, "feature.ts")).text();
    expect(featureContent).toContain("infinite");
  });
});
