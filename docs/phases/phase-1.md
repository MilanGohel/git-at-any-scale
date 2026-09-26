# Phase 1: Project Setup & S3/R2 Storage Abstraction

> **Core Objective:** Establish the Bun TypeScript environment and build a unified object storage client supporting **Atomic Compare-And-Swap (CAS)** and **Sub-10ms Conditional Caching**.

---

## 🧠 1. The Architectural Problem It Solves

In traditional Git hosting, repositories were stored as files on a specific server's disk. If that disk died, or if traffic spiked, the system had to rely on complex block replication (like DRBD) or distributed filesystems (like NFS). As Cursor explained in *Git at any scale*, distributed filesystems perform terribly because Git packfiles require random physical reads across disk that cannot be cached effectively over a network.

Cursor's **Continuity** inverts this model:
- **Local disks are purely temporary warm caches.**
- **Object Storage (AWS S3 / Cloudflare R2) is the authoritative Write-Ahead Log (WAL).**

However, to use S3/R2 as a database replacement without a SQL backend, the storage layer must support two critical HTTP primitives:
1. **Atomic Compare-And-Swap (CAS) on writes** via `If-Match: <ETag>`.
2. **Instant freshness verification on reads** via `If-None-Match: <ETag>`.

---

## ⚡ 2. How the Storage Primitives Work

```
              WRITE PATH (Atomic CAS)                     READ PATH (Conditional 304)
        ┌──────────────────────────────────┐        ┌──────────────────────────────────┐
        │  PUT /repo/wal_index.json        │        │  GET /repo/wal_index.json        │
        │  Header: If-Match: "etag_v1"     │        │  Header: If-None-Match: "etag_v1"│
        └─────────────────┬────────────────┘        └─────────────────┬────────────────┘
                          ▼                                           ▼
             ┌─────────────────────────┐                 ┌─────────────────────────┐
             │       AWS S3 / R2       │                 │       AWS S3 / R2       │
             └────────────┬────────────┘                 └────────────┬────────────┘
                          │                                           │
         ┌────────────────┴───────────────┐              ┌────────────┴───────────────┐
         │                                │              │                            │
   Match ETag?                      Mismatch?      ETag Same?                    ETag Changed?
         ▼                                ▼              ▼                            ▼
  HTTP 200 OK               HTTP 412 Precondition  HTTP 304 Not Modified         HTTP 200 OK
(New ETag Committed)               Failed          (0 bytes body, <10ms)       (New WAL Index body)
```

### A. Atomic Compare-And-Swap (CAS) via `If-Match`
When a node wants to publish a push:
- It reads the current index and records its S3 `ETag` (e.g. `"etag_v1"`).
- It prepares the new index state (Version `2`).
- It sends `PUT` with `If-Match: "etag_v1"`.
- If another node pushed in the exact same millisecond and updated the index, the ETag in S3 changed. S3 immediately rejects the second write with **`HTTP 412 Precondition Failed`**.
- **Result:** Zero split-brain, zero data corruption, zero distributed locks required.

### B. Sub-10ms Cache Validation via `If-None-Match`
When a read replica handles a clone:
- It asks S3: `GET wal_index.json` with `If-None-Match: "etag_v1"`.
- If nothing changed, S3 returns **`HTTP 304 Not Modified`**.
- S3 transfers **0 bytes of body data**. It is a fast metadata check that takes **<10ms**.
- **Result:** The replica knows with 100% mathematical certainty that its local disk is fresh, serving reads instantly.

---

## 🛠️ 3. Implementation Details

We built a dual-provider architecture in `src/storage/`:

| Provider | File | Purpose |
| :--- | :--- | :--- |
| **`MockR2Storage`** | `src/storage/mock-r2.ts` | In-memory, thread-safe S3 simulator calculating MD5 ETags. Accurately returns 200, 304, and 412 for instant, zero-credential local development and unit tests. |
| **`AwsS3Storage`** | `src/storage/aws-s3.ts` | Production AWS S3 client using `@aws-sdk/client-s3`, configured for standard AWS regions (e.g., `eu-north-1`, `us-east-1`). |
| **`CloudflareR2Storage`** | `src/storage/cloudflare-r2.ts` | Production Cloudflare R2 client using `@aws-sdk/client-s3` targeting `https://<account_id>.r2.cloudflarestorage.com`. |

### Interface Definition (`src/types/storage.ts`):
```typescript
export interface R2StorageInterface {
  getObject(key: string, options?: GetObjectOptions): Promise<GetObjectResult>;
  putObject(key: string, data: Uint8Array | string, options?: PutObjectOptions): Promise<PutObjectResult>;
  listObjects(prefix: string): Promise<string[]>;
  deleteObject(key: string): Promise<boolean>;
}
```

---

## ✅ 4. Verification & Testing

Run unit tests verifying ETag calculation, 304 caching, and 412 CAS rejection:
```bash
bun test src/tests/storage.test.ts
```

Output:
```
✓ should write and read objects with MD5 ETags
✓ should return HTTP 304 Not Modified when ETag matches
✓ should enforce Atomic Compare-And-Swap (CAS) with If-Match
✓ should list and delete objects properly
```
