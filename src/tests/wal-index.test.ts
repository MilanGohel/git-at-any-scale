import { describe, expect, it } from "bun:test";
import { WALIndex } from "../models/wal-index.ts";

describe("Phase 2: WAL Index Model & State Transitions", () => {
  it("should create initial version 1 index with defaults", () => {
    const index = WALIndex.createInitial("org/repo-1");

    expect(index.repoId).toBe("org/repo-1");
    expect(index.version).toBe(1);
    expect(index.references).toEqual({});
    expect(index.packfiles).toEqual([]);
    expect(index.lastCompactedVersion).toBe(0);
    expect(index.updatedAt).toBeDefined();
  });

  it("should serialize to bytes and deserialize back without loss", () => {
    const original = WALIndex.createInitial(
      "org/repo-1",
      { "refs/heads/main": "c8f3a09e" },
      ["org/repo-1/wal/packs/base.pack"]
    );

    const bytes = original.toBytes();
    const restored = WALIndex.fromBytes(bytes);

    expect(restored.repoId).toBe(original.repoId);
    expect(restored.version).toBe(original.version);
    expect(restored.references).toEqual(original.references);
    expect(restored.packfiles).toEqual(original.packfiles);
    expect(restored.updatedAt).toBe(original.updatedAt);
  });

  it("should create an immutable state transition on push (nextVersion)", () => {
    const v1 = WALIndex.createInitial("org/repo-1", {
      "refs/heads/main": "11111111",
      "refs/heads/feature": "22222222",
    }, ["packs/pack-1.pack"]);

    // Transition v1 -> v2 (updating main branch and appending new packfile)
    const v2 = v1.withPush("main", "33333333", "packs/pack-2.pack");

    // Verify v2 is incremented and updated
    expect(v2.version).toBe(2);
    expect(v2.references["refs/heads/main"]).toBe("33333333");
    expect(v2.references["refs/heads/feature"]).toBe("22222222"); // preserved
    expect(v2.packfiles).toEqual(["packs/pack-1.pack", "packs/pack-2.pack"]);

    // Verify v1 is completely untouched (immutability)
    expect(v1.version).toBe(1);
    expect(v1.references["refs/heads/main"]).toBe("11111111");
    expect(v1.packfiles).toEqual(["packs/pack-1.pack"]);
  });

  it("should support compaction transitions (replacing packfiles array)", () => {
    const v1 = WALIndex.createInitial("org/repo-1")
      .withPush("main", "commit-1", "packs/p1.pack")
      .withPush("main", "commit-2", "packs/p2.pack")
      .withPush("main", "commit-3", "packs/p3.pack");

    expect(v1.version).toBe(4);
    expect(v1.packfiles.length).toBe(3);

    // Primary executes compaction
    const compacted = v1.withCompaction("packs/compacted-all.pack");

    expect(compacted.version).toBe(5);
    // All individual packs replaced by the single compacted pack
    expect(compacted.packfiles).toEqual(["packs/compacted-all.pack"]);
    expect(compacted.lastCompactedVersion).toBe(5);
    // References are intact
    expect(compacted.references["refs/heads/main"]).toBe("commit-3");
  });

  it("should enforce validation rules", () => {
    // Empty repoId
    expect(() => new WALIndex({
      repoId: "",
      version: 1,
      references: {},
      packfiles: [],
      lastCompactedVersion: 0,
      updatedAt: new Date().toISOString(),
    })).toThrow("repoId cannot be empty");

    // Invalid version
    expect(() => new WALIndex({
      repoId: "test",
      version: 0,
      references: {},
      packfiles: [],
      lastCompactedVersion: 0,
      updatedAt: new Date().toISOString(),
    })).toThrow("version must be >= 1");

    // Invalid JSON
    expect(() => WALIndex.fromJSON("invalid-json{")).toThrow("failed to parse JSON");
  });
});
