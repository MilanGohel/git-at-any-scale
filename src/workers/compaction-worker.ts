/**
 * Standalone Compaction Worker (Phase 12)
 *
 * Capabilities:
 * - Can be run as a standalone CLI worker:
 *     bun run src/workers/compaction-worker.ts <repoId>
 *     bun run src/workers/compaction-worker.ts --all --threshold 5
 * - Can be invoked as an AWS Lambda handler (triggered by SQS, EventBridge, or CloudWatch Cron)
 * - Detects packfile fragmentation, runs 'git repack -ad', streams unified pack to S3,
 *   and updates wal_index.json via Atomic CAS.
 */

import { resolve } from "node:path";
import { AwsS3Storage } from "../storage/aws-s3.ts";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { GitRepoEngine } from "../engine/git-repo-engine.ts";
import { WALIndex } from "../models/wal-index.ts";
import type { R2StorageInterface } from "../types/storage.ts";

export interface CompactionWorkerResult {
  repoId: string;
  status: "compacted" | "skipped" | "error";
  initialPacksCount: number;
  finalPacksCount: number;
  compactedPackKey?: string;
  version?: number;
  error?: string;
}

/**
 * Compacts a single repository if its packfiles count meets or exceeds the threshold.
 */
export async function compactRepository(
  repoId: string,
  engine: GitRepoEngine,
  threshold: number = 1
): Promise<CompactionWorkerResult> {
  const indexKey = `${repoId}/wal_index.json`;
  const getRes = await engine.storage.getObject(indexKey);

  if (getRes.status !== 200 || !getRes.data) {
    return {
      repoId,
      status: "skipped",
      initialPacksCount: 0,
      finalPacksCount: 0,
      error: `Repository '${repoId}' not found in storage`,
    };
  }

  const curIndex = WALIndex.fromBytes(getRes.data);
  const initialPacks = curIndex.packfiles.length;

  if (initialPacks < threshold) {
    return {
      repoId,
      status: "skipped",
      initialPacksCount: initialPacks,
      finalPacksCount: initialPacks,
    };
  }

  // Ensure repository is warm locally on disk
  const ready = await engine.ensureRepoReady(repoId, false);
  if (!ready) {
    return {
      repoId,
      status: "error",
      initialPacksCount: initialPacks,
      finalPacksCount: initialPacks,
      error: `Failed to materialize repository '${repoId}' onto local disk for compaction`,
    };
  }

  const compactRes = await engine.compact(repoId);
  if (!compactRes) {
    return {
      repoId,
      status: "error",
      initialPacksCount: initialPacks,
      finalPacksCount: initialPacks,
      error: `Compaction failed during repack or CAS commit`,
    };
  }

  return {
    repoId,
    status: "compacted",
    initialPacksCount: initialPacks,
    finalPacksCount: 1,
    compactedPackKey: compactRes.compactedPackKey,
    version: compactRes.version,
  };
}

/**
 * Scans all repositories in storage and compacts any exceeding the packfile threshold.
 */
export async function compactAllRepositories(
  engine: GitRepoEngine,
  threshold: number = 3
): Promise<CompactionWorkerResult[]> {
  const allObjects = await engine.storage.listObjects("");
  const walIndexKeys = allObjects.filter((k) => k.endsWith("/wal_index.json"));
  const results: CompactionWorkerResult[] = [];

  for (const indexKey of walIndexKeys) {
    const repoId = indexKey.replace(/\/wal_index\.json$/, "");
    try {
      const res = await compactRepository(repoId, engine, threshold);
      results.push(res);
    } catch (err: any) {
      results.push({
        repoId,
        status: "error",
        initialPacksCount: 0,
        finalPacksCount: 0,
        error: err.message,
      });
    }
  }

  return results;
}

/**
 * AWS Lambda Handler for EventBridge, SQS, or scheduled CloudWatch Cron events.
 */
