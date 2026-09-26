/**
 * Clone a Git Repository Directly from AWS S3
 *
 * Usage:
 *   bun run src/scripts/clone-from-s3.ts [repoId] [destinationPath]
 *
 * Example:
 *   bun run clone
 *   bun run clone repo-origin-1790426335617 ./my-project
 */

import { mkdir, readdir, rm } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { AwsS3Storage } from "../storage/aws-s3.ts";
import { WALIndex } from "../models/wal-index.ts";
import { runGit } from "../engine/git-process.ts";

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
};

async function main() {
  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "eu-north-1";

  if (!bucketName) {
    console.error(`${C.red}Error: AWS_S3_BUCKET is not set in environment or .env file.${C.reset}`);
    process.exit(1);
  }

  const s3 = new AwsS3Storage({ bucketName, region });

  console.log(`\n${C.cyan}${C.bold}================================================================================${C.reset}`);
  console.log(`${C.bold} 📦 CLONE FROM S3 OBJECT STORAGE (Cursor Continuity Engine)${C.reset}`);
  console.log(`${C.cyan}${C.bold}================================================================================${C.reset}\n`);
  console.log(`Connecting to AWS S3: ${C.green}s3://${bucketName}${C.reset} (${region})\n`);

  // 1. Identify Target Repository
  let repoId = process.argv[2];

  if (!repoId || repoId.startsWith("-")) {
    console.log(`Searching for active repositories in S3 bucket...`);
    const allObjects = await s3.listObjects("");
    const indexFiles = allObjects.filter((key) => key.endsWith("wal_index.json"));

    if (indexFiles.length === 0) {
      console.error(`${C.red}No repositories found in S3 bucket '${bucketName}'.${C.reset}`);
      console.log(`Run 'bun run demo:s3' first to create a repository!`);
      process.exit(1);
    }

    const repos = indexFiles.map((key) => key.replace("/wal_index.json", ""));
    console.log(`Found ${repos.length} repository in S3:`);
    repos.forEach((r, i) => console.log(`  [${i + 1}] ${C.cyan}${r}${C.reset}`));

    // Default to the most recent one
    repoId = repos[repos.length - 1];
    console.log(`\nAuto-selecting latest repository: ${C.bold}${repoId}${C.reset}\n`);
  }

  const targetDir = resolve(process.argv[3] || `./cloned_${repoId}`);

  console.log(`Target destination: ${C.yellow}${targetDir}${C.reset}\n`);

  const tStart = performance.now();

  // 2. Fetch Authoritative S3 WAL Index
  console.log(`[1/4] Fetching authoritative WAL manifest (${repoId}/wal_index.json)...`);
  const indexRes = await s3.getObject(`${repoId}/wal_index.json`);
  if (indexRes.status !== 200 || !indexRes.data) {
    console.error(`${C.red}Error: Could not find wal_index.json for repo '${repoId}' in S3.${C.reset}`);
    process.exit(1);
  }

  const wal = WALIndex.fromBytes(indexRes.data);
  console.log(`  ✔ Found WAL Version: ${C.green}v${wal.version}${C.reset} (ETag: ${indexRes.etag})`);
  console.log(`  ✔ Active packfiles:  ${wal.packfiles.length}`);
  console.log(`  ✔ Branches:          ${Object.keys(wal.references).join(", ")}`);

  // 3. Initialize Git Destination Folder
  console.log(`\n[2/4] Initializing local Git repository...`);
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(targetDir, { recursive: true });

  await runGit(["init", "-b", "main"], { cwd: targetDir });

  // 4. Download and Index Packfiles Directly into .git/objects/pack/
  console.log(`\n[3/4] Streaming ${wal.packfiles.length} packfiles from AWS S3...`);
  const packDir = join(targetDir, ".git", "objects", "pack");
  await mkdir(packDir, { recursive: true });

  for (const packKey of wal.packfiles) {
    const packName = basename(packKey);
    const localPackPath = join(packDir, packName);
    console.log(`  - Downloading: ${C.dim}${packKey}${C.reset}`);

    const packRes = await s3.getObject(packKey);
    if (packRes.status !== 200 || !packRes.data) {
      throw new Error(`Failed to download ${packKey} from S3`);
    }

    await Bun.write(localPackPath, packRes.data);

    // Build binary lookup index (.idx)
    await runGit(["index-pack", localPackPath], { cwd: targetDir });
    console.log(`    ↳ Indexed locally: ${packName.slice(0, 16)}...`);
  }

  // 5. Reconstruct References and Checkout Working Tree
  console.log(`\n[4/4] Fast-forwarding references & checking out files...`);
  for (const [refName, commitSha] of Object.entries(wal.references)) {
    await runGit(["update-ref", refName, commitSha], { cwd: targetDir });
    console.log(`  - Set ${refName} -> ${commitSha.slice(0, 8)}`);
  }

  // Checkout working tree files
  await runGit(["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: targetDir });
  await runGit(["checkout", "-f", "main"], { cwd: targetDir });

  const duration = (performance.now() - tStart).toFixed(2);

  // 6. Verify and Display Results
  console.log(`\n${C.green}${C.bold}✔ CLONED SUCCESSFULLY FROM AWS S3 in ${duration}ms!${C.reset}\n`);

  const gitLog = await runGit(["log", "--oneline", "-n", "8"], { cwd: targetDir });
  console.log(`${C.bold}Git Commit History in cloned repo:${C.reset}`);
  console.log(gitLog.split("\n").map((line) => `  ${line}`).join("\n"));

  console.log(`\n${C.bold}Files on disk at ${targetDir}:${C.reset}`);
  const files = await readdir(targetDir);
  files.forEach((f) => console.log(`  - ${f}`));

  console.log(`\n${C.dim}You can cd into ${targetDir} and run standard 'git' commands!${C.reset}\n`);
}

main().catch((err) => {
  console.error(`${C.red}Clone failed:${C.reset}`, err);
  process.exit(1);
});
