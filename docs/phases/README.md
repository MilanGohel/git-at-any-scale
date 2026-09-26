# Continuity Architecture: Phase-by-Phase Documentation

> Detailed architectural deep-dives, diagrams, and implementation mechanics for Cursor's **Continuity** Git hosting engine on **Bun** and **AWS S3**.

---

## 📚 Phase Index

| Phase | Documentation | Core Concepts | Status |
| :--- | :--- | :--- | :--- |
| **Phase 1** | [**Phase 1: Project Setup & Storage Abstraction**](./phase-1.md) | Bun setup, S3/R2 client, Atomic CAS (`If-Match`), and Sub-10ms conditional checks (`If-None-Match`). | ✅ Implemented & Tested |
| **Phase 2** | [**Phase 2: The WAL Index Data Model**](./phase-2.md) | `wal_index.json` schema, immutable state transitions (`nextVersion()`), linearizability without SQL. | ✅ Implemented & Tested |
| **Phase 3** | [**Phase 3: The Primary Node Engine**](./phase-3.md) | Bare Git repo, `unpackLimit = 1` packfile preservation, streaming packs to S3, and Atomic CAS commit. | ✅ Implemented & Tested |
| **Phase 4** | [**Phase 4: The Replica Node Engine**](./phase-4.md) | Horizontal read scaling, HTTP 304 cache hits (<10ms, 0 bytes), and delta packfile catchup. | ✅ Implemented & Tested |
| **Phase 5** | [**Phase 5: Ephemeral Cold Materialization**](./phase-5.md) | "Cattle, not pets": zero-disk empty nodes reconstructing complete Git repos on-demand from S3. | ✅ Implemented & Tested |
| **Phase 6** | [**Phase 6: Amortized Compaction**](./phase-6.md) | Primary repacks once; replicas download pre-compacted packs (trading bandwidth for CPU). | ✅ Implemented & Tested |
| **Phase 7** | [**Phase 7: Stateless Consensus & Routing**](./phase-7.md) | Rendezvous Hashing without SQL routing tables, handling leader failover & CAS push races. | ✅ Implemented & Tested |
| **Phase 8** | [**Phase 8: Origin Platform & Production Fleet**](./phase-8.md) | Enterprise monorepo scale, S3 Express One Zone, history rewinding, and the unified simulation CLI. | ✅ Implemented & Tested |
| **Phase 9** | [**Phase 9: Single-Host EC2 Deployment**](./phase-9.md) | Git Smart HTTP daemon on EC2, S3 durability, zero-data-loss ephemeral host recovery. | ✅ Implemented & Tested |
| **Phase 10** | [**Phase 10: Serverless Lambda Architecture**](./phase-10.md) | Pure serverless Git on AWS Lambda, Function URLs, $0 idle cost, auto-scaling. | 🚀 Ready to Deploy |
