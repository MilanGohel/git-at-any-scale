# Implementation Plan: Git at Any Scale (Continuity on Bun + Cloudflare R2)

> A phase-by-phase implementation of Cursor's **Continuity** architecture using **Bun**, **TypeScript**, and **Cloudflare R2** (S3-compatible object storage).

---

## 🎯 Architecture Overview

```
                               ┌──────────────────────────────────────────────────┐
                               │           CLOUDFLARE R2 OBJECT STORAGE           │
                               │                                                  │
                               │   ┌────────────────────┐  ┌──────────────────┐   │
                               │   │  wal_index.json    │  │  wal/packs/      │   │
                               │   │ (Refs & Pack list) │  │  (*.pack files)  │   │
                               │   └─────────▲──────────┘  └────────▲─────────┘   │
                               └─────────────┼──────────────────────┼─────────────┘
                                             │ Atomic CAS (If-Match)│ Upload Pack
                   ┌─────────────────────────┴──────────────────────┴─────────────┐
                   │                                                              │
         git push  │                                                              │
    ───────────────┼────────────────────────────────────────┐                     │
                   ▼                                        │                     │
       ┌────────────────────────┐              ┌────────────▼───────────┐         │
       │      PRIMARY NODE      │              │      REPLICA NODE      │         │
       │   (Local NVMe Cache)   │              │   (Local NVMe Cache)   │         │
       │                        │              │                        │         │
       │ 1. Bare repo receives  │              │ 1. Git read requested  │         │
       │    packfile locally    │              │ 2. If-None-Match GET   │         │
       │ 2. Streams to R2 WAL   │              │ 3. 304? Serve from NVMe│         │
       │ 3. CAS updates index   │              │ 4. 200? Fetch delta &  │         │
       │ 4. Fires UDP gossip    │              │    fast-forward refs   │         │
       └────────────────────────┘              └────────────────────────┘         │
                   │                                        ▲                     │
                   └─────────── Unreliable UDP Gossip ──────┘                     │
                               (Optimistic background hint)                       │
```

### Core Architectural Pillars
1. **R2 as the Single Source of Truth:** Local NVMe disks are purely disposable, warm caches ("cattle, not pets").
2. **Stateless Consensus via S3/R2 CAS:** No Raft, Paxos, or Three-Phase Commit (3PC). Atomic Compare-And-Swap (`If-Match`) on `wal_index.json` linearizes all pushes.
3. **Sub-10ms Read Freshness:** Replicas issue conditional GETs (`If-None-Match`). If fresh, R2 returns `304 Not Modified` in <10ms; the replica serves directly from local NVMe.
4. **Amortized Compaction:** Only the primary repacks; replicas download pre-compacted packs from R2, trading cheap network bandwidth for expensive CPU.

---

## 🚦 Phase Checklist

- [x] **Phase 1: Project Setup & Cloudflare R2 Storage Layer**
- [x] **Phase 2: The WAL Index Data Model & State Serialization**
- [x] **Phase 3: The Primary Node Engine (Packfile Ingestion & CAS Commit)**
- [x] **Phase 4: The Replica Node Engine (Conditional GET 304 & Delta Catchup)**
- [x] **Phase 5: Ephemeral Cold-Start Materialization ("Cattle, Not Pets")**
- [x] **Phase 6: Amortized Compaction (Primary Repacks, Replicas Download)**
- [x] **Phase 7: Stateless Consensus & Rendezvous Hashing**
- [x] **Phase 8: Origin Platform & Production Fleet Simulation**
- [x] **Phase 9: Single-Host Production Deployment on AWS EC2**
- [x] **Phase 10: Serverless Architecture on AWS Lambda (Function URLs & S3)**

---

## 📋 Detailed Phase Breakdown

