# Continuity Architecture: Phase-by-Phase Documentation

> Detailed architectural deep-dives, diagrams, and implementation mechanics for Cursor's **Continuity** Git hosting engine on **Bun** and **AWS S3**.

---

## 📚 Phase Index

| Phase | Documentation | Core Concepts | Status |
| :--- | :--- | :--- | :--- |
| **Phase 1** | [Phase 1: Project Setup & Storage Abstraction](./phase-1.md) | Bun setup, S3/R2 client, Atomic CAS (`If-Match`), and Sub-10ms conditional checks (`If-None-Match`). | ✅ Implemented & Tested |
| **Phase 2** | [Phase 2: The WAL Index Data Model](./phase-2.md) | `wal_index.json` schema, immutable state transitions (`nextVersion()`), linearizability without SQL. | ✅ Implemented & Tested |
| **Phase 3** | [Phase 3: The Primary Node Engine](./phase-3.md) | Bare Git repo, `unpackLimit = 1` packfile preservation, streaming packs to S3, and Atomic CAS commit. | ✅ Implemented & Tested |
| **Phase 4** | [Phase 4: The Replica Node Engine](./phase-4.md) | Horizontal read scaling, HTTP 304 cache hits (<10ms, 0 bytes), and delta packfile catchup. | ✅ Implemented & Tested |
| **Phase 5** | [Phase 5: Ephemeral Cold Materialization](./phase-5.md) | "Cattle, not pets": zero-disk empty nodes reconstructing complete Git repos on-demand from S3. | 🔜 Next to Implement |
