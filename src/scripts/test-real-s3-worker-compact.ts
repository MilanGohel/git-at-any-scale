/**
 * Live AWS S3 Test for Phase 12 Compaction Worker
 *
 * Verifies against the real AWS S3 bucket:
 * 1. Pushes 3 commits to live S3 using GitRepoEngine with chunked streaming.
 * 2. Confirms wal_index.json on S3 tracks 3 packfiles.
 * 3. Runs the standalone compaction worker against real AWS S3.
 * 4. Confirms wal_index.json is updated on real S3 to exactly 1 consolidated packfile.
 * 5. Wipes local disk and verifies cold-materialization recovers all commits from the compacted packfile.
 * 6. Cleans up test objects from S3.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AwsS3Storage } from "../storage/aws-s3.ts";
import { GitRepoEngine } from "../engine/git-repo-engine.ts";
import { WALIndex } from "../models/wal-index.ts";
import { runGit } from "../engine/git-process.ts";
import { compactRepository } from "../workers/compaction-worker.ts";

async function main() {
  console.log("================================================================================");
  console.log(" 🚀 LIVE AWS S3 PHASE 12 COMPACTION WORKER TEST");
  console.log("================================================================================\n");

  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "eu-north-1";

  if (!bucketName) {
    console.error("❌ ERROR: Missing AWS_S3_BUCKET environment variable.");
    process.exit(1);
  }

  const s3 = new AwsS3Storage({ bucketName, region });
  const repoId = `test-worker-compact-${Date.now()}`;

  const simDir = join(process.cwd(), ".sim_data", "live_s3_worker_compact");
  const authorDir = join(simDir, "author_client");
  const serverDir = join(simDir, "server_repos");

  await rm(simDir, { recursive: true, force: true });
  await mkdir(authorDir, { recursive: true });
  await mkdir(serverDir, { recursive: true });

  const engine = new GitRepoEngine({
    storage: s3,
    reposDir: serverDir,
    compactionThreshold: 99, // Prevent automatic compaction during setup
  });

  console.log(`[1/5] Initializing live S3 repository '${repoId}'...`);
  await engine.ensureRepoReady(repoId, true);
  const repoDir = engine.getRepoPath(repoId);

  console.log("\n[2/5] Creating and pushing 3 commits to live S3...");
  await runGit(["init", "-b", "main"], { cwd: authorDir });

  for (let i = 1; i <= 3; i++) {
    await writeFile(join(authorDir, `feature_${i}.ts`), `export const feat${i} = "Commit ${i}";\n`);
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["commit", "-m", `Feature commit ${i}`], { cwd: authorDir });
    await runGit(["push", repoDir, "main"], { cwd: authorDir });
    const pushRes = await engine.syncPushToS3(repoId, new Set());
    console.log(`  - Push ${i} synced to S3! Version: v${pushRes?.version}, Packfiles: ${pushRes?.packfiles.length}`);
  }

  // Verify S3 state before compaction
  const preIndexRes = await s3.getObject(`${repoId}/wal_index.json`);
  const preWal = WALIndex.fromBytes(preIndexRes.data!);
  console.log(`\n  S3 wal_index.json BEFORE compaction:`);
  console.log(`  - Version: v${preWal.version}`);
  console.log(`  - Packfiles in S3: ${preWal.packfiles.length}`);
  if (preWal.packfiles.length !== 3) {
    throw new Error(`Expected 3 packfiles before compaction, got ${preWal.packfiles.length}`);
  }

  // Step 3: Run standalone compaction worker
  console.log("\n[3/5] Executing Phase 12 Compaction Worker on live S3...");
  const workerResult = await compactRepository(repoId, engine, 2);
  console.log("  Compaction Worker Result:", workerResult);

  if (workerResult.status !== "compacted") {
    throw new Error(`Compaction failed: status is ${workerResult.status}`);
  }

  // Step 4: Verify S3 state after compaction
  console.log("\n[4/5] Verifying compacted state in live S3 bucket...");
  const postIndexRes = await s3.getObject(`${repoId}/wal_index.json`);
  const postWal = WALIndex.fromBytes(postIndexRes.data!);
  console.log(`  S3 wal_index.json AFTER compaction:`);
  console.log(`  - Version: v${postWal.version}`);
  console.log(`  - Packfiles in S3: ${postWal.packfiles.length} (Expected: 1)`);
  console.log(`  - Compacted Key:   ${postWal.packfiles[0]}`);

  if (postWal.packfiles.length !== 1) {
    throw new Error(`Expected 1 packfile after compaction, got ${postWal.packfiles.length}`);
  }

  // Step 5: Test cold materialization from compacted S3 WAL
  console.log("\n[5/5] Testing Ephemeral Cold Materialization from live S3...");
  await rm(repoDir, { recursive: true, force: true });
  console.log("  Local disk wiped to 0 bytes.");

  const ready = await engine.ensureRepoReady(repoId, false);
  if (!ready) {
    throw new Error("Failed to cold materialize compacted repo from S3");
  }

  const logOutput = await runGit(["log", "--oneline"], { cwd: repoDir });
  console.log("  Restored Git commit log:\n" + logOutput.trim().split("\n").map(l => `    ${l}`).join("\n"));

  if (!logOutput.includes("Feature commit 1") || !logOutput.includes("Feature commit 2") || !logOutput.includes("Feature commit 3")) {
    throw new Error("Missing commits after cold materialization!");
  }

  // Clean up S3 test keys
  console.log("\n[Cleanup] Removing temporary test files from S3...");
  const keys = await s3.listObjects(repoId);
  for (const k of keys) {
    await s3.deleteObject(k);
  }
  await rm(simDir, { recursive: true, force: true });

  console.log("\n================================================================================");
  console.log(" 🎉 LIVE AWS S3 COMPACTION WORKER VERIFIED SUCCESSFULLY!");
  console.log("================================================================================\n");
}

main().catch((err) => {
  console.error("\n❌ Live S3 Compaction Test Failed:", err);
  process.exit(1);
});
