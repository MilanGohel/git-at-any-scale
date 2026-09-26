import { readdir, mkdir, rm } from "node:fs/promises";
import { join, basename } from "node:path";
import type { R2StorageInterface } from "../types/storage.ts";
import { WALIndex } from "../models/wal-index.ts";
import { runGit } from "./git-process.ts";

export interface ReplicaSyncResult {
  cacheHit: boolean;
  status: 200 | 304;
  version: number;
  downloadedPacks: string[];
  latencyMs: number;
}

/**
 * Replica Node Engine in Cursor's Continuity architecture.
 *
 * Responsibilities:
 * 1. Hosts a local bare Git repository on NVMe disk (warm read cache).
 * 2. Before serving a read (git clone / git fetch), issues a sub-10ms conditional
 *    GET (If-None-Match: <cached_etag>) to AWS S3 / Cloudflare R2.
 * 3. On HTTP 304 Not Modified: Cache is fresh! Serves immediately from local NVMe (0 bytes downloaded).
 * 4. On HTTP 200 OK: Downloads only missing delta packfiles, generates .idx via `git index-pack`,
 *    and fast-forwards local branch references via `git update-ref`.
 */
export class ReplicaNode {
  public readonly nodeId: string;
  public readonly storage: R2StorageInterface;
  public readonly repoId: string;
  public readonly repoDir: string;
  public readonly indexKey: string;

  public cachedIndex?: WALIndex;
  public cachedETag?: string;

  constructor(
    nodeId: string,
    storage: R2StorageInterface,
    repoId: string,
    workDir: string
  ) {
    this.nodeId = nodeId;
    this.storage = storage;
    this.repoId = repoId;
    const sanitizedName = repoId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.repoDir = join(workDir, `${nodeId}_${sanitizedName}.git`);
    this.indexKey = `${repoId}/wal_index.json`;
  }

  /**
   * Initializes an empty bare repository on the replica's local disk.
   */
  async initRepo(): Promise<void> {
    await rm(this.repoDir, { recursive: true, force: true });
    await mkdir(this.repoDir, { recursive: true });

    await runGit(["init", "--bare", "-b", "main", this.repoDir]);
    await runGit(["config", "receive.denyCurrentBranch", "ignore"], { cwd: this.repoDir });
    await runGit(["config", "receive.unpackLimit", "1"], { cwd: this.repoDir });
    await runGit(["config", "transfer.unpackLimit", "1"], { cwd: this.repoDir });
  }

  /**
   * Discovers which .pack files already exist on the replica's local disk.
   */
  private async getLocalPackfiles(): Promise<Set<string>> {
    const packDir = join(this.repoDir, "objects", "pack");
    try {
      const files = await readdir(packDir);
      return new Set(files.filter((f) => f.endsWith(".pack")));
    } catch {
      return new Set();
    }
  }

  /**
   * Synchronizes the replica before serving a read operation:
   * 1. Issues a conditional GET (If-None-Match: cachedETag) against S3/R2.
   * 2. If S3 returns 304: Local cache is up-to-date! Serves clone directly from NVMe.
   * 3. If S3 returns 200: Downloads delta packfiles from S3, builds local .idx,
   *    and advances local branch refs.
   */
  async syncForRead(): Promise<ReplicaSyncResult> {
    const startTime = performance.now();

    // Ensure local bare repo directory exists
    const localPacks = await this.getLocalPackfiles();
    if (localPacks.size === 0 && !this.cachedIndex) {
      await this.initRepo();
    }

    // 1. Send conditional GET to S3/R2
    const getRes = await this.storage.getObject(this.indexKey, {
      ifNoneMatch: this.cachedETag,
    });

    const latencyMs = Math.round((performance.now() - startTime) * 100) / 100;

    // 2A. Hot Path: HTTP 304 Not Modified
    if (getRes.status === 304) {
      return {
        cacheHit: true,
        status: 304,
        version: this.cachedIndex ? this.cachedIndex.version : 0,
        downloadedPacks: [],
        latencyMs,
      };
    }

    // 2B. Cold / Delta Path: HTTP 200 OK
    if (getRes.status === 200 && getRes.data) {
      const latestIndex = WALIndex.fromBytes(getRes.data);
      const packDir = join(this.repoDir, "objects", "pack");
      await mkdir(packDir, { recursive: true });

      const downloadedPacks: string[] = [];

      // Download only the packfiles not yet present on local disk
      for (const packKey of latestIndex.packfiles) {
        const packFileName = basename(packKey);
        if (!localPacks.has(packFileName)) {
          const packRes = await this.storage.getObject(packKey);
          if (packRes.status !== 200 || !packRes.data) {
            throw new Error(`Replica failed to download packfile ${packKey} from S3/R2`);
          }

          const localPackPath = join(packDir, packFileName);
          await Bun.write(localPackPath, packRes.data);

          // Generate .idx index file locally for Git binary fast lookup
          await runGit(["index-pack", localPackPath], { cwd: this.repoDir });
          downloadedPacks.push(packFileName);
        }
      }

      // Fast-forward local references to match the authoritative WAL index
      for (const [refName, commitSha] of Object.entries(latestIndex.references)) {
        await runGit(["update-ref", refName, commitSha], { cwd: this.repoDir });
        if (refName === "refs/heads/main" || refName === "refs/heads/master") {
          await runGit(["symbolic-ref", "HEAD", refName], { cwd: this.repoDir });
        }
      }

      this.cachedIndex = latestIndex;
      this.cachedETag = getRes.etag;

      return {
        cacheHit: false,
        status: 200,
        version: latestIndex.version,
        downloadedPacks,
        latencyMs,
      };
    }

    throw new Error(`Failed to sync replica: S3/R2 returned status ${getRes.status}`);
  }
}
