import { describe, expect, it } from "bun:test";
import { RendezvousRouter } from "../engine/rendezvous-router.ts";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { WALIndex } from "../models/wal-index.ts";

describe("Phase 7: Stateless Consensus & Rendezvous Hashing", () => {
  it("should deterministically rank nodes for any given repository", () => {
    const nodes = ["worker-1", "worker-2", "worker-3", "worker-4"];
    const router = new RendezvousRouter(nodes);

    const run1 = router.getRankedNodes("cursor-monorepo");
    const run2 = router.getRankedNodes("cursor-monorepo");

    // Must be 100% deterministic
    expect(run1).toEqual(run2);
    expect(run1.length).toBe(4);
    expect(router.getPrimary("cursor-monorepo")).toBe(run1[0]!);
    expect(router.getReplicas("cursor-monorepo", 2)).toEqual(run1.slice(1, 3));
  });

  it("should distribute primaries across different repositories", () => {
    const nodes = ["worker-1", "worker-2", "worker-3", "worker-4"];
    const router = new RendezvousRouter(nodes);

    const primaries = new Set<string>();
    for (let i = 0; i < 50; i++) {
      primaries.add(router.getPrimary(`project-${i}`));
    }

    // All 4 workers should receive primary traffic
    expect(primaries.size).toBe(4);
  });

  it("should execute instant, zero-election failover when a node crashes", () => {
    const nodes = ["node-alpha", "node-beta", "node-gamma"];
    const router = new RendezvousRouter(nodes);

    const initialRanking = router.getRankedNodes("agent-scratchpad");
    const originalPrimary = initialRanking[0]!;
    const expectedSuccessor = initialRanking[1]!;

    // Simulate original primary server crashing
    router.removeNode(originalPrimary);

    // New primary must automatically be the second ranked node!
    const newPrimary = router.getPrimary("agent-scratchpad");
    expect(newPrimary).toBe(expectedSuccessor);
    expect(newPrimary).not.toBe(originalPrimary);
  });

  it("should resolve concurrent push races statelessly via S3 Atomic CAS (412 handling)", async () => {
    const s3 = new MockR2Storage("test-continuity-bucket");
    const repoId = "race-test-repo";
    const indexKey = `${repoId}/wal_index.json`;

    // 1. Initial index at Version 1
    const v1 = WALIndex.createInitial(repoId, { "refs/heads/main": "commit_1" }, ["pack-1.pack"]);
    const putRes = await s3.putObject(indexKey, v1.toBytes());
    const etagV1 = putRes.etag!;

    // 2. Node A and Node B both read the index at Version 1
    const getA = await s3.getObject(indexKey);
    const getB = await s3.getObject(indexKey);
    expect(getA.etag).toBe(etagV1);
    expect(getB.etag).toBe(etagV1);

    // 3. Node A prepares Push A and Node B prepares Push B
    const indexA = WALIndex.fromBytes(getA.data!).withPush("main", "commit_A", "pack-A.pack");
    const indexB = WALIndex.fromBytes(getB.data!).withPush("main", "commit_B", "pack-B.pack");

    // 4. Node A commits first with If-Match: etagV1
    const commitA = await s3.putObject(indexKey, indexA.toBytes(), { ifMatch: etagV1 });
    expect(commitA.status).toBe(200);
    const etagV2 = commitA.etag!;

    // 5. Node B attempts to commit concurrently with the stale etagV1
    const commitB = await s3.putObject(indexKey, indexB.toBytes(), { ifMatch: etagV1 });
    expect(commitB.status).toBe(412); // S3 blocks the conflict!

    // 6. Node B catches 412: Refetches latest index, rebases, and retries
    const retryGet = await s3.getObject(indexKey);
    expect(retryGet.etag).toBe(etagV2);

    const rebasedB = WALIndex.fromBytes(retryGet.data!).withPush("main", "commit_B", "pack-B.pack");
    const retryCommitB = await s3.putObject(indexKey, rebasedB.toBytes(), { ifMatch: etagV2 });
    expect(retryCommitB.status).toBe(200);

    // 7. Verify final S3 WAL state is linear and has both commits
    const finalGet = await s3.getObject(indexKey);
    const finalIndex = WALIndex.fromBytes(finalGet.data!);
    expect(finalIndex.version).toBe(3);
    expect(finalIndex.references["refs/heads/main"]).toBe("commit_B");
    expect(finalIndex.packfiles).toEqual(["pack-1.pack", "pack-A.pack", "pack-B.pack"]);
  });
});
