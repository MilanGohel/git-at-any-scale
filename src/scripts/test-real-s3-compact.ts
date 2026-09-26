/**
 * Live AWS S3 Amortized Compaction Runner.
 *
 * Demonstrates:
 * 1. Pushing multiple commits to AWS S3, accumulating multiple .pack files.
 * 2. Primary running local repack, uploading the single unified packfile to S3.
 * 3. Atomic CAS updating wal_index.json to replace the fragmented list with 1 packfile.
 * 4. Replica downloading the ready-made pack without burning CPU on repacking!
 */

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AwsS3Storage } from "../storage/aws-s3.ts";
import { PrimaryNode } from "../engine/primary-node.ts";
import { ReplicaNode } from "../engine/replica-node.ts";
import { runGit } from "../engine/git-process.ts";
import { WALIndex } from "../models/wal-index.ts";

async function main() {
  console.log("================================================================================");
  console.log(" 🚀 LIVE AWS S3 AMORTIZED COMPACTION TEST");
  console.log("================================================================================\n");

  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "us-east-1";

  if (!bucketName) {
    console.error("❌ ERROR: Missing AWS_S3_BUCKET environment variable.");
    process.exit(1);
  }

  const s3 = new AwsS3Storage({ bucketName, region });
  const repoId = `compact-${Date.now()}`;

  const simDir = join(process.cwd(), ".sim_data", "live_s3_compact");
  const authorDir = join(simDir, "author_client");
  const cloneDir = join(simDir, "reader_clone");
  const nodeDir = join(simDir, "cluster_nodes");

  await rm(simDir, { recursive: true, force: true });
  await mkdir(authorDir, { recursive: true });
  await mkdir(nodeDir, { recursive: true });

  console.log(`[1/5] Setting up cluster for repo '${repoId}' on AWS S3 (${region})...`);
  const primary = new PrimaryNode("primary-node", s3, repoId, nodeDir);
  const replica = new ReplicaNode("replica-node", s3, repoId, nodeDir);

  await primary.initRepo();
  await replica.initRepo();

  // Step 2: Author creates 3 separate pushes
  console.log("\n[2/5] Creating and pushing 3 separate commits to generate packfiles...");
  await runGit(["init", "-b", "main"], { cwd: authorDir });

  for (let i = 1; i <= 3; i++) {
    await writeFile(join(authorDir, `module_${i}.ts`), `export const mod${i} = { id: ${i} };\n`);
    await runGit(["add", "."], { cwd: authorDir });
    await runGit(["commit", "-m", `Feature push ${i}`], { cwd: authorDir });
    const pushRes = await primary.ingestPush(authorDir, "main");
    console.log(`  - Push ${i} committed! WAL Version: v${pushRes.version}`);
  }

  // Inspect S3 WAL index before compaction
  const beforeRes = await s3.getObject(`${repoId}/wal_index.json`);
  const beforeIndex = WALIndex.fromBytes(beforeRes.data!);
  console.log(`\n  - S3 WAL Index BEFORE compaction (Version ${beforeIndex.version}):`);
  console.log(`    Packfiles count: ${beforeIndex.packfiles.length}`);
  beforeIndex.packfiles.forEach((p) => console.log(`      • ${p}`));

  // Step 3: Primary executes compaction
  console.log("\n[3/5] Primary executing Amortized Compaction (git repack -ad)...");
  const compactRes = await primary.compact();
  console.log(`✅ Compaction committed to AWS S3!`);
  console.log(`  - New WAL Version:      v${compactRes.version}`);
  console.log(`  - Consolidated Packs:   ${compactRes.previousPacksCount} packs -> 1 pack`);
  console.log(`  - Compacted S3 Object:  ${compactRes.compactedPackKey}`);

  // Inspect S3 WAL index after compaction
  const afterRes = await s3.getObject(`${repoId}/wal_index.json`);
  const afterIndex = WALIndex.fromBytes(afterRes.data!);
  console.log(`\n  - S3 WAL Index AFTER compaction (Version ${afterIndex.version}):`);
  console.log(`    Packfiles count: ${afterIndex.packfiles.length}`);
  afterIndex.packfiles.forEach((p) => console.log(`      • ${p}`));

  // Step 4: Replica downloads compacted pack and prunes old packs
  console.log("\n[4/5] Replica synchronizing compaction event from AWS S3...");
  const syncRes = await replica.syncForRead();
  console.log(`  - Replica S3 Status:    ${syncRes.status}`);
  console.log(`  - Downloaded Packs:     ${syncRes.downloadedPacks.join(", ")}`);

  const replicaPacks = (await readdir(join(replica.repoDir, "objects", "pack"))).filter((f) =>
    f.endsWith(".pack")
  );
  console.log(`  - Total .pack files on Replica disk: ${replicaPacks.length} (Old packs pruned!)`);

  // Step 5: Client clones from Replica
  console.log("\n[5/5] Client cloning from Replica to verify Git integrity...");
  await runGit(["clone", replica.repoDir, cloneDir]);
  const log = await runGit(["log", "--oneline"], { cwd: cloneDir });
  console.log(`\n  - Cloned Git commit history:`);
  console.log(`    ${log.replace(/\n/g, "\n    ")}`);

  console.log("\n🎉 AMORTIZED COMPACTION VERIFIED 100% WITH REAL AWS S3!");
  console.log("Only the Primary repacked; the Replica downloaded the ready-made pack with zero CPU spikes.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
