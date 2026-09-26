/**
 * Rendezvous (Highest Random Weight / HRW) Router for Continuity.
 *
 * Implements stateless, database-free routing:
 * - Deterministically maps any repoId to a ranked list of cluster nodes.
 * - Rank #1 node is the designated Primary.
 * - Remaining ranked nodes are Replicas.
 * - If a node fails, the next ranked node immediately takes over with zero leader elections.
 */
export class RendezvousRouter {
  private liveNodes: Set<string>;

  constructor(initialNodes: string[] = []) {
    if (initialNodes.length === 0) {
      throw new Error("RendezvousRouter: At least one live node is required");
    }
    this.liveNodes = new Set(initialNodes);
  }

  /**
   * Adds a new active node to the cluster.
   */
  addNode(nodeId: string): void {
    this.liveNodes.add(nodeId);
  }

  /**
   * Removes a node from the cluster (simulating node crash, maintenance, or decommissioning).
   */
  removeNode(nodeId: string): void {
    if (this.liveNodes.size <= 1 && this.liveNodes.has(nodeId)) {
      throw new Error("Cannot remove the last remaining live node from the cluster");
    }
    this.liveNodes.delete(nodeId);
  }

  /**
   * Returns all currently live nodes in sorted order.
   */
  getLiveNodes(): string[] {
    return Array.from(this.liveNodes).sort();
  }

  /**
   * Computes a deterministic pseudo-random weight for a given (repoId, nodeId) pair.
   */
  private computeWeight(repoId: string, nodeId: string): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(`${repoId}:${nodeId}`);
    return hasher.digest("hex");
  }

  /**
   * Deterministically ranks all live cluster nodes for a specific repository.
   * Rank 0 = Primary, Rank 1+ = Replicas.
   */
  getRankedNodes(repoId: string): string[] {
    if (this.liveNodes.size === 0) {
      throw new Error("No live nodes available in cluster");
    }

    const scored = Array.from(this.liveNodes).map((nodeId) => ({
      nodeId,
      score: this.computeWeight(repoId, nodeId),
    }));

    // Sort descending by weight score
    scored.sort((a, b) => b.score.localeCompare(a.score));
    return scored.map((s) => s.nodeId);
  }

  /**
   * Returns the primary node for a repository.
   */
  getPrimary(repoId: string): string {
    return this.getRankedNodes(repoId)[0]!;
  }

  /**
   * Returns the replica nodes for a repository in order of priority.
   */
  getReplicas(repoId: string, count?: number): string[] {
    const ranked = this.getRankedNodes(repoId).slice(1);
    return count !== undefined ? ranked.slice(0, count) : ranked;
  }
}
