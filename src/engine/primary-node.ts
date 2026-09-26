import { readdir, mkdir, rm, stat } from "node:fs/promises";
import { join, basename } from "node:path";
import type { R2StorageInterface } from "../types/storage.ts";
import { WALIndex } from "../models/wal-index.ts";
import { runGit } from "./git-process.ts";

export interface IngestPushResult {
  success: boolean;
  commitSha: string;
  version: number;
  etag: string;
  newPackfiles: string[];
}

/**
 * Primary Node Engine in Cursor's Continuity architecture.
 *
 * Responsibilities:
 * 1. Hosts a local bare Git repository on NVMe disk (warm cache).
 * 2. Ingests client Git pushes with packfiles preserved (`unpackLimit = 1`).
 * 3. Streams newly created packfiles to Cloudflare R2 / S3 as immutable WAL entries.
 * 4. Publishes updates atomically via S3 Compare-And-Swap (CAS) on `wal_index.json`.
 * 5. Automatically retries if a concurrent push race causes an HTTP 412.
 */
export class PrimaryNode {
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
   * Initializes the bare Git repository on the node's local disk with
   * Continuity's required unpack configurations.
   */
  async initRepo(): Promise<void> {
    await rm(this.repoDir, { recursive: true, force: true });
    await mkdir(this.repoDir, { recursive: true });

    // Initialize bare repository with main as default branch
    await runGit(["init", "--bare", "-b", "main", this.repoDir]);

    // Ensure pushes are accepted on bare branches
    await runGit(["config", "receive.denyCurrentBranch", "ignore"], { cwd: this.repoDir });

    // CRUCIAL: Prevent Git from unpacking objects into loose files
    // Forces Git to retain all incoming push objects as binary .pack files!
    await runGit(["config", "receive.unpackLimit", "1"], { cwd: this.repoDir });
    await runGit(["config", "transfer.unpackLimit", "1"], { cwd: this.repoDir });
  }

