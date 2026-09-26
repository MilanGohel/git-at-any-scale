import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { PrimaryNode } from "../engine/primary-node.ts";
import { runGit } from "../engine/git-process.ts";
import { WALIndex } from "../models/wal-index.ts";

describe("Phase 3: Primary Node Engine (Packfile Ingestion & CAS Commit)", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_primary_suite");
  const clientRepoDir = join(testDir, "client_repo");
  const nodeWorkDir = join(testDir, "nodes");

  let r2: MockR2Storage;
  let primary: PrimaryNode;
  const repoId = "cursor-core-project";

  beforeAll(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(clientRepoDir, { recursive: true });
    await mkdir(nodeWorkDir, { recursive: true });

    // Setup client git repo
    await runGit(["init", "-b", "main"], { cwd: clientRepoDir });

    // Setup Primary node
    r2 = new MockR2Storage("test-continuity-bucket");
    primary = new PrimaryNode("primary-1", r2, repoId, nodeWorkDir);
    await primary.initRepo();
  });

  afterAll(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it("should ingest first push, stream packfile to R2, and commit wal_index.json via CAS", async () => {
    // 1. Create a commit in client repo
    const file1 = join(clientRepoDir, "main.ts");
    await writeFile(file1, 'console.log("Hello from Cursor Continuity");\n');
    await runGit(["add", "main.ts"], { cwd: clientRepoDir });
    await runGit(["commit", "-m", "Initial commit from developer"], { cwd: clientRepoDir });

    const localCommitSha = await runGit(["rev-parse", "HEAD"], { cwd: clientRepoDir });

    // 2. Ingest push into PrimaryNode
    const result = await primary.ingestPush(clientRepoDir, "main");

    expect(result.success).toBe(true);
    expect(result.commitSha).toBe(localCommitSha);
    expect(result.version).toBe(1);
    expect(result.etag).toBeDefined();
    expect(result.newPackfiles.length).toBeGreaterThan(0);

    // 3. Verify R2 WAL state
    const indexRes = await r2.getObject(`${repoId}/wal_index.json`);
    expect(indexRes.status).toBe(200);
    expect(indexRes.data).toBeDefined();

    const walIndex = WALIndex.fromBytes(indexRes.data!);
    expect(walIndex.version).toBe(1);
    expect(walIndex.references["refs/heads/main"]).toBe(localCommitSha);
    expect(walIndex.packfiles).toEqual(result.newPackfiles);

    // 4. Verify packfiles are actually in R2
    for (const packKey of result.newPackfiles) {
      const packRes = await r2.getObject(packKey);
      expect(packRes.status).toBe(200);
      expect(packRes.data!.length).toBeGreaterThan(0);
    }
  });

  it("should ingest a second push, bump version to 2, and append new packfile", async () => {
    // 1. Add another commit
    const file2 = join(clientRepoDir, "agent.ts");
    await writeFile(file2, 'export const agent = { name: "Antigravity", speed: "infinite" };\n');
    await runGit(["add", "agent.ts"], { cwd: clientRepoDir });
    await runGit(["commit", "-m", "Add autonomous agent configuration"], { cwd: clientRepoDir });

    const localCommitSha2 = await runGit(["rev-parse", "HEAD"], { cwd: clientRepoDir });

    // 2. Ingest push
    const result2 = await primary.ingestPush(clientRepoDir, "main");

    expect(result2.success).toBe(true);
    expect(result2.commitSha).toBe(localCommitSha2);
    expect(result2.version).toBe(2);

    // 3. Verify S3/R2 WAL index updated to version 2 with both packfiles
    const indexRes = await r2.getObject(`${repoId}/wal_index.json`);
    const walIndex = WALIndex.fromBytes(indexRes.data!);
    expect(walIndex.version).toBe(2);
    expect(walIndex.references["refs/heads/main"]).toBe(localCommitSha2);
    expect(walIndex.packfiles.length).toBeGreaterThanOrEqual(2);
  });
});