### Phase 1: Project Setup & Cloudflare R2 Storage Layer
* **Goal:** Establish the Bun TypeScript environment and build the unified R2 storage abstraction.
* **Why it matters:** Continuity relies completely on S3/R2 conditional headers (`If-Match` for CAS and `If-None-Match` for cache validation).
* **Components:**
  - `package.json` & `tsconfig.json` configured for Bun.
  - `src/types/storage.ts`: Generic `R2StorageInterface` defining `getObject`, `putObject`, `listObjects`, and `deleteObject`.
  - `src/storage/mock-r2.ts`: In-memory thread-safe simulator that implements exact HTTP status codes (`200 OK`, `304 Not Modified`, `412 Precondition Failed`) and MD5 ETags for zero-credential local development.
  - `src/storage/cloudflare-r2.ts`: Production adapter using `@aws-sdk/client-s3` configured for Cloudflare R2 (`https://<account_id>.r2.cloudflarestorage.com`).
* **Verification:** Unit tests verifying that `putObject` with stale `If-Match` returns `412`, and `getObject` with matching `If-None-Match` returns `304`.

---

### Phase 2: The WAL Index Data Model & State Serialization
* **Goal:** Implement the authoritative WAL Index document schema and serialization logic.
* **Why it matters:** Replaces complex relational databases with a single, linearizable JSON manifest stored in R2.
* **Components:**
  - `src/types/wal.ts`:
    - `repoId`: string identifier.
    - `version`: monotonically increasing integer.
    - `references`: map of Git refs to commit SHAs (e.g., `{"refs/heads/main": "c8f3..."}`).
    - `packfiles`: ordered list of R2 object keys for active `.pack` files.
    - `lastCompactedVersion`: version at which compaction last ran.
    - `updatedAt`: ISO 8601 timestamp.
  - `src/models/wal-index.ts`: Helper class for cloning, validating, and generating the next version state.
* **Verification:** Test serializing to/from JSON and generating version transitions.

---

### Phase 3: The Primary Node Engine (Packfile Ingestion & CAS Commit)
* **Goal:** Implement the write path for ingesting client `git push` operations.
* **Why it matters:** Implements Cursor's linearizable write pipeline without distributed locks or 3PC.
* **Components:**
  - `src/engine/git-node.ts`: Core node class managing a local bare Git repository (`<repo>.git`).
  - Native Git integration using `Bun.spawn`:
    - Configuring `receive.unpackLimit = 1` and `transfer.unpackLimit = 1` to guarantee Git retains incoming objects as `.pack` files.
  - Ingestion flow:
    1. Accept incoming push to local bare repo.
    2. Detect newly created `.pack` file in `.git/objects/pack/`.
    3. Stream `.pack` file to Cloudflare R2 (`<repoId>/wal/packs/<hash>.pack`).
    4. Fetch current `wal_index.json` ETag from R2.
    5. Attempt atomic CAS `putObject` with `If-Match: <current_etag>`.
    6. If `412 Precondition Failed` (concurrent push race), refetch latest index, rebase ref updates, and retry.
* **Verification:** Push real commits from a client folder and verify both the `.pack` and `wal_index.json` appear in R2.

---

### Phase 4: The Replica Node Engine (Conditional GET 304 & Delta Catchup)
* **Goal:** Implement read replication that serves clones and fetches with minimal R2 overhead.
* **Why it matters:** Allows read capacity to scale linearly across 100+ replicas without impacting write throughput.
* **Components:**
  - Read verification flow in `src/engine/git-node.ts`:
    1. Client triggers `git clone` or `git fetch` against replica.
    2. Replica executes conditional GET to R2: `getObject(indexKey, { ifNoneMatch: cachedETag })`.
    3. **HTTP 304:** Cache is 100% fresh! Replica immediately serves from local NVMe drive (<10ms).
    4. **HTTP 200:** Newer version exists. Replica downloads only missing `.pack` files from R2, runs `git index-pack` to build local indices, updates branch refs (`git update-ref`), and updates cached ETag.
* **Verification:** Confirm that subsequent reads against a static replica return 304 and touch 0 pack bytes.

---

