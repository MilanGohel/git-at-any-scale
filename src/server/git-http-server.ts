/**
 * Git Smart HTTP Server Daemon for EC2 Production Hosting
 *
 * Implements the official Git Smart HTTP protocol (git-upload-pack & git-receive-pack)
 * backed by the AWS S3 Write-Ahead Log engine.
 *
 * Capabilities:
 * - Serves standard 'git clone http://<host>:3000/<repo>.git'
 * - Serves standard 'git push http://<host>:3000/<repo>.git'
 * - Automatic on-demand cold materialization from S3
 * - Automatic background S3 WAL CAS upload on incoming pushes
 * - Zero data loss if the EC2 instance restarts or disk is wiped
 */

import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join, basename, resolve } from "node:path";
import type { R2StorageInterface } from "../types/storage.ts";
import type { AuthContext } from "../types/auth.ts";
import { AuthStore } from "../auth/auth-store.ts";
import { AwsS3Storage } from "../storage/aws-s3.ts";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { WALIndex } from "../models/wal-index.ts";
import { runGit } from "../engine/git-process.ts";

export interface GitServerOptions {
  port?: number;
  host?: string;
  storage: R2StorageInterface;
  dataDir?: string;
  authStore?: AuthStore;
}

export class GitHttpServer {
  public readonly port: number;
  public readonly host: string;
  public readonly storage: R2StorageInterface;
  public readonly reposDir: string;
  public readonly authStore: AuthStore;
  private server?: ReturnType<typeof Bun.serve>;

  constructor(options: GitServerOptions) {
    this.port = options.port || Number(process.env.PORT) || 3000;
    this.host = options.host || "0.0.0.0";
    this.storage = options.storage;
    this.reposDir = resolve(options.dataDir || process.env.GIT_DATA_DIR || "./.sim_data/ec2_server/repos");
    this.authStore = options.authStore || new AuthStore(this.storage);
  }

  async start(): Promise<void> {
    await mkdir(this.reposDir, { recursive: true });

    this.server = Bun.serve({
      port: this.port,
      hostname: this.host,
      fetch: this.handleRequest.bind(this),
    });

    console.log(`\n================================================================================`);
    console.log(` 🚀 GIT SMART HTTP SERVER ACTIVE`);
    console.log(`================================================================================`);
    console.log(`  - URL:         http://${this.host}:${this.port}/`);
    console.log(`  - Repos Root:  ${this.reposDir}`);
    console.log(`  - Storage:     ${this.storage.constructor.name}`);
    console.log(`\nReady to accept:`);
    console.log(`  git clone http://${this.host === "0.0.0.0" ? "localhost" : this.host}:${this.port}/<repo-id>.git`);
    console.log(`  git push origin main`);
    console.log(`================================================================================\n`);
  }

  stop(): void {
    if (this.server) {
      this.server.stop(true);
      this.server = undefined;
    }
  }

  /**
   * Resolves the disk path for a repository.
   */
  private getRepoPath(repoId: string): string {
    const sanitized = repoId.replace(/[^a-zA-Z0-9_\-\/]/g, "_");
    return join(this.reposDir, `${sanitized}.git`);
  }

