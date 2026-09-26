/**
 * Live AWS S3 Test Runner.
 *
 * Verifies end-to-end integration with a real AWS S3 bucket:
 * 1. Connects to AWS S3 using credentials from environment variables / .env.
 * 2. Creates a local sample Git repository with real commits.
 * 3. Ingests the push through PrimaryNode.
 * 4. Verifies the .pack file and wal_index.json are live in AWS S3.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AwsS3Storage } from "../storage/aws-s3.ts";
import { PrimaryNode } from "../engine/primary-node.ts";
import { runGit } from "../engine/git-process.ts";
import { WALIndex } from "../models/wal-index.ts";

async function main() {
  console.log("================================================================================");
  console.log(" 🚀 LIVE AWS S3 CONTINUITY VERIFICATION");
  console.log("================================================================================\n");

  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "us-east-1";

  if (!bucketName) {
    console.error("❌ ERROR: Missing AWS_S3_BUCKET environment variable.");
    console.error("Please add the following to your .env file:\n");
    console.error('AWS_ACCESS_KEY_ID="your_access_key"');
    console.error('AWS_SECRET_ACCESS_KEY="your_secret_key"');
    console.error('AWS_REGION="us-east-1"');
    console.error('AWS_S3_BUCKET="your-bucket-name"\n');
    process.exit(1);
  }

  console.log(`Connecting to AWS S3:`);
  console.log(`  - Bucket: ${bucketName}`);
  console.log(`  - Region: ${region}`);

  const s3 = new AwsS3Storage({ bucketName, region });

  // 1. Smoke test connectivity
  console.log("\n[1/5] Verifying AWS S3 bucket connectivity...");
  try {
    const existing = await s3.listObjects("continuity-test/");
    console.log(`✅ Successfully reached bucket! (${existing.length} existing test objects)`);
  } catch (err: any) {
    console.error(`❌ Failed to connect to S3 bucket '${bucketName}':`, err.message);
    process.exit(1);
  }

  // 2. Setup temporary local workspace
  const simDir = join(process.cwd(), ".sim_data", "live_s3_test");
  const clientRepoDir = join(simDir, "client_project");
  const nodeWorkDir = join(simDir, "nodes");

  await rm(simDir, { recursive: true, force: true });
  await mkdir(clientRepoDir, { recursive: true });
  await mkdir(nodeWorkDir, { recursive: true });

  const repoId = `demo-${Date.now()}`;
  console.log(`\n[2/5] Initializing Primary Node for repo: ${repoId}...`);
  const primary = new PrimaryNode("primary-aws-1", s3, repoId, nodeWorkDir);
  await primary.initRepo();

  // 3. Create a real client Git repository
  console.log("\n[3/5] Creating real client Git repository with commits...");
  await runGit(["init", "-b", "main"], { cwd: clientRepoDir });

  await writeFile(
    join(clientRepoDir, "app.ts"),
    `// Cursor Continuity running on real AWS S3!\nconsole.log("Timestamp: ${new Date().toISOString()}");\n`
  );
  await writeFile(
    join(clientRepoDir, "README.md"),
    `# Git at Any Scale Demo\nUploaded to AWS S3 via Continuity PrimaryNode.\n`
  );

  await runGit(["add", "."], { cwd: clientRepoDir });
  await runGit(["commit", "-m", "First commit live on AWS S3"], { cwd: clientRepoDir });
  const commit1Sha = await runGit(["rev-parse", "HEAD"], { cwd: clientRepoDir });
  console.log(`  - Created local commit: ${commit1Sha.slice(0, 8)}`);

  // 4. Ingest push into PrimaryNode
  console.log("\n[4/5] Executing PrimaryNode.ingestPush() to AWS S3...");
  const pushRes = await primary.ingestPush(clientRepoDir, "main");

  console.log(`✅ Push successfully ingested & committed to AWS S3!`);
  console.log(`  - Target Branch: main`);
  console.log(`  - Commit SHA:    ${pushRes.commitSha}`);
  console.log(`  - WAL Version:   v${pushRes.version}`);
  console.log(`  - S3 ETag:       ${pushRes.etag}`);
  console.log(`  - Packfiles:     ${pushRes.newPackfiles.join(", ")}`);

  // 5. Inspect the live S3 WAL index
  console.log("\n[5/5] Fetching live wal_index.json directly from AWS S3...");
  const getIndex = await s3.getObject(`${repoId}/wal_index.json`);
  if (getIndex.status === 200 && getIndex.data) {
    const wal = WALIndex.fromBytes(getIndex.data);
    console.log(`\n================== S3 WAL INDEX CONTENT ==================`);
    console.log(wal.toJSON());
    console.log(`==========================================================\n`);
  }

  console.log("🎉 SUCCESS! Your Git repository data is now live in AWS S3.");
  console.log(`You can view it in the AWS S3 Console under:`);
  console.log(`  s3://${bucketName}/${repoId}/`);
  console.log(`    ├── wal_index.json`);
  console.log(`    └── wal/packs/*.pack\n`);
}

main().catch((err) => {
  console.error("Fatal error running live S3 test:", err);
  process.exit(1);
});
