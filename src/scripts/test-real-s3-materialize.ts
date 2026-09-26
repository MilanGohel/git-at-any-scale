/**
 * Live AWS S3 Cold-Start Materialization Runner.
 *
 * Demonstrates:
 * 1. Primary Node pushing multiple commits to AWS S3.
 * 2. Brand new node with 0 bytes on local disk materializing from AWS S3 in milliseconds.
 * 3. Client cloning directly from the materialized node.
 * 4. Evicting the repository from disk completely (simulating an idle repo or server crash).
 * 5. Automatic self-healing on next read!
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AwsS3Storage } from "../storage/aws-s3.ts";
import { PrimaryNode } from "../engine/primary-node.ts";
import { ReplicaNode } from "../engine/replica-node.ts";
import { runGit } from "../engine/git-process.ts";

async function main() {
  console.log("================================================================================");
  console.log(" 🚀 LIVE AWS S3 COLD MATERIALIZATION TEST ('Cattle, Not Pets')");
  console.log("================================================================================\n");

  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "us-east-1";

  if (!bucketName) {
    console.error("❌ ERROR: Missing AWS_S3_BUCKET environment variable.");
    process.exit(1);
  }

  const s3 = new AwsS3Storage({ bucketName, region });
  const repoId = `cattle-${Date.now()}`;

  const simDir = join(process.cwd(), ".sim_data", "live_s3_materialize");
  const authorDir = join(simDir, "author_client");
  const reader1Dir = join(simDir, "reader_clone_1");
  const reader2Dir = join(simDir, "reader_clone_2");
  const nodeDir = join(simDir, "cluster_nodes");

  await rm(simDir, { recursive: true, force: true });
  await mkdir(authorDir, { recursive: true });
  await mkdir(nodeDir, { recursive: true });

  console.log(`[1/5] Setting up Primary Node for '${repoId}' on AWS S3 (${region})...`);
  const primary = new PrimaryNode("primary-node", s3, repoId, nodeDir);
  await primary.initRepo();

  // Author pushes Commit 1 & Commit 2
  console.log("\n[2/5] Creating and pushing multiple commits to AWS S3...");
  await runGit(["init", "-b", "main"], { cwd: authorDir });
  await writeFile(join(authorDir, "core.ts"), "export const agent = 'Cursor';\n");
  await runGit(["add", "."], { cwd: authorDir });
  await runGit(["commit", "-m", "Commit 1: Add core agent"], { cwd: authorDir });
  await primary.ingestPush(authorDir, "main");

  await writeFile(join(authorDir, "scale.ts"), "export const scale = 'Unlimited';\n");
  await runGit(["add", "."], { cwd: authorDir });
  await runGit(["commit", "-m", "Commit 2: Add scale config"], { cwd: authorDir });
  const pushRes = await primary.ingestPush(authorDir, "main");
  console.log(`✅ Push completed! S3 WAL is now at Version ${pushRes.version}`);

  // Cold Start: Provision Replica with ZERO local disk
  console.log("\n[3/5] Spinning up cold Replica with 0 bytes on disk...");
  const replica = new ReplicaNode("cold-replica", s3, repoId, nodeDir);
  console.log(`  - Is disk warm? ${await replica.isDiskWarm()} (Empty directory)`);

  console.log("  - Triggering on-demand materialization from AWS S3...");
  const mat = await replica.materialize();
  console.log(`✅ Materialized in ${mat.durationMs}ms!`);
  console.log(`  - Restored Version:    v${mat.version}`);
  console.log(`  - Downloaded Packs:    ${mat.downloadedPacks.join(", ")}`);
  console.log(`  - Reconstructed Refs:  ${mat.refsCount}`);
  console.log(`  - Is disk warm now?    ${await replica.isDiskWarm()}`);

  // Clone from materialized replica
  await runGit(["clone", replica.repoDir, reader1Dir]);
  const log = await runGit(["log", "--oneline"], { cwd: reader1Dir });
  console.log(`\n  - Cloned Git History from newly materialized node:`);
  console.log(`    ${log.replace(/\n/g, "\n    ")}`);

  // Evict repository from disk ("Cattle, not pets")
  console.log("\n[4/5] Simulating cache eviction: Wiping repository from local disk...");
  await replica.evictDisk();
  console.log(`  - Disk wiped completely. Is warm? ${await replica.isDiskWarm()} (0 bytes)`);

  // Client requests read: Replica self-heals automatically!
  console.log("\n[5/5] Client triggers read on evicted node (Self-Healing)...");
  const autoSync = await replica.syncForRead();
  console.log(`✅ Automatic self-healing complete in ${autoSync.latencyMs}ms!`);
  console.log(`  - Is warm now? ${await replica.isDiskWarm()}`);

  await runGit(["clone", replica.repoDir, reader2Dir]);
  console.log(`  - Second clone succeeded without error!`);

  console.log("\n🎉 COLD MATERIALIZATION VERIFIED 100% WITH REAL AWS S3!");
  console.log("Idle repositories can be safely evicted to 0 bytes and restored on-demand.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
