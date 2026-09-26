/**
 * Data structures and types for Continuity's WAL Index.
 */

export type ReferenceMap = Record<string, string>;

export interface WALIndexData {
  /**
   * Unique identifier of the repository within the bucket.
   * e.g. "org/project-core"
   */
  repoId: string;

  /**
   * Monotonically increasing version number (1, 2, 3...).
   * Provides strict linearizability across all nodes.
   */
  version: number;

  /**
   * Map of Git references to target commit SHAs.
   * e.g. { "refs/heads/main": "c8f3a09e..." }
   */
  references: ReferenceMap;

  /**
   * Ordered list of active packfile keys in S3/R2 required
   * to reconstruct the repository history.
   * e.g. [ "repo/wal/packs/pack-001.pack", ... ]
   */
  packfiles: string[];

  /**
   * The version number at which compaction was last performed.
   */
  lastCompactedVersion: number;

  /**
   * ISO 8601 UTC timestamp of the last write.
   */
  updatedAt: string;
}

export interface WALTransitionOptions {
  refUpdates?: ReferenceMap;
  deletedRefs?: string[];
  newPackfiles?: string[];
  compactedPackfile?: string;
}
