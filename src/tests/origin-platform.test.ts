import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { RendezvousRouter } from "../engine/rendezvous-router.ts";
import { PrimaryNode } from "../engine/primary-node.ts";
import { ReplicaNode } from "../engine/replica-node.ts";
import { runGit } from "../engine/git-process.ts";
import { WALIndex } from "../models/wal-index.ts";

describe("Phase 8: Origin Platform & Production Fleet Scaling", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_origin_platform");
  const clientDir = join(testDir, "client");
  const nodesDir = join(testDir, "nodes");
  const repoId = "monorepo-core";
  let storage: MockR2Storage;
  let router: RendezvousRouter;

  beforeEach(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(clientDir, { recursive: true });
    await mkdir(nodesDir, { recursive: true });

    storage = new MockR2Storage();
    router = new RendezvousRouter(["node-alpha", "node-bravo", "node-charlie"]);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  test("should execute end-to-end write, read replication (304), cold materialization, compaction, and failover", async () => {
    // 1. Topology calculation
    const topology = router.getTopology(repoId);
    expect(topology.primary).toBeDefined();
    expect(topology.replicas.length).toBe(2);

    const primary = new PrimaryNode(topology.primary, storage, repoId, nodesDir);
    await primary.initRepo();

    // 2. Client push
    await runGit(["init", "-b", "main"], { cwd: clientDir });
    await writeFile(join(clientDir, "index.ts"), `console.log("Origin platform v1");\n`);
    await runGit(["add", "."], { cwd: clientDir });
    await runGit(["commit", "-m", "feat: initial commit"], { cwd: clientDir });

    const push1 = await primary.ingestPush(clientDir, "main");
    expect(push1.version).toBe(1);
    expect(push1.newPackfiles.length).toBe(1);

    // 3. Replica read path (200 on cold read, 304 on warm read)
    const replica1 = new ReplicaNode(topology.replicas[0], storage, repoId, nodesDir);
    const sync1 = await replica1.syncForRead();
    expect(sync1.status).toBe(200);
    expect(sync1.downloadedPacks.length).toBe(1);

    const sync2 = await replica1.syncForRead();
    expect(sync2.status).toBe(304);
    expect(sync2.downloadedPacks.length).toBe(0);

    // 4. Cold-start materialization on Replica 2 (0 bytes -> full repo)
    const replica2 = new ReplicaNode(topology.replicas[1], storage, repoId, nodesDir);
    expect(await replica2.isDiskWarm()).toBe(false);
    const matResult = await replica2.materialize();
    expect(matResult.downloadedPacks.length).toBe(1);
    expect(await replica2.isDiskWarm()).toBe(true);

    // 5. Compaction: Push 2 more commits then compact
    for (let i = 2; i <= 3; i++) {
      await writeFile(join(clientDir, `file_${i}.ts`), `export const v = ${i};\n`);
      await runGit(["add", "."], { cwd: clientDir });
      await runGit(["commit", "-m", `feat: patch ${i}`], { cwd: clientDir });
      await primary.ingestPush(clientDir, "main");
    }

    const preCompactIdx = await storage.getObject(`${repoId}/wal_index.json`);
    const preWAL = WALIndex.fromBytes(preCompactIdx.data!);
    expect(preWAL.packfiles.length).toBe(3);

    const compResult = await primary.compact();
    expect(compResult.previousPacksCount).toBe(3);
    expect(compResult.version).toBe(4);

    const postCompactIdx = await storage.getObject(`${repoId}/wal_index.json`);
    const postWAL = WALIndex.fromBytes(postCompactIdx.data!);
    expect(postWAL.packfiles.length).toBe(1);

    // Replicas catch up to compacted state
    const replSyncCompacted = await replica1.syncForRead();
    expect(replSyncCompacted.status).toBe(200);
    expect(replSyncCompacted.downloadedPacks.length).toBe(1);

    // 6. Failover: Primary dies, next node takes over writes seamlessly
    const crashedPrimaryId = topology.primary;
    router.removeNode(crashedPrimaryId);
    const failoverTopology = router.getTopology(repoId);
    expect(failoverTopology.primary).not.toBe(crashedPrimaryId);

    const newPrimary = new PrimaryNode(failoverTopology.primary, storage, repoId, nodesDir);
    await newPrimary.initRepo();

    await writeFile(join(clientDir, "failover.ts"), `export const failover = true;\n`);
    await runGit(["add", "."], { cwd: clientDir });
    await runGit(["commit", "-m", "fix: commit on promoted primary"], { cwd: clientDir });

    const pushFailover = await newPrimary.ingestPush(clientDir, "main");
    expect(pushFailover.version).toBe(5);
  });
});
