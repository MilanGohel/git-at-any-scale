# Phase 8: Origin Platform & Production Fleet Scaling

> **Core Objective:** Assemble the complete production platform (**Origin**), detailing real-world enterprise monorepo scaling, S3 Express One Zone latency optimizations, time-travel history rewinding, and the unified simulation CLI.

---

## 🏛️ 1. The Complete Origin Architecture

Bringing all components together, Cursor's **Origin** platform looks like this:

```
                            INTERNET / AGENTS / DEVELOPERS
                                           │
                                           ▼
                            ┌─────────────────────────────┐
                            │   API GATEWAY / LOAD BAL    │
                            │   (Rendezvous Hashing)      │
                            └──────┬───────────────┬──────┘
                                   │               │
                     git push      │               │  git clone / fetch
                     (Writes)      │               │  (Reads - 100+ Replicas)
                                   ▼               ▼
                        ┌──────────────────┐   ┌──────────────────┐
                        │   PRIMARY NODE   │   │  REPLICA NODES   │
                        │ (Warm NVMe disk) │   │ (Warm NVMe disk) │
                        └─────────┬────────┘   └─────────▲────────┘
                                  │                      │
                                  │ 1. Upload pack       │ 3. Conditional GET
                                  │ 2. Atomic CAS        │    (If-None-Match)
                                  ▼                      │    - 304? NVMe read
                      ┌──────────────────────────────────┴─────┐
                      │      S3 WRITE-AHEAD LOG STORAGE        │
                      │                                        │
                      │  ├── wal_index.json                    │
                      │  ├── wal/packs/*.pack                  │
                      │  └── wal/compacted/*.pack              │
                      └────────────────────────────────────────┘
```

---

## 🚀 2. S3 Standard vs. S3 Express One Zone

In the research blog post, Cursor highlighted the difference between storage classes:

| Metric | S3 Standard | S3 Express One Zone |
| :--- | :--- | :--- |
| **Write Latency (PUT)** | ~50–100ms | **Single-digit milliseconds (<10ms)** |
| **Push Throughput** | ~120 pushes / sec | **>300 pushes / sec** |
| **Read Replication Scaling** | Linear across 100+ replicas | Linear across 100+ replicas |
| **Bottleneck** | S3 PUT latency | CPU time to run `git index-pack` / repack |

Because our codebase uses standard S3 APIs (`@aws-sdk/client-s3`), deploying to S3 Express One Zone requires **zero code changes**—only changing the bucket name to an Express One Zone directory bucket.

---

## ⏳ 3. Time-Travel & Provenance Rewinding

Because every single push is an immutable entry in the S3 Write-Ahead Log:
1. **Full Provenance:** You can inspect every version `V` the repository has ever been in.
2. **Instant Rewinding:** If a Git bug or rogue agent pushes corrupted refs, you do not need to restore from a backup tape. You simply update `wal_index.json` to point back to Version `V - 1`.
3. **Auditability:** Every commit SHA, packfile hash, and timestamp is permanently recorded in the immutable WAL.

---

## 🎮 4. The Unified Interactive Simulation CLI

Phase 8 culminates in a unified interactive simulation CLI (`bun run demo`):
- Initializes a full mock or AWS S3 cluster.
- Spawns 1 Primary and 2 Replicas.
- Simulates concurrent developer pushes and CAS races.
- Demonstrates sub-10ms 304 cache hits.
- Wipes a replica's disk to 0 bytes and demonstrates on-demand materialization.
- Triggers Primary compaction and verifies that replicas download the single compacted pack without burning CPU.

---

## 🌟 5. Summary of Key Architectural Takeaways

1. **Don't Fight Git:** Use real off-the-shelf Git bare repos on local fast NVMe drives. Never attempt to rewrite Git's DAG traversal over a distributed database.
2. **Local Disks are Ephemeral Caches:** Treat repositories as cattle. Any node can crash, be evicted, or be replaced at any second.
3. **S3 as the Single Source of Truth:** Storing the Write-Ahead Log in object storage provides infinite durability and horizontal scalability.
4. **Stateless Consensus:** S3 Atomic CAS (`If-Match`) completely replaces complex distributed databases and 3-Phase Commit algorithms.
5. **Conditional Caching for Reads:** S3 `304 Not Modified` enables thousands of concurrent CI clones with sub-10ms latency and zero S3 bandwidth costs.
