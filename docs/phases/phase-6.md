# Phase 6: Amortized Compaction (Trading Bandwidth for CPU)

> **Core Objective:** Eliminate Git packfile fragmentation without overloading replica CPUs by having only the Primary Node repack, upload the consolidated packfile to S3, and allow Replicas to download the ready-made pack.

---

## 🧠 1. The Architectural Problem It Solves

### The Packfile Fragmentation Penalty
In Git, every `git push` produces a new binary `.pack` file and an accompanying `.idx` file:
- 10 pushes = 10 packfiles.
- 1,000 pushes = 1,000 packfiles.

When a client runs `git log`, `git checkout`, or `git clone`, Git must locate objects. If the repository has 1,000 packfiles, Git has to open and search 1,000 separate index files to resolve a single file blob. What is normally a fast $O(1)$ binary search on a single index degrades into an expensive $O(N)$ multi-file traversal.

### The Spokes Failure Mode
In GitHub's traditional architecture (**Spokes**):
- Every single replica had to run `git repack` locally on its own CPU.
- `git repack` is notoriously CPU- and memory-intensive: Git must decompress objects, compute delta chains against neighboring objects, and compress them into a new file.
- When background repacking was triggered on multiple replicas simultaneously, **CPU utilization spiked to 100%**, causing request timeouts, node failovers, and cluster-wide latency spikes.

---

## ⚡ 2. The Continuity Solution: Amortized Repacking

In Cursor's **Continuity**, repacking is completely offloaded to the Primary:

```
  BEFORE COMPACTION (10 Pushes = 10 Separate Packfiles)
  S3 Manifest: [pack-1.pack, pack-2.pack, pack-3.pack, ..., pack-10.pack]
  
  ════════════════════════════════════════════════════════════════════════════════
  
  DURING COMPACTION (Primary Node Only):
  1. Primary runs `git repack -ad` locally on its NVMe drive.
     (Merges all 10 loose packs into 1 single unified packfile: `pack-compacted.pack`).
  2. Primary uploads `wal/compacted/pack-compacted.pack` to S3.
  3. Primary executes an Atomic CAS on `wal_index.json`:
     Replaces the array of 10 packfile keys with [pack-compacted.pack]!

  ════════════════════════════════════════════════════════════════════════════════

  AFTER COMPACTION (Replicas):
  - Replicas NEVER repack locally (saving thousands of CPU core-hours!).
  - When replicas sync, they see the new single pack in S3.
  - Replicas download `pack-compacted.pack` and delete the old 10 packs from local disk.
  - "Trading cheap S3 network bandwidth for expensive replica CPU cycles."
```

---

## 🔬 3. The Compaction Flow (Step-by-Step)

### Step 1: Local Repack on Primary
The Primary runs:
```bash
git repack -ad
```
- `-a`: Packs all objects into a single packfile.
- `-d`: Deletes redundant loose objects after packing.

### Step 2: Upload to S3
The newly generated unified `.pack` file is uploaded to:
`s3://<bucket>/<repoId>/wal/compacted/pack-<hash>.pack`

### Step 3: Atomic CAS State Transition
The Primary reads the current `wal_index.json` and transitions to a compacted state:
```typescript
const compactedIndex = currentIndex.withCompaction(compactedPackS3Key);
// Result:
// - version: N + 1
// - packfiles: ["repo/wal/compacted/pack-compacted.pack"] (All old packs pruned!)
// - lastCompactedVersion: N + 1
```
The Primary executes an Atomic CAS (`If-Match: currentETag`). Once committed, the compaction is official.

### Step 4: Replicas Download & Prune
When a Replica runs `syncForRead()`:
1. It downloads the single `pack-compacted.pack`.
2. It runs `git index-pack` to build the local index.
3. It removes the old fragmented `.pack` and `.idx` files from its local `objects/pack/` directory.
4. **Replica CPU impact:** Nearly zero!

---

## 🛠️ 4. Code Implementation Blueprint

### `PrimaryNode.compact()`:
```typescript
async compact(): Promise<CompactResult> {
  // 1. Run git repack -ad locally
  await runGit(["repack", "-ad"], { cwd: this.repoDir });

  // 2. Discover the new unified packfile
  const packs = await this.getLocalPackfiles();
  const compactedPackName = Array.from(packs)[0];
  const s3Key = `${this.repoId}/wal/compacted/${compactedPackName}`;

  // 3. Upload to S3
  const packBytes = await Bun.file(join(this.repoDir, "objects", "pack", compactedPackName)).bytes();
  await this.storage.putObject(s3Key, packBytes);

  // 4. Update wal_index.json via Atomic CAS
  const getRes = await this.storage.getObject(this.indexKey);
  const curIndex = WALIndex.fromBytes(getRes.data!);
  const nextIndex = curIndex.withCompaction(s3Key);

  await this.storage.putObject(this.indexKey, nextIndex.toBytes(), { ifMatch: getRes.etag });
  return { success: true, version: nextIndex.version, compactedPackKey: s3Key };
}
```

---

## ✅ 5. Verification Criteria

1. Ingest 5 separate pushes to generate 5 distinct `.pack` files in S3.
2. Verify `wal_index.json` lists 5 packfiles.
3. Execute `primary.compact()`.
4. Verify `wal_index.json` now lists exactly **1 single packfile** and increments version.
5. Replicas sync: assert that replicas download the single packfile and can successfully clone without running `git repack`.