### Phase 5: Ephemeral Cold-Start Materialization ("Cattle, Not Pets")
* **Goal:** Enable empty-disk nodes to reconstruct a fully operational repository from R2 in milliseconds.
* **Why it matters:** Solves the resource footprint of millions of idle AI agent repositories. Repositories can be evicted from disk when idle and materialized on-demand.
* **Components:**
  - `materialize()` method in `src/engine/git-node.ts`:
    1. Fetch `wal_index.json` from R2.
    2. Initialize an empty bare repo (`git init --bare`).
    3. Download all active `.pack` files listed in the index into `objects/pack/`.
    4. Run `git index-pack` on downloaded packs.
    5. Reconstruct all reference files (`refs/heads/*`).
* **Verification:** Wipe a replica's disk completely (0 bytes), run `materialize()`, and verify `git log` and `git checkout` produce 100% identical history.

---

### Phase 6: Amortized Compaction (Primary Repacks, Replicas Download)
* **Goal:** Mitigate packfile fragmentation without degrading replica CPU performance.
* **Why it matters:** In Spokes, every replica had to run expensive `git repack` jobs. Continuity offloads this entirely to the primary.
* **Components:**
  - `compact()` method on Primary:
    1. Primary runs `git repack -ad` to consolidate multiple packfiles into a single optimized `.pack`.
    2. Primary uploads the compacted `.pack` to R2 (`wal/compacted/<hash>.pack`).
    3. Primary CAS-updates `wal_index.json` to replace the list of individual packfiles with the single compacted packfile.
  - Replica sync logic:
    - Replicas fetch the new index, download the single compacted packfile, and prune old packfiles from local disk.
* **Verification:** Push 5 distinct commits to generate 5 packfiles, run compaction, and verify that the WAL index is pruned to a single packfile.

---

### Phase 8: Origin Platform & Production Fleet Simulation
* **Goal:** Create the unified production platform simulation and live cloud verification CLI.
* **Components:**
  - `src/demo.ts`: CLI runner orchestrating:
    - 3-node topology via Rendezvous Hashing (HRW).
    - Ingestion and Atomic S3 CAS.
    - Sub-10ms HTTP 304 validation.
    - Concurrent push collision & HTTP 412 resolution.
    - Ephemeral cold-start materialization.
    - Amortized compaction & replica pruning.
    - Zero-election crash failover.
  - `src/tests/origin-platform.test.ts`: Automated E2E verification test suite.
* **Verification:** `bun run demo` (in-memory) and `bun run demo:s3` (live AWS S3) run with exit code 0.

---

### Phase 9: Single-Host Production Deployment on AWS EC2
* **Goal:** Deploy the engine as a live Git Smart HTTP server on a single EC2 host, backed by AWS S3.
* **Components:**
  - `src/server/git-http-server.ts`: Native Git Smart HTTP server (`git-upload-pack` and `git-receive-pack`) via `Bun.serve`.
  - Automatic on-demand cold materialization on clone/fetch.
  - Automatic packfile extraction and S3 CAS commit on push.
  - `Dockerfile` & `docker-compose.yml` for containerized single-host hosting.
  - `deploy/setup-ec2.sh` for one-command Amazon Linux / Ubuntu bootstrap.
* **Verification:** Run `git clone http://<ec2-ip>:3000/<repo>.git` and `git push` from standard local Git CLI.

---

### Phase 10: Serverless Architecture on AWS Lambda (Function URLs & S3)
* **Goal:** Migrate from dedicated EC2 virtual machines to pure serverless execution on AWS Lambda for $0 idle cost and auto-scaling.
* **Components:**
  - `Dockerfile.lambda`: Containerized Lambda image with Bun, native Git, and official AWS Lambda Web Adapter (`aws-lambda-adapter`).
  - Ephemeral `/tmp` caching (512MB-10GB) with Phase 5 cold materialization.
  - Lambda Function URLs with Response Streaming for 15-minute timeouts and binary packfile streaming.
  - `deploy/deploy-lambda.sh`: Automated deployment script creating ECR repository, IAM role, and Lambda Function URL.
* **Verification:** `git clone https://<lambda-id>.lambda-url.<region>.on.aws/<repo>.git` and `git push` directly against serverless endpoint.
