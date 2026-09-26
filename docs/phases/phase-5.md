# Phase 5: Ephemeral Cold-Start Materialization ("Cattle, Not Pets")

> **Core Objective:** Implement on-demand repository materialization, allowing cold or freshly provisioned nodes with empty disks (0 bytes) to reconstruct fully operational repositories directly from AWS S3 in milliseconds.

---

## 🧠 1. The Architectural Problem It Solves

### The "Pet vs. Cattle" Dilemma
In traditional architectures (GitHub Spokes):
- Every repository was treated as a **pet**:
  - The system had to know the exact 3 servers where each repository lived.
  - If a disk was corrupted or two servers went down, quorum was lost and pushes halted.
  - Giant routing tables, disk checksum trackers, and heavy background repair daemons were required.

### The AI Agent Repository Explosion
In the modern AI coding era, AI agents generate **millions of tiny, ephemeral repositories**.
- 95% of these repositories sit completely idle after a few hours or days.
- If you treat them as pets, millions of idle repositories consume petabytes of expensive NVMe storage.
- In **Continuity**, repositories are **cattle**:
  - An idle repository can be completely deleted (`rm -rf`) from a server's local disk.
  - It costs **$0 compute and 0 bytes disk space** across your server fleet.
  - When an agent or developer requests it weeks later, the server materializes the entire repository on-demand from S3!

---

## ⚡ 2. How On-Demand Materialization Works

```
  COLD SERVER / NEW CONTAINER                   AWS S3 BUCKET (Source of Truth)
┌─────────────────────────────┐             ┌────────────────────────────────────┐
│ LOCAL NVME:                 │             │                                    │
│   0 BYTES (Clean / Empty)   │             │ 1. Download wal_index.json         │
│                             │ <────────── │    (refs, packfile manifest)       │
│ 2. Run `git init --bare`    │             │                                    │
│                             │             │ 3. Download active packfiles:      │
│ 4. Run `git index-pack`     │ <────────── │    - wal/packs/pack-001.pack       │
│                             │             │    - wal/packs/pack-002.pack       │
│ 5. Write `refs/heads/main`  │             │                                    │
│                             │             └────────────────────────────────────┘
│ REPO FULLY MATERIALIZED!    │
│ Ready to serve git clone!   │
└─────────────────────────────┘
```

### The Materialization Flow:
1. **Detection:** When a read request (`git clone`, `git fetch`, or web UI request) arrives at a node, the node checks if the local bare repo folder exists on its NVMe drive.
2. **Fetch WAL Index:** If the folder is missing (cold start or cache eviction), it requests `wal_index.json` from AWS S3.
3. **Initialize Empty Bare Repo:** Runs `git init --bare -b main <repoDir>`.
4. **Stream Active Packfiles:** Iterates through `walIndex.packfiles`, downloads each `.pack` file directly into `.git/objects/pack/`, and executes `git index-pack` to build local binary `.idx` lookup files.
5. **Reconstruct Branches & HEAD:** Writes each reference pointer (`refs/heads/*`) and sets `symbolic-ref HEAD refs/heads/main`.
6. **Serve Client:** The repository is now 100% complete and identical to before it was evicted. All Git history, tags, and commits are intact.

---

## 🛠️ 3. Implementation Blueprint

### The `materialize()` Method:
```typescript
async materialize(): Promise<MaterializeResult> {
  // 1. Fetch WAL index from S3
  const getRes = await this.storage.getObject(this.indexKey);
  if (getRes.status !== 200 || !getRes.data) {
    throw new Error(`Repository ${this.repoId} does not exist in S3 WAL`);
  }
  const walIndex = WALIndex.fromBytes(getRes.data);

  // 2. Initialize fresh bare Git repository
  await this.initRepo();
  const packDir = join(this.repoDir, "objects", "pack");

  // 3. Download and index all active packfiles
  for (const packKey of walIndex.packfiles) {
    const packFileName = basename(packKey);
    const packRes = await this.storage.getObject(packKey);
    const localPackPath = join(packDir, packFileName);
    await Bun.write(localPackPath, packRes.data!);
    await runGit(["index-pack", localPackPath], { cwd: this.repoDir });
  }

  // 4. Reconstruct Git references
  for (const [refName, commitSha] of Object.entries(walIndex.references)) {
    await runGit(["update-ref", refName, commitSha], { cwd: this.repoDir });
    if (refName === "refs/heads/main" || refName === "refs/heads/master") {
      await runGit(["symbolic-ref", "HEAD", refName], { cwd: this.repoDir });
    }
  }

  this.cachedIndex = walIndex;
  this.cachedETag = getRes.etag;
  return { success: true, version: walIndex.version };
}
```

### The `evictDisk()` Method:
```typescript
async evictDisk(): Promise<void> {
  await rm(this.repoDir, { recursive: true, force: true });
  this.cachedIndex = undefined;
  this.cachedETag = undefined;
}
```

---

## ✅ 4. What This Proves in Practice

When Phase 5 is active:
1. You can delete an entire replica’s disk folder (`rm -rf`).
2. Run `git clone` against that replica.
3. The replica self-heals by materializing from S3 in milliseconds.
4. The client receives a complete clone with zero error!
