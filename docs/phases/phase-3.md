# Phase 3: The Primary Node Engine (Packfile Ingestion & CAS Commit)

> **Core Objective:** Build the Primary Node engine that receives client Git pushes on a local bare repository, streams binary packfiles to S3/R2, and commits linear state transitions via S3 Atomic Compare-And-Swap (CAS).

---

## 🧠 1. The Architectural Problem It Solves

When Linus Torvalds designed Git, bare repositories were expected to manage incoming pushes locally on developer workstations or dedicated servers. By default:
- If a push contains fewer than 100 objects, standard Git **unpacks them into loose individual files** inside `objects/xx/`.
- Loose objects cause filesystem fragmentation, destroy I/O performance at scale, and cannot be cleanly stored as atomic Write-Ahead Log units in S3.

Furthermore, in multi-server architectures, accepting a push usually requires distributed database locking. If two developers push simultaneously, systems without proper synchronization suffer from silent overwrites or corrupted refs.

Continuity solves this by:
1. Forcing Git to **always store incoming objects inside binary `.pack` files**.
2. Uploading the immutable `.pack` file directly to S3 as a WAL unit.
3. Using **S3 Atomic Compare-And-Swap (`If-Match`)** to serialize commits without distributed locks.

---

## ⚡ 2. The Ingestion Pipeline (Step-by-Step)

```
 DEVELOPER / CLIENT              PRIMARY NODE (Warm NVMe)               AWS S3 BUCKET
┌─────────────────┐           ┌─────────────────────────────┐       ┌────────────────────────┐
│                 │           │                             │       │                        │
│ 1. git push     │ ────────> │ Bare repo receives push     │       │                        │
│                 │           │ Writes packfile to disk     │       │                        │
│                 │           │                             │       │                        │
│                 │           │ 2. Upload pack to S3 ───────┼─────> │ wal/packs/<hash>.pack  │
│                 │           │                             │       │ (Immutable WAL unit)   │
│                 │           │ 3. Fetch current ETag       │ <──── │ GET wal_index.json     │
│                 │           │                             │       │                        │
│                 │           │ 4. Put with If-Match (CAS)  │ ────> │ PUT wal_index.json     │
│                 │           │    - 200 OK? Success!       │       │ (Version N+1)          │
│                 │           │    - 412? Conflict! Retry   │       │                        │
│ 5. Push Success │ <──────── │ Acknowledge push to client  │       │                        │
└─────────────────┘           └─────────────────────────────┘       └────────────────────────┘
```

### Step 1: The Essential Git Configuration
When initializing the local bare repository, `PrimaryNode` sets:
```bash
git config receive.unpackLimit 1
git config transfer.unpackLimit 1
```
This forces Git to **never unpack objects**. Every incoming push is strictly stored as a `.pack` binary file with an accompanying `.idx` index file.

### Step 2: Streaming to S3 as an Immutable WAL Entry
When `git push` runs:
- The newly created `.pack` file in `.git/objects/pack/` is detected.
- The raw binary bytes are immediately uploaded to S3:
  `s3://<bucket>/<repoId>/wal/packs/pack-<hash>.pack`
- Because packfiles are content-addressed by their Git SHA, they are **immutable**. Uploading them requires **zero locks and zero consensus**.

### Step 3: Atomic Publication via S3 Compare-And-Swap (CAS)
Even though the packfile is in S3, **the commit is not yet visible to anyone** because `wal_index.json` has not been updated.
- The Primary reads the current `wal_index.json` and its `ETag`.
- It generates the next version with the new branch commit SHA and the new packfile key.
- It calls `storage.putObject` with `If-Match: <current_etag>`.
- **If 200 OK:** S3 confirms the CAS write. The push is officially linear and durable.
- **If 412 Precondition Failed:** Another process updated the index concurrently. The Primary catches the 412, waits a jittered backoff (20–50ms), refetches the newest index, and retries.

---

## 🛠️ 3. Implementation Details

- **`src/engine/git-process.ts`:** Wraps `Bun.spawn` for executing native Git commands (`git init --bare -b main`, `git rev-parse`, `git config`).
- **`src/engine/primary-node.ts`:**
  - `initRepo()`: sets up bare repo with `unpackLimit = 1`.
  - `ingestPush(clientRepoPath, branch)`: detects new packfiles, uploads them to S3, and executes the CAS retry loop.

---

## ✅ 4. Verification & Testing

### Local Integration Tests:
```bash
bun test src/tests/primary-node.test.ts
```
Verifies:
- First push uploads `.pack` and creates `wal_index.json` (v1).
- Second push advances `wal_index.json` to v2 and appends the second packfile.

### Live AWS S3 Test:
```bash
bun run test:s3
```
Pushes a real local Git repository directly to your live AWS S3 bucket, verifying that both `wal_index.json` and `wal/packs/*.pack` appear in AWS!
