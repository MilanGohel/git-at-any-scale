import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import type { R2StorageInterface } from "../types/storage.ts";
import { WALIndex } from "../models/wal-index.ts";
import { runGit } from "./git-process.ts";

export interface GitRepoEngineOptions {
  storage: R2StorageInterface;
  reposDir: string;
  maxDiskMb?: number;
  compactionThreshold?: number;
}

interface RepoAccessMetadata {
  repoId: string;
  repoPath: string;
  lastAccessedAt: number;
}

/**
 * GitRepoEngine: Core Domain & Storage Orchestration Engine
 *
 * Responsibilities:
 * 1. Bare Git repository lifecycle management.
 * 2. On-demand Ephemeral Disk Materialization from S3/R2 WAL.
 * 3. Zero-memory packfile streaming to S3.
 * 4. Jittered Exponential Backoff Atomic CAS WAL commits.
 * 5. In-process FIFO write-serialization mutex per repository.
 * 6. Ephemeral LRU disk quota eviction (prevents serverless container /tmp exhaustion).
 * 7. Asynchronous & amortized packfile compaction (Phase 12).
 */
export class GitRepoEngine {
  public readonly storage: R2StorageInterface;
  public readonly reposDir: string;
  public readonly maxDiskBytes: number;
  public readonly compactionThreshold: number;

  private readonly accessHistory = new Map<string, RepoAccessMetadata>();
  private readonly writeLocks = new Map<string, Promise<void>>();

  constructor(options: GitRepoEngineOptions) {
    this.storage = options.storage;
    this.reposDir = resolve(options.reposDir);
    this.maxDiskBytes = (options.maxDiskMb || Number(process.env.GIT_MAX_DISK_MB) || 2048) * 1024 * 1024;
    this.compactionThreshold = options.compactionThreshold || Number(process.env.GIT_COMPACTION_THRESHOLD) || 5;
  }

  /**
   * Resolves the disk path for a repository.
   */
  getRepoPath(repoId: string): string {
    const sanitized = repoId.replace(/[^a-zA-Z0-9_\-\/]/g, "_");
    return join(this.reposDir, `${sanitized}.git`);
  }

  /**
   * Initializes a new bare repository configured for Continuity packfile retention.
   */
  async initBareRepo(repoDir: string): Promise<void> {
    await mkdir(repoDir, { recursive: true });
    await runGit(["init", "--bare", "-b", "main", repoDir]);
    await runGit(["config", "receive.denyCurrentBranch", "ignore"], { cwd: repoDir });
    await runGit(["config", "receive.unpackLimit", "1"], { cwd: repoDir });
    await runGit(["config", "transfer.unpackLimit", "1"], { cwd: repoDir });
    await runGit(["config", "http.receivepack", "true"], { cwd: repoDir });
    await runGit(["config", "http.uploadpack", "true"], { cwd: repoDir });
  }

  /**
   * Marks a repository as recently accessed for LRU tracking.
   */
  private recordAccess(repoId: string, repoPath: string): void {
    this.accessHistory.set(repoId, {
      repoId,
      repoPath,
      lastAccessedAt: Date.now(),
    });
  }

  /**
   * Calculates total disk space consumed by repositories and evicts LRU repos if over quota.
   */
  async checkAndEvictDiskQuota(): Promise<void> {
    try {
      let totalBytes = 0;
      const repos = Array.from(this.accessHistory.values());

      for (const repo of repos) {
        try {
          const packDir = join(repo.repoPath, "objects", "pack");
          const files = await readdir(packDir);
          for (const file of files) {
            const s = await stat(join(packDir, file));
            totalBytes += s.size;
          }
        } catch {
          // Repo folder might have been deleted externally
        }
      }

      if (totalBytes > this.maxDiskBytes) {
        console.log(`[LRU Cache] Disk usage (${Math.round(totalBytes / 1024 / 1024)}MB) exceeds quota (${Math.round(this.maxDiskBytes / 1024 / 1024)}MB). Evicting...`);

        // Sort oldest accessed first
        repos.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

        for (const oldest of repos) {
          if (totalBytes <= this.maxDiskBytes * 0.7) break;
          try {
            await rm(oldest.repoPath, { recursive: true, force: true });
            this.accessHistory.delete(oldest.repoId);
            console.log(`[LRU Cache] ✔ Evicted '${oldest.repoId}' from ephemeral disk.`);
          } catch {
            // Ignore failure
          }
        }
      }
    } catch {
      // Non-critical; do not block operations if stat fails
    }
  }