  /**
   * Extracts credentials from HTTP Authorization Basic header.
   */
  private parseBasicAuth(req: Request): { username: string; token: string } | null {
    const authHeader = req.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Basic ")) {
      return null;
    }
    try {
      const base64 = authHeader.slice(6).trim();
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      const colonIdx = decoded.indexOf(":");
      if (colonIdx === -1) return null;
      return {
        username: decoded.slice(0, colonIdx),
        token: decoded.slice(colonIdx + 1),
      };
    } catch {
      return null;
    }
  }

  /**
   * Initializes a new bare repository configured for Continuity packfile retention.
   */
  private async initBareRepo(repoDir: string): Promise<void> {
    await mkdir(repoDir, { recursive: true });
    await runGit(["init", "--bare", "-b", "main", repoDir]);
    await runGit(["config", "receive.denyCurrentBranch", "ignore"], { cwd: repoDir });
    await runGit(["config", "receive.unpackLimit", "1"], { cwd: repoDir });
    await runGit(["config", "transfer.unpackLimit", "1"], { cwd: repoDir });
    await runGit(["config", "http.receivepack", "true"], { cwd: repoDir });
    await runGit(["config", "http.uploadpack", "true"], { cwd: repoDir });
  }

  /**
   * Ensures the repository is ready on local disk. If cold or missing,
   * materializes it on-demand from S3.
   */
  private async ensureRepoReady(repoId: string, isWrite: boolean): Promise<boolean> {
    const repoDir = this.getRepoPath(repoId);

    // Check if repository is warm on disk
    let isWarm = false;
    try {
      const s = await stat(repoDir);
      isWarm = s.isDirectory();
    } catch {
      isWarm = false;
    }

    if (isWarm) {
      return true;
    }

    // Disk is cold! Check S3 Write-Ahead Log
    const indexRes = await this.storage.getObject(`${repoId}/wal_index.json`);

    if (indexRes.status === 200 && indexRes.data) {
      console.log(`[Auto-Materialize] Restoring cold repo '${repoId}' from S3 into local cache...`);
      const walIndex = WALIndex.fromBytes(indexRes.data);

      await this.initBareRepo(repoDir);
      const packDir = join(repoDir, "objects", "pack");
      await mkdir(packDir, { recursive: true });

      for (const packKey of walIndex.packfiles) {
        const packFileName = basename(packKey);
        const packRes = await this.storage.getObject(packKey);
        if (packRes.status === 200 && packRes.data) {
          const localPackPath = join(packDir, packFileName);
          await Bun.write(localPackPath, packRes.data);
          await runGit(["index-pack", localPackPath], { cwd: repoDir });
        }
      }

      for (const [refName, commitSha] of Object.entries(walIndex.references)) {
        await runGit(["update-ref", refName, commitSha], { cwd: repoDir });
        if (refName === "refs/heads/main" || refName === "refs/heads/master") {
          await runGit(["symbolic-ref", "HEAD", refName], { cwd: repoDir });
        }
      }

      console.log(`[Auto-Materialize] ✔ Repo '${repoId}' warm on disk!`);
      return true;
    }

    // Repo does not exist in S3
    if (isWrite) {
      // First push to a new repository: initialize fresh bare repo
      console.log(`[New Repo] Creating new bare repository for '${repoId}'...`);
      await this.initBareRepo(repoDir);
      return true;
    }

    // Read on non-existent repo
    return false;
  }

  /**
   * Uploads newly pushed packfiles to S3 and commits wal_index.json via Atomic CAS.
   */
  private async syncPushToS3(repoId: string, prePacks: Set<string>): Promise<void> {
    const repoDir = this.getRepoPath(repoId);
    const packDir = join(repoDir, "objects", "pack");

    let currentPacks = new Set<string>();
    try {
      const files = await readdir(packDir);
      currentPacks = new Set(files.filter((f) => f.endsWith(".pack")));
    } catch {
      return;
    }

    let newPacks = Array.from(currentPacks).filter((p) => !prePacks.has(p));

    if (newPacks.length === 0) {
      // Fallback: in case Git repacked or unpackLimit unpacked loose objects
      await runGit(["repack", "-d"], { cwd: repoDir });
      const files = await readdir(packDir);
      currentPacks = new Set(files.filter((f) => f.endsWith(".pack")));
      newPacks = Array.from(currentPacks).filter((p) => !prePacks.has(p));
    }

    if (newPacks.length === 0 && currentPacks.size > 0) {
      newPacks = [Array.from(currentPacks)[0]!];
    }

    // 1. Upload new packfiles to S3
    const uploadedPackKeys: string[] = [];
    for (const packFileName of newPacks) {
      const packFilePath = join(packDir, packFileName);
      const fileBytes = await Bun.file(packFilePath).bytes();
      const s3Key = `${repoId}/wal/packs/${packFileName}`;

      const putRes = await this.storage.putObject(s3Key, fileBytes);
      if (putRes.status !== 200) {
        console.error(`Failed to upload ${packFileName} to S3:`, putRes.error);
        return;
      }
      uploadedPackKeys.push(s3Key);
    }

    // 2. Discover current branch references from local bare repo
    const rawRefs = await runGit(["show-ref"], { cwd: repoDir }).catch(() => "");
    const references: Record<string, string> = {};
    for (const line of rawRefs.trim().split("\n")) {
      if (!line) continue;
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && ref) {
        references[ref] = sha;
      }
    }

    if (Object.keys(references).length === 0) {
      return;
    }

    // 3. Atomic CAS commit loop on wal_index.json
    const indexKey = `${repoId}/wal_index.json`;
    for (let attempt = 1; attempt <= 5; attempt++) {
      const getRes = await this.storage.getObject(indexKey);
      let nextIndex: WALIndex;
      let ifMatchHeader: string;

      if (getRes.status === 404) {
        nextIndex = WALIndex.createInitial(repoId, references, uploadedPackKeys);
        ifMatchHeader = "NONE";
      } else if (getRes.status === 200 && getRes.data) {
        const curIndex = WALIndex.fromBytes(getRes.data);
        nextIndex = curIndex.nextVersion({
          refUpdates: references,
          newPackfiles: uploadedPackKeys,
        });
        ifMatchHeader = getRes.etag!;
      } else {
        break;
      }

      const casRes = await this.storage.putObject(indexKey, nextIndex.toBytes(), {
        ifMatch: ifMatchHeader,
      });

      if (casRes.status === 200) {
        console.log(`[S3 WAL] ✔ Committed version ${nextIndex.version} for '${repoId}' to S3 (ETag: ${casRes.etag})`);
        break;
      }

      if (casRes.status === 412) {
        console.log(`[S3 WAL] CAS conflict on '${repoId}', retrying...`);
        await Bun.sleep(25);
        continue;
      }
    }
  }

  /**
   * Main HTTP request router for the Git server.
   */
  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // Healthcheck endpoint
    if (pathname === "/health" || pathname === "/") {
      const manifest = await this.authStore.getManifest().catch(() => undefined);
      return new Response(
        JSON.stringify({
          status: "healthy",
          server: "Continuity Git Server",
          version: "1.1.0",
          storage: this.storage.constructor.name,
          auth: {
            enabled: Boolean(manifest && Object.keys(manifest.users).length > 0),
            userCount: manifest ? Object.keys(manifest.users).length : 0,
            repoCount: manifest ? Object.keys(manifest.repos).length : 0,
          },
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // Match Git smart HTTP paths: /:repoId.git/... or /:owner/:repoId.git/...
    const match = pathname.match(/^\/((?:[a-zA-Z0-9_\-\.]+\/)?[a-zA-Z0-9_\-\.]+)\.git(\/.*)?$/);
    if (!match) {
      return new Response("Not Found", { status: 404 });
    }

    const repoId = match[1]!;
    const subpath = match[2] || "";
    const isWrite = pathname.includes("git-receive-pack") || url.search.includes("git-receive-pack");

    // 1. Authenticate credentials if provided
    const creds = this.parseBasicAuth(req);
    let authContext: AuthContext | undefined;
    if (creds) {
      authContext = await this.authStore.authenticate(creds.username, creds.token);
    }

    // 2. Enforce Access Control Policy
    const access = await this.authStore.checkAccess({
      repoId,
      isWrite,
      authContext,
    });

    if (!access.allowed) {
      if (access.status === 401) {
        return new Response(access.reason, {
          status: 401,
          headers: {
            "WWW-Authenticate": 'Basic realm="Continuity Git Server"',
            "Content-Type": "text/plain",
          },
        });
      }
      return new Response(`Forbidden: ${access.reason}`, {
        status: 403,
        headers: { "Content-Type": "text/plain" },
      });
    }

    // Ensure repository exists on disk (or auto-materialize from S3)
    const exists = await this.ensureRepoReady(repoId, isWrite);
    if (!exists) {
      return new Response(`Repository '${repoId}' not found`, { status: 404 });
    }

    const repoDir = this.getRepoPath(repoId);

    // Track existing packfiles before potential push
    const packDir = join(repoDir, "objects", "pack");
    let prePacks = new Set<string>();
    if (isWrite) {
      try {
        const files = await readdir(packDir);
        prePacks = new Set(files.filter((f) => f.endsWith(".pack")));
      } catch {}
    }

    // Run git http-backend CGI
    const queryString = url.search.startsWith("?") ? url.search.slice(1) : "";
    const pathInfo = `/${repoId}.git${subpath}`;

    const proc = Bun.spawn(["git", "http-backend"], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: this.reposDir,
        GIT_HTTP_EXPORT_ALL: "1",
        PATH_INFO: pathInfo,
        REQUEST_METHOD: req.method,
        QUERY_STRING: queryString,
        CONTENT_TYPE: req.headers.get("content-type") || "",
      },
      stdin: req.body ? await req.arrayBuffer() : undefined,
    });

    const [cgiArrayBuffer, stderrText] = await Promise.all([
      new Response(proc.stdout).arrayBuffer(),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    const cgiBytes = new Uint8Array(cgiArrayBuffer);
    await proc.exited;

    if (proc.exitCode !== 0 && cgiBytes.length === 0) {
      console.error(`[CGI Error] git http-backend exited with code ${proc.exitCode}: ${stderrText}`);
      return new Response(`Git CGI Error: ${stderrText}`, { status: 500 });
    }

    // If this was a successful push, upload the packfile to S3 and commit WAL via CAS!
    if (req.method === "POST" && pathname.includes("git-receive-pack") && proc.exitCode === 0) {
      await this.syncPushToS3(repoId, prePacks);

      // Auto-assign repository ownership to authenticated user if newly created
      if (authContext?.user) {
        const manifest = await this.authStore.getManifest();
        if (!manifest.repos[repoId]) {
          await this.authStore.setRepoPolicy({
            repoId,
            owner: authContext.user.username,
            visibility: "public",
          }).catch(() => {});
        }
      }
    }

    return this.parseCgiResponse(cgiBytes);
  }

  /**
   * Parses raw CGI output into standard HTTP Response.
   */
  private parseCgiResponse(cgiBytes: Uint8Array): Response {
    let headerEndIndex = -1;
    let separatorLength = 4; // \r\n\r\n

    for (let i = 0; i < cgiBytes.length - 3; i++) {
      if (
        cgiBytes[i] === 13 &&
        cgiBytes[i + 1] === 10 &&
        cgiBytes[i + 2] === 13 &&
        cgiBytes[i + 3] === 10
      ) {
        headerEndIndex = i;
        separatorLength = 4;
        break;
      }
    }

    if (headerEndIndex === -1) {
      // Fallback check for \n\n
      for (let i = 0; i < cgiBytes.length - 1; i++) {
        if (cgiBytes[i] === 10 && cgiBytes[i + 1] === 10) {
          headerEndIndex = i;
          separatorLength = 2;
          break;
        }
      }
    }

    if (headerEndIndex === -1) {
      return new Response(cgiBytes, { status: 200 });
    }

    const headerText = new TextDecoder().decode(cgiBytes.subarray(0, headerEndIndex));
    const bodyBytes = cgiBytes.subarray(headerEndIndex + separatorLength);

    const headers = new Headers();
    let status = 200;

    for (const line of headerText.split(/\r?\n/)) {
      if (!line) continue;
      const colonIdx = line.indexOf(":");
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const val = line.slice(colonIdx + 1).trim();

      if (key === "status") {
        status = parseInt(val.split(" ")[0] || "200", 10);
      } else {
        headers.set(key, val);
      }
    }

    return new Response(bodyBytes, { status, headers });
  }
}

// Standalone runner when executed directly via 'bun run src/server/git-http-server.ts'
if (import.meta.main) {
  const bucketName = process.env.AWS_S3_BUCKET || process.env.S3_BUCKET_NAME;
  const region = process.env.AWS_REGION || "eu-north-1";

  let storage: R2StorageInterface;
  if (bucketName) {
    storage = new AwsS3Storage({ bucketName, region });
  } else {
    console.log("No AWS_S3_BUCKET specified in environment. Running with in-memory Mock storage.");
    storage = new MockR2Storage();
  }

  const server = new GitHttpServer({ storage });
  await server.start();
}