  /**
   * Checks whether the repository is currently warm on local disk.
   */
  async isDiskWarm(): Promise<boolean> {
    try {
      const s = await stat(this.repoDir);
      return s.isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Simulates cache eviction ("cattle, not pets").
   * Completely removes the repository from local disk to free up resources.
   */
  async evictDisk(): Promise<void> {
    await rm(this.repoDir, { recursive: true, force: true });
    this.cachedIndex = undefined;
    this.cachedETag = undefined;
  }

  /**
   * Materializes the repository from S3/R2 WAL onto local disk.
   */
  async materialize(): Promise<void> {
    const indexRes = await this.storage.getObject(this.indexKey);
    if (indexRes.status !== 200 || !indexRes.data) {
      throw new Error(`Cannot materialize: Repository '${this.repoId}' not found in S3 WAL`);
    }

    const walIndex = WALIndex.fromBytes(indexRes.data);
    await this.initRepo();

    const packDir = join(this.repoDir, "objects", "pack");
    await mkdir(packDir, { recursive: true });

    for (const packKey of walIndex.packfiles) {
      const packFileName = basename(packKey);
      const localPackPath = join(packDir, packFileName);

      const packRes = await this.storage.getObject(packKey);
      if (packRes.status !== 200 || !packRes.data) {
        throw new Error(`Failed to download packfile ${packKey} during materialization`);
      }

      await Bun.write(localPackPath, packRes.data);
      await runGit(["index-pack", localPackPath], { cwd: this.repoDir });
    }

    for (const [refName, commitSha] of Object.entries(walIndex.references)) {
      await runGit(["update-ref", refName, commitSha], { cwd: this.repoDir });
      if (refName === "refs/heads/main" || refName === "refs/heads/master") {
        await runGit(["symbolic-ref", "HEAD", refName], { cwd: this.repoDir });
      }
    }

    this.cachedIndex = walIndex;
    this.cachedETag = indexRes.etag;
  }

  /**
   * Reads all existing .pack files in the local objects/pack directory.
   */
  private async getExistingPackfiles(): Promise<Set<string>> {
    const packDir = join(this.repoDir, "objects", "pack");
    try {
      const files = await readdir(packDir);
      return new Set(files.filter((f) => f.endsWith(".pack")));
    } catch {
      return new Set();
    }
  }

  /**
   * Ingests a Git push from a client repository into the primary bare repository:
   * 1. Runs git push from client to this node's bare repo.
   * 2. Detects the newly created .pack file.
   * 3. Uploads the .pack file to Cloudflare R2 / S3.
   * 4. Updates wal_index.json via Atomic Compare-And-Swap (CAS).
   * 5. If HTTP 412 is returned (race condition), automatically retries.
   */
  async ingestPush(
    clientRepoPath: string,
    branch: string = "main",
    maxRetries: number = 5
  ): Promise<IngestPushResult> {
    const packDir = join(this.repoDir, "objects", "pack");
    const preExistingPacks = await this.getExistingPackfiles();

    // 1. Execute git push into the primary bare repository
    await runGit(["push", this.repoDir, branch], { cwd: clientRepoPath });

    // 2. Discover newly created packfiles
    let currentPacks = await this.getExistingPackfiles();
    let newPacks = Array.from(currentPacks).filter((p) => !preExistingPacks.has(p));

    // Fallback: If Git somehow did not generate a .pack file, repack to guarantee packfile storage
    if (newPacks.length === 0) {
      await runGit(["repack", "-d"], { cwd: this.repoDir });
      currentPacks = await this.getExistingPackfiles();
      newPacks = Array.from(currentPacks).filter((p) => !preExistingPacks.has(p));
    }

    if (newPacks.length === 0) {
      // In case no new objects were created (e.g. empty commit or already present)
      const allPacks = Array.from(currentPacks);
      if (allPacks.length > 0) {
        newPacks = [allPacks[0]!];
      }
    }

    // 3. Resolve the newly pushed commit SHA
    const refKey = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
    const commitSha = await runGit(["rev-parse", refKey], { cwd: this.repoDir });

    // 4. Upload newly created packfiles to Cloudflare R2 / S3
    const uploadedPackKeys: string[] = [];
    for (const packFileName of newPacks) {
      const packFilePath = join(packDir, packFileName);
      const fileBytes = await Bun.file(packFilePath).bytes();
      const s3Key = `${this.repoId}/wal/packs/${packFileName}`;

      const putRes = await this.storage.putObject(s3Key, fileBytes);
      if (putRes.status !== 200) {
        throw new Error(`Failed to upload packfile ${packFileName} to R2: ${putRes.error}`);
      }
      uploadedPackKeys.push(s3Key);
    }

    // 5. Atomic Compare-And-Swap (CAS) loop on wal_index.json
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const getRes = await this.storage.getObject(this.indexKey);

      let nextIndex: WALIndex;
      let ifMatchHeader: string;

      if (getRes.status === 404) {
        // Initial repository creation in S3/R2
        nextIndex = WALIndex.createInitial(
          this.repoId,
          { [refKey]: commitSha },
          uploadedPackKeys
        );
        ifMatchHeader = "NONE";
      } else if (getRes.status === 200 && getRes.data) {
        // Existing repository: produce next version transition
        const currentIndex = WALIndex.fromBytes(getRes.data);
        nextIndex = currentIndex.nextVersion({
          refUpdates: { [refKey]: commitSha },
          newPackfiles: uploadedPackKeys,
        });
        ifMatchHeader = getRes.etag!;
      } else {
        throw new Error(`Unexpected S3/R2 status [${getRes.status}] reading ${this.indexKey}`);
      }

      // Execute Atomic CAS Put
      const casRes = await this.storage.putObject(this.indexKey, nextIndex.toBytes(), {
        ifMatch: ifMatchHeader,
      });

      if (casRes.status === 200) {
        // Commit acknowledged and linear in S3/R2!
        this.cachedIndex = nextIndex;
        this.cachedETag = casRes.etag;

        return {
          success: true,
          commitSha,
          version: nextIndex.version,
          etag: casRes.etag!,
          newPackfiles: uploadedPackKeys,
        };
      }

      if (casRes.status === 412) {
        // Precondition Failed: Another push updated wal_index.json concurrently
        if (attempt === maxRetries) {
          throw new Error(
            `CAS write failed for ${this.repoId} after ${maxRetries} attempts due to high contention.`
          );
        }
        // Jittered backoff before retrying
        const backoffMs = Math.floor(Math.random() * 30) + 20;
        await Bun.sleep(backoffMs);
        continue;
      }

      throw new Error(`Failed to commit WAL index to S3/R2: ${casRes.error}`);
    }

    throw new Error(`Exhausted retries attempting to ingest push for ${this.repoId}`);
  }
}