  /**
   * Ensures the repository is ready on local disk. If cold or missing,
   * materializes it on-demand from S3.
   */
  async ensureRepoReady(repoId: string, isWrite: boolean): Promise<boolean> {
    const repoDir = this.getRepoPath(repoId);
    this.recordAccess(repoId, repoDir);

    // 1. Check if warm on disk
    let isWarm = false;
    try {
      const s = await stat(repoDir);
      isWarm = s.isDirectory();
    } catch {
      isWarm = false;
    }

    if (isWarm) {
      return true;
    }

    // 2. Cold disk: check S3 WAL
    const indexRes = await this.storage.getObject(`${repoId}/wal_index.json`);

    if (indexRes.status === 200 && indexRes.data) {
      await this.checkAndEvictDiskQuota();
      console.log(`[Auto-Materialize] Restoring cold repo '${repoId}' from S3 into local cache...`);
      const walIndex = WALIndex.fromBytes(indexRes.data);

      await this.initBareRepo(repoDir);
      const packDir = join(repoDir, "objects", "pack");
      await mkdir(packDir, { recursive: true });

      for (const packKey of walIndex.packfiles) {
        const packFileName = basename(packKey);
        const packRes = await this.storage.getObject(packKey);
        if (packRes.status === 200 && packRes.data) {
          const localPackPath = join(packDir, packFileName);
          await Bun.write(localPackPath, packRes.data);
          await runGit(["index-pack", localPackPath], { cwd: repoDir });
        }
      }

      for (const [refName, commitSha] of Object.entries(walIndex.references)) {
        await runGit(["update-ref", refName, commitSha], { cwd: repoDir });
        if (refName === "refs/heads/main" || refName === "refs/heads/master") {
          await runGit(["symbolic-ref", "HEAD", refName], { cwd: repoDir });
        }
      }

      console.log(`[Auto-Materialize] ✔ Repo '${repoId}' warm on disk!`);
      return true;
    }

    // 3. New repository first push
    if (isWrite) {
      await this.checkAndEvictDiskQuota();
      console.log(`[New Repo] Creating new bare repository for '${repoId}'...`);
      await this.initBareRepo(repoDir);
      return true;
    }

    return false;
  }

