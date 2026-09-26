import type {
  ReferenceMap,
  WALIndexData,
  WALTransitionOptions,
} from "../types/wal.ts";

/**
 * Authoritative WAL Index model representing the state of a repository in S3/R2.
 * Immutable by design: every push or compaction produces a new WALIndex instance
 * with an incremented version counter.
 */
export class WALIndex implements WALIndexData {
  public readonly repoId: string;
  public readonly version: number;
  public readonly references: ReferenceMap;
  public readonly packfiles: string[];
  public readonly lastCompactedVersion: number;
  public readonly updatedAt: string;

  constructor(data: WALIndexData) {
    if (!data.repoId || data.repoId.trim().length === 0) {
      throw new Error("WALIndex: repoId cannot be empty");
    }
    if (data.version < 1) {
      throw new Error(`WALIndex: version must be >= 1, received ${data.version}`);
    }

    this.repoId = data.repoId;
    this.version = data.version;
    this.references = Object.freeze({ ...data.references });
    this.packfiles = Object.freeze([...data.packfiles]) as unknown as string[];
    this.lastCompactedVersion = data.lastCompactedVersion ?? 0;
    this.updatedAt = data.updatedAt || new Date().toISOString();
  }

  /**
   * Creates an initial Version 1 index for a newly initialized repository.
   */
  static createInitial(
    repoId: string,
    initialRefs: ReferenceMap = {},
    initialPackfiles: string[] = []
  ): WALIndex {
    return new WALIndex({
      repoId,
      version: 1,
      references: initialRefs,
      packfiles: initialPackfiles,
      lastCompactedVersion: 0,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Generates a new immutable state transition (version + 1).
   */
  nextVersion(options: WALTransitionOptions = {}): WALIndex {
    const updatedRefs: ReferenceMap = { ...this.references };

    // Apply ref updates (e.g. main branch pointing to new commit)
    if (options.refUpdates) {
      for (const [ref, sha] of Object.entries(options.refUpdates)) {
        updatedRefs[ref] = sha;
      }
    }

    // Apply ref deletions
    if (options.deletedRefs) {
      for (const ref of options.deletedRefs) {
        delete updatedRefs[ref];
      }
    }

    // Accumulate or replace packfiles
    let updatedPackfiles: string[];
    let lastCompactedVersion = this.lastCompactedVersion;

    if (options.compactedPackfile) {
      // Compaction: replace all previous individual packfiles with the single compacted pack
      updatedPackfiles = [options.compactedPackfile];
      lastCompactedVersion = this.version + 1;
    } else {
      updatedPackfiles = [...this.packfiles];
      if (options.newPackfiles) {
        for (const pack of options.newPackfiles) {
          if (!updatedPackfiles.includes(pack)) {
            updatedPackfiles.push(pack);
          }
        }
      }
    }

    return new WALIndex({
      repoId: this.repoId,
      version: this.version + 1,
      references: updatedRefs,
      packfiles: updatedPackfiles,
      lastCompactedVersion,
      updatedAt: new Date().toISOString(),
    });
  }

  /**
   * Convenience helper to create a next-version index with a single updated ref and packfile.
   */
  withPush(branch: string, commitSha: string, newPackfileKey?: string): WALIndex {
    const refKey = branch.startsWith("refs/") ? branch : `refs/heads/${branch}`;
    return this.nextVersion({
      refUpdates: { [refKey]: commitSha },
      newPackfiles: newPackfileKey ? [newPackfileKey] : undefined,
    });
  }

  /**
   * Convenience helper to transition to a compacted state.
   */
  withCompaction(compactedPackfileKey: string): WALIndex {
    return this.nextVersion({
      compactedPackfile: compactedPackfileKey,
    });
  }

  /**
   * Serializes the WAL index into a formatted JSON string.
   */
  toJSON(): string {
    return JSON.stringify(
      {
        repoId: this.repoId,
        version: this.version,
        references: this.references,
        packfiles: this.packfiles,
        lastCompactedVersion: this.lastCompactedVersion,
        updatedAt: this.updatedAt,
      },
      null,
      2
    );
  }

  /**
   * Serializes the WAL index into UTF-8 bytes for storage in S3/R2.
   */
  toBytes(): Uint8Array {
    return new TextEncoder().encode(this.toJSON());
  }

  /**
   * Deserializes a WAL index from a JSON string with validation.
   */
  static fromJSON(jsonStr: string): WALIndex {
    let parsed: any;
    try {
      parsed = JSON.parse(jsonStr);
    } catch (e: any) {
      throw new Error(`WALIndex.fromJSON failed to parse JSON: ${e.message}`);
    }

    return new WALIndex({
      repoId: parsed.repoId,
      version: parsed.version,
      references: parsed.references || {},
      packfiles: Array.isArray(parsed.packfiles) ? parsed.packfiles : [],
      lastCompactedVersion: parsed.lastCompactedVersion ?? 0,
      updatedAt: parsed.updatedAt,
    });
  }

  /**
   * Deserializes a WAL index from raw S3/R2 bytes.
   */
  static fromBytes(bytes: Uint8Array): WALIndex {
    const jsonStr = new TextDecoder().decode(bytes);
    return WALIndex.fromJSON(jsonStr);
  }
}
