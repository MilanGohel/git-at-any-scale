/**
 * Git Repository Inspection Engine for Web UI Explorer (Phase 13)
 *
 * Fast inspection of bare repositories on disk using native Git commands:
 * - Branches and default branch discovery
 * - Commit logs and commit metadata
 * - Tree and subdirectory navigation (files, folders, sizes)
 * - Blob content retrieval (text & binary detection)
 */

import { runGit } from "../engine/git-process.ts";

export interface TreeEntry {
  mode: string;
  type: "blob" | "tree";
  sha: string;
  size: number | null;
  name: string;
  path: string;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
  relativeTime: string;
  message: string;
}

export interface BlobInfo {
  path: string;
  content: string;
  size: number;
  lineCount: number;
  isBinary: boolean;
}

export class GitReader {
  /**
   * Retrieves all branch names in the bare repository.
   */
  static async getBranches(repoDir: string): Promise<string[]> {
    try {
      const out = await runGit(["branch", "--list", "--format=%(refname:short)"], { cwd: repoDir });
      const branches = out
        .trim()
        .split("\n")
        .map((b) => b.trim())
        .filter(Boolean);
      return branches.length > 0 ? branches : ["main"];
    } catch {
      return ["main"];
    }
  }

  /**
   * Discovers the repository's default branch (HEAD symref).
   */
  static async getDefaultBranch(repoDir: string): Promise<string> {
    try {
      const out = await runGit(["symbolic-ref", "--short", "HEAD"], { cwd: repoDir });
      return out.trim() || "main";
    } catch {
      const branches = await this.getBranches(repoDir);
      return branches[0] || "main";
    }
  }

  /**
   * Converts a UNIX timestamp to human-readable relative time (e.g. "2 hours ago").
   */
  static getRelativeTime(timestampSec: number): string {
    const elapsedSec = Math.floor(Date.now() / 1000) - timestampSec;
    if (elapsedSec < 60) return "just now";
    if (elapsedSec < 3600) return `${Math.floor(elapsedSec / 60)}m ago`;
    if (elapsedSec < 86400) return `${Math.floor(elapsedSec / 3600)}h ago`;
    if (elapsedSec < 2592000) return `${Math.floor(elapsedSec / 86400)}d ago`;
    return `${Math.floor(elapsedSec / 2592000)}mo ago`;
  }

  /**
   * Parses git log format line using unit separator 0x1f.
   */
  private static parseCommitLine(line: string): CommitInfo | null {
    if (!line.trim()) return null;
    const parts = line.split("\x1f");
    if (parts.length < 6) return null;
    const [hash, shortHash, authorName, authorEmail, tsStr, message] = parts;
    const timestamp = parseInt(tsStr || "0", 10);
    return {
      hash: hash || "",
      shortHash: shortHash || (hash ? hash.slice(0, 7) : ""),
      authorName: authorName || "Unknown",
      authorEmail: authorEmail || "",
      timestamp,
      relativeTime: this.getRelativeTime(timestamp),
      message: message || "No message",
    };
  }

  /**
   * Gets the latest commit on a branch.
   */
  static async getLatestCommit(repoDir: string, ref: string = "HEAD"): Promise<CommitInfo | null> {
    try {
      const out = await runGit(
        ["log", "-1", "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s", ref],
        { cwd: repoDir }
      );
      return this.parseCommitLine(out.trim());
    } catch {
      return null;
    }
  }

  /**
   * Gets commit history for a branch.
   */
  static async getCommits(
    repoDir: string,
    ref: string = "HEAD",
    limit: number = 50
  ): Promise<CommitInfo[]> {
    try {
      const out = await runGit(
        ["log", `-n${limit}`, "--format=%H%x1f%h%x1f%an%x1f%ae%x1f%at%x1f%s", ref],
        { cwd: repoDir }
      );
      const commits: CommitInfo[] = [];
      for (const line of out.trim().split("\n")) {
        const c = this.parseCommitLine(line);
        if (c) commits.push(c);
      }
      return commits;
    } catch {
      return [];
    }
  }

  /**
   * Lists items in a directory (root or subfolder).
   */
  static async getTree(
    repoDir: string,
    ref: string = "HEAD",
    subpath: string = ""
  ): Promise<TreeEntry[]> {
    try {
      const cleanSubpath = subpath.replace(/^\/+|\/+$/g, "");
      const treeIsh = cleanSubpath ? `${ref}:${cleanSubpath}` : ref;
      const out = await runGit(["ls-tree", "-l", treeIsh], { cwd: repoDir });

      const entries: TreeEntry[] = [];
      for (const line of out.trim().split("\n")) {
        if (!line.trim()) continue;
        // Format: <mode> <type> <sha> <size> <name>
        // Note: size is formatted with padding or '-' for trees
        const match = line.match(/^(\d+)\s+(blob|tree)\s+([a-f0-9]+)\s+([0-9\-]+)\s+(.+)$/);
        if (!match) continue;

        const [, mode, type, sha, sizeStr, name] = match;
        const size = sizeStr && sizeStr !== "-" ? parseInt(sizeStr.trim(), 10) : null;
        const fullPath = cleanSubpath ? `${cleanSubpath}/${name}` : name;

        entries.push({
          mode: mode || "100644",
          type: type as "blob" | "tree",
          sha: sha || "",
          size,
          name: name || "",
          path: fullPath,
        });
      }

      // Sort: Folders ('tree') first, then files ('blob') alphabetically
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "tree" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return entries;
    } catch {
      return [];
    }
  }

  /**
   * Retrieves blob content for a specific file.
   */
  static async getBlob(
    repoDir: string,
    ref: string = "HEAD",
    filePath: string
  ): Promise<BlobInfo | null> {
    try {
      const cleanPath = filePath.replace(/^\/+/, "");
      const raw = await runGit(["show", `${ref}:${cleanPath}`], { cwd: repoDir });

      // Detect binary content (contains null bytes)
      const isBinary = raw.slice(0, 1000).includes("\0");
      const lineCount = isBinary ? 0 : raw.split("\n").length;
      const size = Buffer.byteLength(raw, "utf8");

      return {
        path: cleanPath,
        content: isBinary ? "(Binary file not previewable)" : raw,
        size,
        lineCount,
        isBinary,
      };
    } catch {
      return null;
    }
  }
}