  /**
   * In-process FIFO write serialization lock per repository.
   */
  async withRepoLock<T>(repoId: string, fn: () => Promise<T>): Promise<T> {
    const currentLock = this.writeLocks.get(repoId) || Promise.resolve();
    let release: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });

    this.writeLocks.set(repoId, currentLock.then(() => nextLock));

    await currentLock;
    try {
      return await fn();
    } finally {
      release!();
      if (this.writeLocks.get(repoId) === nextLock) {
        this.writeLocks.delete(repoId);
      }
    }
  }

  /**
   * Streams newly pushed packfiles to S3 and commits wal_index.json via Atomic CAS.
   */
  async syncPushToS3(
    repoId: string,
    prePacks: Set<string>
  ): Promise<{ version: number; packfiles: string[] } | null> {
    return this.withRepoLock(repoId, async () => {
      const repoDir = this.getRepoPath(repoId);
      const packDir = join(repoDir, "objects", "pack");

      let currentPacks = new Set<string>();
      try {
        const files = await readdir(packDir);
        currentPacks = new Set(files.filter((f) => f.endsWith(".pack")));
      } catch {
        return null;
      }

      let newPacks = Array.from(currentPacks).filter((p) => !prePacks.has(p));

      if (newPacks.length === 0) {
        await runGit(["repack", "-d"], { cwd: repoDir });
        const files = await readdir(packDir);
        currentPacks = new Set(files.filter((f) => f.endsWith(".pack")));
        newPacks = Array.from(currentPacks).filter((p) => !prePacks.has(p));
      }

      if (newPacks.length === 0 && currentPacks.size > 0) {
        newPacks = [Array.from(currentPacks)[0]!];
      }

      // 1. Stream new packfiles to S3 (zero-memory buffer)
      const uploadedPackKeys: string[] = [];
      for (const packFileName of newPacks) {
        const packFilePath = join(packDir, packFileName);
        const s3Key = `${repoId}/wal/packs/${packFileName}`;

        const putRes = await this.storage.uploadFile(s3Key, packFilePath);
        if (putRes.status !== 200) {
          console.error(`Failed to stream ${packFileName} to S3:`, putRes.error);
          return null;
        }
        uploadedPackKeys.push(s3Key);
      }

      // 2. Discover current branch references
      const rawRefs = await runGit(["show-ref"], { cwd: repoDir }).catch(() => "");
      const references: Record<string, string> = {};
      for (const line of rawRefs.trim().split("\n")) {
        if (!line) continue;
        const [sha, ref] = line.trim().split(/\s+/);
        if (sha && ref) {
          references[ref] = sha;
        }
      }

      if (Object.keys(references).length === 0) {
        return null;
      }

      // 3. Jittered Exponential Backoff Atomic CAS commit loop
      const indexKey = `${repoId}/wal_index.json`;
      const maxRetries = 8;
      let finalIndex: WALIndex | null = null;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const getRes = await this.storage.getObject(indexKey);
        let nextIndex: WALIndex;
        let ifMatchHeader: string;

        if (getRes.status === 404) {
          nextIndex = WALIndex.createInitial(repoId, references, uploadedPackKeys);
          ifMatchHeader = "NONE";
        } else if (getRes.status === 200 && getRes.data) {
          const curIndex = WALIndex.fromBytes(getRes.data);
          nextIndex = curIndex.nextVersion({
            refUpdates: references,
            newPackfiles: uploadedPackKeys,
          });
          ifMatchHeader = getRes.etag!;
        } else {
          break;
        }

        const casRes = await this.storage.putObject(indexKey, nextIndex.toBytes(), {
          ifMatch: ifMatchHeader,
        });

        if (casRes.status === 200) {
          console.log(`[S3 WAL] ✔ Committed version ${nextIndex.version} for '${repoId}' to S3 (ETag: ${casRes.etag})`);
          finalIndex = nextIndex;
          break;
        }

        if (casRes.status === 412) {
          // Full jitter backoff: sleep = random(0, min(1000, 25 * 2^attempt))
          const maxBackoff = Math.min(1000, 25 * Math.pow(2, attempt));
          const jitteredDelay = Math.floor(Math.random() * maxBackoff);
          console.log(`[S3 WAL] CAS conflict on '${repoId}' (attempt ${attempt}/${maxRetries}), retrying in ${jitteredDelay}ms...`);
          await Bun.sleep(jitteredDelay);
          continue;
        }
      }

      if (!finalIndex) {
        return null;
      }

      // 4. Auto-Compaction Check (Phase 12)
      if (finalIndex.packfiles.length >= this.compactionThreshold) {
        console.log(`[Auto-Compaction] '${repoId}' has ${finalIndex.packfiles.length} packfiles (threshold: ${this.compactionThreshold}). Triggering compaction...`);
        // Run compaction asynchronously without blocking response
        this.compact(repoId).catch((err) => {
          console.error(`[Auto-Compaction] Background compaction failed for '${repoId}':`, err);
        });
      }

      return {
        version: finalIndex.version,
        packfiles: finalIndex.packfiles,
      };
    });
  }

  /**
   * Compaction Worker (Phase 12):
   * Consolidates loose packfiles into 1 unified packfile and atomically updates wal_index.json.
   */
  async compact(repoId: string): Promise<{ compactedPackKey: string; version: number } | null> {
    return this.withRepoLock(repoId, async () => {
      const repoDir = this.getRepoPath(repoId);
      const packDir = join(repoDir, "objects", "pack");

      // 1. Repack all objects locally
      await runGit(["repack", "-ad"], { cwd: repoDir });

      const files = await readdir(packDir);
      const packs = files.filter((f) => f.endsWith(".pack"));
      if (packs.length === 0) {
        return null;
      }

      const compactedPackName = packs[0]!;
      const localPackPath = join(packDir, compactedPackName);
      const s3Key = `${repoId}/wal/compacted/${compactedPackName}`;

      // 2. Stream compacted packfile to S3
      const putPackRes = await this.storage.uploadFile(s3Key, localPackPath);
      if (putPackRes.status !== 200) {
        console.error(`Failed to stream compacted pack to S3:`, putPackRes.error);
        return null;
      }

      // 3. Atomically update wal_index.json via CAS
      const indexKey = `${repoId}/wal_index.json`;
      const getRes = await this.storage.getObject(indexKey);
      if (getRes.status !== 200 || !getRes.data) {
        return null;
      }

      const curIndex = WALIndex.fromBytes(getRes.data);
      const nextIndex = curIndex.withCompaction(s3Key);

      const casRes = await this.storage.putObject(indexKey, nextIndex.toBytes(), {
        ifMatch: getRes.etag!,
      });

      if (casRes.status === 200) {
        console.log(`[Auto-Compaction] ✔ Consolidated '${repoId}' down to 1 packfile (v${nextIndex.version}) on S3!`);
        return {
          compactedPackKey: s3Key,
          version: nextIndex.version,
        };
      }

      return null;
    });
  }
}
