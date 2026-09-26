# Phase 4: The Replica Node Engine (Conditional GET 304 & Delta Catchup)

> **Core Objective:** Implement read replicas that verify consistency with AWS S3 in <10ms using HTTP 304 conditional checks and download only missing delta packfiles when new pushes occur.

---

## 🧠 1. The Architectural Problem It Solves

In production, read operations (`git clone` and `git fetch`) heavily outnumber pushes:
- For every 1 push, hundreds of CI runners and developers clone the repository.
- If all reads hit the Primary Node, the primary's disk I/O and network bandwidth become exhausted.
- If reads hit asynchronous replicas that use eventual consistency, a developer who pushes commit `c8f3` and immediately triggers CI on a replica will see their build fail with `fatal: reference not found`!

In GitHub Spokes, Three-Phase Commit (3PC) synchronized 3 replicas. But 3PC cannot scale horizontally to 50 or 100 replicas because latency is bound to the slowest node (tail latency).

In **Continuity**:
- Replicas **do not coordinate with each other** and **do not talk to the primary**.
- Instead, every replica independently queries the single source of truth: **AWS S3**.

---

## ⚡ 2. The Read Lifecycle on a Replica

```
   CI RUNNER / DEVELOPER               REPLICA NODE (Warm NVMe)                AWS S3 BUCKET
  ┌──────────────────────┐         ┌───────────────────────────────┐       ┌────────────────────────┐
  │                      │         │                               │       │                        │
  │   git clone / fetch  │ ──────> │ 1. Read request received      │       │                        │
  │                      │         │    Check cached ETag: "v2tag" │       │                        │
  │                      │         │                               │       │                        │
  │                      │         │ 2. Conditional GET:           │ ────> │ wal_index.json         │
  │                      │         │    If-None-Match: "v2tag"     │       │                        │
  │                      │         │                               │       │                        │
  │                      │         │ 3. S3 Response:               │ <──── │ 304 Not Modified!      │
  │                      │         │    - 304? Serve from local NVMe       │ (<10ms, empty body)    │
  │                      │         │    - 200? Download missing    │       │                        │
  │                      │         │           packs & update refs │       │                        │
  │ Stream clone/fetch   │ <────── │ 4. Stream response to client  │       │                        │
  └──────────────────────┘         └───────────────────────────────┘       └────────────────────────┘
```

### The Two Read Paths:

#### Path A: The Hot Path (HTTP 304 Not Modified)
* The replica sends `GET wal_index.json` with header `If-None-Match: <cached_etag>`.
* If no new push occurred, S3 returns **`HTTP 304 Not Modified`**.
* **Body:** 0 bytes.
* **Latency:** <10ms (S3 metadata lookup).
* **Serving:** The replica streams the clone immediately from its local NVMe drive.

#### Path B: The Cold / Delta Path (HTTP 200 OK)
* If a new push occurred, S3 returns **`HTTP 200 OK`** with the updated `wal_index.json`.
* The replica compares S3's packfile list against what it has on local disk:
  - Local has: `[pack-1.pack]`
  - S3 has: `[pack-1.pack, pack-2.pack]`
  - **Delta:** Download *only* `pack-2.pack` from S3.
* The replica runs `git index-pack pack-2.pack` to generate `.idx` binary search indexes locally.
* The replica runs `git update-ref refs/heads/main <new_sha>` and updates `HEAD`.
* The replica caches the new ETag and serves the clone to the client.

---

## 🛠️ 3. Implementation Details

- **`src/engine/replica-node.ts`:**
  - `initRepo()`: initializes bare repository with `-b main`.
  - `syncForRead()`:
    1. Sends conditional GET to S3.
    2. Handles 304 cache hit (<10ms, 0 downloads).
    3. Handles 200 delta download (downloads only missing `.pack` files, runs `git index-pack`, updates `refs/heads/*` and `symbolic-ref HEAD`).

---

## ✅ 4. Verification & Testing

### Local Unit Tests:
```bash
bun test src/tests/replica-node.test.ts
```
Verifies:
- Cold sync downloads initial packfile (HTTP 200).
- Hot check returns HTTP 304 Not Modified with zero payload download.
- Subsequent pushes trigger delta-only downloads (only 1 packfile downloaded).

### Live AWS S3 Multi-Node Replication:
```bash
bun run test:s3:replication
```
Output against real AWS S3:
```
[1/5] Initializing cluster on AWS S3 (eu-north-1)...
[2/5] Author committing code and pushing to Primary Node...
✅ Push accepted by Primary and committed to S3 WAL (Version 1)
[3/5] Client triggers read on Replica 1 (Cold Catchup)...
  - S3 Status:        200
  - Downloaded Packs: pack-25a008...pack
  - Cloned from Replica 1 successfully!
[4/5] Client triggers second read on Replica 1 (Hot Path Check)...
  - S3 Status:        304 (Not Modified)
  - Cache Hit:        true (Instant Local NVMe read!)
  - Downloaded Packs: 0 bytes
[5/5] Replica 2 syncing independently from AWS S3...
  - Replica 2 Status: 200 (Version 1)
  - Cloned from Replica 2 successfully!
🎉 MULTI-NODE REPLICATION VERIFIED 100% WITH REAL AWS S3!
```