export async function handler(event?: any): Promise<{ statusCode: number; body: string }> {
  console.log("[Compaction Worker] Invoked with event:", JSON.stringify(event));

  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "eu-north-1";
  const storage: R2StorageInterface = bucketName
    ? new AwsS3Storage({ bucketName, region })
    : new MockR2Storage();

  const engine = new GitRepoEngine({
    storage,
    reposDir: process.env.GIT_DATA_DIR || "/tmp/repos",
  });

  // Check if a specific repoId was passed in event
  const targetRepo = event?.repoId || event?.Records?.[0]?.body;
  let results: CompactionWorkerResult[];

  if (targetRepo) {
    console.log(`[Compaction Worker] Target repository: ${targetRepo}`);
    const res = await compactRepository(targetRepo, engine, 1);
    results = [res];
  } else {
    console.log("[Compaction Worker] Scanning all repositories in storage...");
    results = await compactAllRepositories(engine, 3);
  }

  console.log("[Compaction Worker] Results:", JSON.stringify(results, null, 2));
  return {
    statusCode: 200,
    body: JSON.stringify(results),
  };
}

// Standalone CLI execution
if (import.meta.main) {
  const args = process.argv.slice(2);
  const C = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    red: "\x1b[31m",
  };

  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "eu-north-1";
  const reposDir = resolve(process.env.GIT_DATA_DIR || "./.sim_data/compaction_worker/repos");

  let storage: R2StorageInterface;
  if (bucketName) {
    storage = new AwsS3Storage({ bucketName, region });
  } else {
    console.log(`${C.yellow}Notice: No AWS_S3_BUCKET found in env. Running in Mock storage.${C.reset}`);
    storage = new MockR2Storage();
  }

  const engine = new GitRepoEngine({
    storage,
    reposDir,
  });

  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
${C.bold}Continuity Compaction Worker (Phase 12)${C.reset}

${C.bold}Usage:${C.reset}
  bun run src/workers/compaction-worker.ts <repoId> [--threshold <n>]
  bun run src/workers/compaction-worker.ts --all [--threshold <n>]

${C.bold}Options:${C.reset}
  --all             Scan all repositories in S3 and compact fragmented ones
  --threshold <n>   Minimum packfiles required to trigger compaction (default: 1 for single repo, 3 for --all)
`);
    process.exit(0);
  }

  const isAll = args.includes("--all");
  const thresholdIdx = args.indexOf("--threshold");
  const threshold = thresholdIdx !== -1 ? parseInt(args[thresholdIdx + 1]!, 10) : (isAll ? 3 : 1);

  console.log(`\n================================================================================`);
  console.log(` 🧹 CONTINUITY COMPACTION WORKER (Storage: ${storage.constructor.name})`);
  console.log(`================================================================================`);

  if (isAll) {
    console.log(`Scanning storage for fragmented repositories (Threshold: >= ${threshold} packs)...`);
    const results = await compactAllRepositories(engine, threshold);
    const compacted = results.filter((r) => r.status === "compacted");
    console.log(`✔ Finished: ${compacted.length} repositories compacted out of ${results.length} checked.`);
    for (const r of results) {
      if (r.status === "compacted") {
        console.log(`  • ${C.green}${r.repoId}${C.reset}: ${r.initialPacksCount} packs -> 1 pack (v${r.version})`);
      } else if (r.status === "error") {
        console.log(`  • ${C.red}${r.repoId}${C.reset}: Error: ${r.error}`);
      }
    }
  } else {
    const targetRepo = args.find((a) => !a.startsWith("--"));
    if (!targetRepo) {
      console.error(`${C.red}Error: Please specify a repository ID or use --all.${C.reset}`);
      process.exit(1);
    }

    console.log(`Checking repository '${C.cyan}${targetRepo}${C.reset}'...`);
    const res = await compactRepository(targetRepo, engine, threshold);

    if (res.status === "compacted") {
      console.log(`${C.green}✔ SUCCESS: Compacted '${targetRepo}'!${C.reset}`);
      console.log(`  - Initial Packfiles: ${res.initialPacksCount}`);
      console.log(`  - Compacted Packfile: ${res.compactedPackKey}`);
      console.log(`  - New WAL Version:   v${res.version}`);
    } else if (res.status === "skipped") {
      console.log(`${C.yellow}Skipped:${C.reset} '${targetRepo}' has only ${res.initialPacksCount} packfile(s) (threshold is ${threshold}).`);
    } else {
      console.error(`${C.red}Error: ${res.error}${C.reset}`);
      process.exit(1);
    }
  }

  console.log(`================================================================================\n`);
}
