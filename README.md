# Git at Any Scale: The Story & Architecture Behind Cursor's "Continuity" and "Origin"

> Based on Cursor's research blog post: [*Git at any scale*](https://cursor.com/blog/git-at-any-scale) by Vicent Martí.

---

## 📖 Table of Contents
1. [Prologue: The Linus Paradox & What's Hard About Git](#-prologue-the-linus-paradox--whats-hard-about-git)
2. [Act I: The Failed Experiments](#-act-i-the-failed-experiments)
   - [Attempt 1: Git Without Packfiles (Distributed Key-Value / DHT)](#attempt-1-git-without-packfiles-distributed-key-value--dht)
   - [Attempt 2: Shared Networked Filesystems (NFS & DRBD)](#attempt-2-shared-networked-filesystems-nfs--drbd)
3. [Act II: The 13-Year Veteran – GitHub's Spokes](#-act-ii-the-13-year-veteran--githubs-spokes)
   - [The Spokes Philosophy: 3PC & NVMe](#the-spokes-philosophy-3pc--nvme)
   - [Why Spokes Broke in the Modern Era](#why-spokes-broke-in-the-modern-era)
4. [Act III: Cursor's Breakthrough – Continuity](#-act-iii-cursors-breakthrough--continuity)
   - [Core Principle: S3 as the Single Source of Truth](#core-principle-s3-as-the-single-source-of-truth)
   - [Stateless Consensus & Rendezvous Hashing](#stateless-consensus--rendezvous-hashing)
   - [Optimistic Gossip + Conditional S3 GETs](#optimistic-gossip--conditional-s3-gets)
   - [Amortized Compaction](#amortized-compaction)
5. [Act IV: Origin – The Platform for the Agentic Era](#-act-iv-origin--the-platform-for-the-agentic-era)
6. [Architecture Blueprint: Building a Mini S3 Prototype](#-architecture-blueprint-building-a-mini-s3-prototype)

---

## 🎭 Prologue: The Linus Paradox & What's Hard About Git

In 2005, Linus Torvalds introduced Git as *"the information manager from hell"*. Git was crafted for a very specific environment: the Linux Kernel development process.
- **Extreme Decentralization:** Dozens of subsystem maintainers traded patches via email.
- **Offline First:** Developers could commit, branch, and inspect history without an active internet connection.
- **Every Clone is a Full Database:** There is nothing architecturally special about a remote repository versus a local folder on a developer's laptop.

```mermaid
flowchart LR
    A["Developer A\n(Full History)"] <--> B["Developer B\n(Full History)"]
    B <--> C["Maintainer\n(Full History)"]
```

Fast forward twenty years: **the software industry did the complete opposite**.

Instead of decentralized email patches, modern software development revolves around **centralized hubs** (GitHub, GitLab, and now automated AI agents running in the cloud). Yet, Git is notoriously hostile to centralized scale due to its core storage primitives:

### The Packfile Dilemma
Git organizes historical data (blobs, trees, commits, tags) into **packfiles** (`.pack`) and index files (`.idx`). 
1. **Network Obligation:** Git clients expect raw packfiles over HTTP/SSH. Linus isn't checking your backend, but the wire protocol strictly mandates packfiles.
2. **Local Disk Expectation:** Git was built to run against local filesystems using POSIX semantics (`mmap`, locks, atomic renames, zero-copy I/O).
3. **The Scaling Wall:** Storing repositories on a single disk limits you to single-machine capacity. If that disk dies, or if 5,000 CI jobs clone the repository at once, the system collapses.

To scale Git, companies historically faced three paths:
1. **Distribute the filesystem**
2. **Distribute the objects (Git without packfiles)**
3. **Distribute Git itself**

---

## 🧪 Act I: The Failed Experiments

Before arriving at modern designs, engineering teams spent over a decade proving what **cannot** work at scale.

### Attempt 1: Git Without Packfiles (Distributed Key-Value / DHT)

Because Git is content-addressable (every object is identified by the SHA hash of its contents), it seems tempting to store Git objects in a distributed key-value store (e.g., DynamoDB, Bigtable, or a Distributed Hash Table).

```mermaid
graph TD
    Commit["Commit: c8f3..."] --> RootTree["Root Tree: a112..."]
    RootTree --> SubTree["Subdirectory Tree: 4b70..."]
    SubTree --> Blob["File Blob: 91fe..."]
    Commit --> Parent["Parent Commit: aa42..."]
```

#### Why it fails: The DAG Walk
Git repositories are Directed Acyclic Graphs. Even the simplest operation (e.g., `git log -n 5` or `git checkout`) requires traversing the DAG step-by-step:
- You fetch the commit $\to$ discover the root tree pointer.
- You fetch the root tree $\to$ discover subtree and blob pointers.
- You fetch the commit $\to$ discover the parent commit pointer.

**At each hop, you do not know the next key until the previous key returns.** If every hop requires a network round-trip to a distributed KV store, latency compounds catastrophically. 

> [!WARNING]
> Shawn Pearce (creator of JGit) built a DHT-backed Git backend at Google. While everyday operations were tolerable, generating packfiles on-the-fly for `git clone` consumed immense CPU and caused massive network latency, leading Google to discard the design.

---

### Attempt 2: Shared Networked Filesystems (NFS & DRBD)

In 2008, GitHub started as a Rails monolith. The simplest idea to scale was: *"Leave Git and Rails unchanged; make the filesystem distributed so multiple Rails servers can access repositories over NFS or block-level replication (DRBD / GFS)."*

#### Why it fails: Random Physical Walks in Packfiles
Packfiles are compressed binary containers optimized for minimal storage:
- Objects are placed non-sequentially.
- Most objects are stored as **deltas** (differences applied to another base object elsewhere in the packfile).
- Following logical DAG links requires jumping to arbitrary byte offsets across multi-gigabyte packfiles on disk.

```
+------------------------------------------------------------------------+
|                          PACKFILE ON DISK                              |
|  [Delta Object A] --------> [Base Object B] --------> [Delta Object C] |
|   offset: 0x0400             offset: 0x8A20            offset: 0x11F0  |
+------------------------------------------------------------------------+
```

Over a local NVMe drive, random seeks are fast and absorbed by the OS page cache. Over NFS or DRBD block replication, random seeks over high-latency networks cause severe I/O stalls. With hundreds of thousands of repositories, caching entire filesystems in memory was impossible.

---

## 🛡️ Act II: The 13-Year Veteran – GitHub's Spokes

Around 2013, GitHub developed **Spokes**, an application-level replication engine that became the industry standard.

### The Spokes Philosophy: 3PC & NVMe

Spokes established three critical principles:
1. **Never distribute Git internals:** Keep plain, standard Git repositories on local, ultra-fast NVMe disks.
2. **Decouple Data from References:** A `git push` has two distinct layers:
   - **The Packfile:** Large binary payload containing raw objects (blobs, trees, commits).
   - **The Reference Transaction:** Updating a pointer (e.g., `refs/heads/main` moves from commit `c8f3` to `a996`).
3. **Consensus via Three-Phase Commit (3PC):**
   - The coordinator streams the incoming packfile to 3 replica nodes in parallel (no locks needed yet; data is unreachable until the ref points to it).
   - Once all nodes have the packfile, the coordinator executes a **3-Phase Commit** (`Voting` $\to$ `Pre-Commit / Lock` $\to$ `Do Commit`) on the ref transaction across all 3 nodes.

```mermaid
sequenceDiagram
    autonumber
    actor Dev as Developer
    participant Coord as Spokes Coordinator
    participant R1 as Replica 1 (NVMe)
    participant R2 as Replica 2 (NVMe)
    participant R3 as Replica 3 (NVMe)

    Dev->>Coord: git push (Packfile + Ref Txn)
    par Upload Packfile
        Coord->>R1: Write Packfile
        Coord->>R2: Write Packfile
        Coord->>R3: Write Packfile
    end
    Note over Coord,R3: 3-Phase Commit on Reference Transaction
    Coord->>R1: 1. Voting (Prepare ref)
    Coord->>R2: 1. Voting (Prepare ref)
    Coord->>R3: 1. Voting (Prepare ref)
    Coord->>R1: 2. Pre-Commit (Acquire ref lock)
    Coord->>R2: 2. Pre-Commit (Acquire ref lock)
    Coord->>R3: 2. Pre-Commit (Acquire ref lock)
    Coord->>R1: 3. Do Commit (Move ref)
    Coord->>R2: 3. Do Commit (Move ref)
    Coord->>R3: 3. Do Commit (Move ref)
    Coord-->>Dev: Push Acknowledged
```

Because all 3 replicas are kept in lockstep, any read (`git clone`, `git fetch`, web UI) can be safely routed to any replica.

---

### Why Spokes Broke in the Modern Era

By 2026, two massive industry trends broke Spokes' assumptions:

| Modern Challenge | Spokes Bottleneck |
| :--- | :--- |
| **Enterprise Monorepos** | Huge repositories run thousands of concurrent CI jobs. 3 replicas cannot handle the clone volume. Adding 10 or 50 replicas kills push latency because 3PC is bound to the slowest node (tail latency). |
| **AI Agent Ephemeral Repos** | AI agents create millions of tiny, short-lived repositories. Spokes requires 3 dedicated NVMe-backed replicas for *every single repo*, wasting huge amounts of idle capacity. |
| **Pet vs. Cattle Operations** | If 2 out of 3 replicas fail or corrupt, quorum is lost and pushes halt. Teams must maintain complex routing databases, checksum trackers, and constant automated repair daemons. |

---

## ⚡ Act III: Cursor's Breakthrough – Continuity

To host repositories for human engineers and automated AI coding agents alike, Cursor built **Continuity**.

### Core Principle: S3 as the Single Source of Truth

> [!IMPORTANT]
> **Continuity's Golden Rule:** Local NVMe disks are purely **warm, disposable caches**. The **Write-Ahead Log (WAL) in S3** is the sole source of truth.

```mermaid
flowchart TD
    Client(["Git Client / Agent"]) -->|"git push"| Primary["Primary Host (Warm NVMe)"]
    
    subgraph S3["AWS S3 Bucket (Source of Truth)"]
        WALIndex["wal_index.json\n(Ref Pointers & Pack List)"]
        Pack1["wal/001.pack"]
        Pack2["wal/002.pack"]
    end
    
    subgraph Cluster["Cluster Nodes"]
        Primary
        Replica1["Replica 1 (Warm NVMe)"]
        ReplicaN["Replica N (Warm NVMe)"]
    end

    Primary -->|"1. Upload Pack"| Pack2
    Primary -->|"2. Atomic CAS (If-Match)"| WALIndex
    Primary -.->|"3. Unreliable UDP Gossip"| Replica1 & ReplicaN
    
    Replica1 -->|"Conditional GET (If-None-Match)"| WALIndex
```

#### How a Push Works:
1. **Simultaneous Ingestion:** The client pushes. The primary host writes the packfile to its local NVMe drive while simultaneously uploading it to S3 (`/wal/entries/<id>.pack`).
2. **Local Ref Preparation:** The primary prepares the ref transaction locally.
3. **Linearization via S3 CAS:** The push is only acknowledged after successfully updating `wal_index.json` using an **S3 Compare-And-Swap (conditional PUT with `If-Match`)**.
4. **Push Durability Guaranteed:** If the primary host catches fire a millisecond later, zero data is lost. The WAL in S3 contains the complete history.

---

### Stateless Consensus & Rendezvous Hashing

Unlike Spokes, Continuity requires **no central SQL database** to track where repositories live:
- **Rendezvous (Highest Random Weight) Hashing:** A pure function takes the `repo_id` and the current list of live nodes in the cluster, deterministicly ordering which server should act as the primary.
- **True Cattle, Not Pets:** If a node disappears, the next node in the hash ring takes over. It simply checks S3, materializes the repo on its local NVMe drive, and starts serving traffic.
- **Handling Write Races:** If two servers attempt to accept pushes for the same repository simultaneously, they race on the S3 CAS operation on `wal_index.json`. The winning server commits; the losing server receives an `HTTP 412 Precondition Failed`, refetches the updated index, rebases, and retries.

---

### Optimistic Gossip + Conditional S3 GETs

How do replicas serve fresh reads without slow, synchronous 3PC?

```mermaid
sequenceDiagram
    autonumber
    actor Reader as CI Runner / Developer
    participant Rep as Read Replica
    participant S3 as AWS S3

    Note over Rep: Cached ETag: "abc123etag"
    Reader->>Rep: git clone / fetch
    Rep->>S3: GET wal_index.json (If-None-Match: "abc123etag")
    
    alt Nothing has changed
        S3-->>Rep: HTTP 304 Not Modified (<10ms metadata check)
        Rep-->>Reader: Stream clone immediately from local NVMe!
    else New push occurred
        S3-->>Rep: HTTP 200 OK (New wal_index.json + new ETag)
        Rep->>S3: Download new packfile(s)
        Rep->>Rep: Fast-forward local Git refs
        Rep-->>Reader: Stream clone from updated local NVMe!
    end
```

1. **Fire-and-Forget UDP:** The primary broadcasts an unreliable UDP gossip packet to the cluster when a push completes. Replicas attempt to pre-fetch the new packfile in the background.
2. **Network Failures Don't Matter:** If the UDP packet is dropped, consistency is **never compromised**.
3. **The 304 Verification:** Every read request triggers a conditional S3 GET using the replica's cached `ETag`. Because this is a lightweight metadata call, S3 responds with `304 Not Modified` in under 10 milliseconds.
4. **Instant Catch-up:** If the response is `200 OK`, the replica pulls the newly indexed packfile, applies the ref update locally, and serves the user.

---

### Amortized Compaction

Over time, accumulating hundreds of individual push packfiles degrades Git read performance.
- **The Spokes Problem:** All replicas had to run `git repack` locally, burning massive CPU cycles and causing failover spikes.
- **The Continuity Solution:** **Only the primary node repacks**. It computes the merged packfile, uploads it to S3, and records the compaction event in the WAL index.
- **Bandwidth over Compute:** Replicas never repack locally. They simply download the pre-compacted packfile from S3, saving thousands of CPU core-hours across the fleet.

---

## 🚀 Act IV: Origin – The Platform for the Agentic Era

Cursor’s production system, named **Origin**, brings these principles together:

```
                            CONTINUITY'S METRICS
   Push Throughput (S3 Standard):         ~120 pushes / second
   Push Throughput (S3 Express One Zone): >300 pushes / second
   Read Scalability:                      Linear scaling across 100+ replicas
   Idle Repository Cost:                  $0 compute (evicted from NVMe; stored in S3)
```

- **Scale Down to Zero:** Idle agent scratch repositories are evicted from host NVMe drives when inactive. If an agent resumes hours later, the repository is re-materialized from the S3 WAL on demand.
- **Scale Up to Infinity:** High-demand repositories can spawn dozens or hundreds of read replicas to absorb massive CI clone floods without impacting write throughput.

---

## 🛠️ Architecture Blueprint: Building a Mini S3 Prototype

To understand this system deeply, we can implement a clean minimal prototype using AWS S3 (or MinIO / LocalStack):

```
git-at-any-scale/
├── README.md                   # Complete architectural guide (this document)
├── s3_storage.py               # S3 client wrapper (PUT, conditional CAS, GET 304)
├── wal_index.py                # Schema & CAS logic for wal_index.json
├── git_node.py                 # Core node logic: primary ingestion & replica catchup
├── test_simulation.py          # Multi-node simulation (Primary push, Replica read, CAS race)
└── requirements.txt            # boto3, etc.
```

### 1. The WAL Index Structure (`wal_index.json`)
```json
{
  "repo_id": "demo-repo",
  "version": 4,
  "references": {
    "refs/heads/main": "9f83b2...commit_sha",
    "refs/heads/feature": "1a2b3c...commit_sha"
  },
  "packfiles": [
    "wal/packs/base.pack",
    "wal/packs/push-1.pack",
    "wal/packs/push-2.pack"
  ],
  "last_compaction": "2026-09-25T12:00:00Z"
}
```

### 2. Core Operational Flow
1. **`PrimaryNode.push(ref_name, old_sha, new_sha, packfile_bytes)`:**
   - Write packfile to local `.git/objects/pack/`.
   - Upload packfile to `s3://<bucket>/<repo_id>/wal/packs/<hash>.pack`.
   - Read current `wal_index.json` and its `ETag`.
   - Prepare new index with updated ref and new packfile path.
   - Execute conditional PUT: `PutObject(IfMatch=ETag)`. If failed, retry.
2. **`ReplicaNode.sync_and_read(ref_name)`:**
   - Execute `GetObject(IfNoneMatch=local_etag)`.
   - If `304 Not Modified`: read ref from local disk.
   - If `200 OK`: download missing packfiles into `.git/objects/pack/`, update `.git/refs/`, update `local_etag`.
