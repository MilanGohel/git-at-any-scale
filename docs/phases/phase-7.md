# Phase 7: Stateless Consensus & Rendezvous Hashing

> **Core Objective:** Eliminate central routing databases and complex leader election protocols by using **Rendezvous Hashing** for deterministic routing and **S3 Atomic CAS** for stateless conflict resolution.

---

## 🧠 1. The Architectural Problem It Solves

### The Pet Routing Database Problem
In standard distributed Git systems:
- A central database (e.g. Postgres or DynamoDB) must maintain a massive **routing table**:
  `repo_123` $\to$ `[server-1 (Primary), server-2 (Replica), server-3 (Replica)]`
- If this database has an outage, the entire Git platform is blind: no server knows which repository it is supposed to serve.
- When nodes crash, complex distributed consensus protocols (like Paxos, Raft, or Zookeeper) must hold leader elections to pick a new primary.

### The Continuity Paradigm: "The Answer is Anywhere"
As Cursor's Vicent Martí explained in the blog post:
> *"Where does every repository live? The answer is 'anywhere'. It doesn't matter! We treat repositories like a warm cache on disk, but the source of truth is always the write-ahead log in S3. The system is stateless, and there are no routing tables."*

---

## 🧭 2. How Rendezvous Hashing (HRW) Works

Instead of storing routing entries in an external database, Continuity uses **Rendezvous Hashing** (Highest Random Weight):

```
                       INPUT: repoId = "cursor-core"
                              Live Nodes = ["node-A", "node-B", "node-C"]
                                         │
                                         ▼
                 ┌───────────────────────────────────────────────┐
                 │ Compute weight = Hash(repoId + nodeId)        │
                 │                                               │
                 │ Weight("cursor-core" + "node-A") = 0.84       │  <── Rank 1 (Primary)
                 │ Weight("cursor-core" + "node-C") = 0.52       │  <── Rank 2 (Replica 1)
                 │ Weight("cursor-core" + "node-B") = 0.19       │  <── Rank 3 (Replica 2)
                 └───────────────────────────────────────────────┘
```

### Why This Is Pure Genius:
1. **Zero Database Dependencies:** Any load balancer, gateway, or node can run this pure function in memory in microseconds.
2. **Minimal Disruption:** If `node-A` crashes, `node-C` automatically becomes Rank 1. It doesn't need to ask anyone for permission: it simply materializes the repo from S3 and starts accepting traffic.
3. **No Split-Brain Risk:** Even if a network partition causes `node-A` and `node-B` to both think they are primary, S3's Atomic CAS protects the data!

---

## ⚔️ 3. Stateless Conflict Resolution: The CAS Race

What happens if two servers both try to accept a push for the same repository at the exact same moment?

```
          NODE A                                   AWS S3                                   NODE B
┌────────────────────────┐               ┌────────────────────────┐               ┌────────────────────────┐
│ Prepares commit A      │               │ wal_index.json         │               │ Prepares commit B      │
│ (Reads ETag: "etag_1") │               │ Current ETag: "etag_1" │               │ (Reads ETag: "etag_1") │
└───────────┬────────────┘               └───────────▲────────────┘               └───────────┬────────────┘
            │                                        │                                        │
            │ PUT with If-Match: "etag_1"            │                                        │
            ├────────────────────────────────────────┘                                        │
            │                                                                                 │
            │ 200 OK!                                                                         │
            │ (New ETag: "etag_2")                                                            │
            ▼                                                                                 │
   [Node A Wins Push!]                                                                        │
                                                 PUT with If-Match: "etag_1"                  │
                                                 (Stale ETag: S3 now has "etag_2"!)           │
                                                 ┌────────────────────────────────────────────┤
                                                 │                                            │
                                                 │ 412 Precondition Failed!                   │
                                                 ▼                                            ▼
                                        [S3 Blocks Conflict]                          [Node B Catches 412]
                                                                                              │
                                                                                      1. Re-fetches index
                                                                                      2. Rebases commit B
                                                                                      3. Retries with "etag_2"
```

Because S3 enforces **strict linearizability** via `If-Match`, distributed locks and consensus daemons are completely eliminated.

---

## 🛠️ 4. Code Implementation Blueprint

### `RendezvousRouter` Implementation:
```typescript
export class RendezvousRouter {
  private liveNodes: string[];

  constructor(liveNodes: string[]) {
    this.liveNodes = [...liveNodes];
  }

  getRankedNodes(repoId: string): string[] {
    const scored = this.liveNodes.map((nodeId) => {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(`${repoId}:${nodeId}`);
      const score = hasher.digest("hex");
      return { nodeId, score };
    });

    // Sort descending by score
    scored.sort((a, b) => b.score.localeCompare(a.score));
    return scored.map((s) => s.nodeId);
  }

  getPrimary(repoId: string): string {
    return this.getRankedNodes(repoId)[0]!;
  }
}
```

---

## ✅ 5. Verification Criteria

1. Initialize router with 3 nodes: `["node-1", "node-2", "node-3"]`.
2. Compute primary for `repo-A` $\to$ verify deterministic output across repeated calls.
3. Simulate node failure (`node-1` removed) $\to$ verify secondary node seamlessly takes over.
4. Simulate concurrent CAS race on S3: demonstrate that the losing node gets HTTP 412, refetches latest ETag, rebases, and succeeds without data corruption.
