import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MockR2Storage } from "../storage/mock-r2.ts";
import { GitHttpServer } from "../server/git-http-server.ts";
import { runGit } from "../engine/git-process.ts";

describe("Phase 9: Git Smart HTTP Server Daemon (EC2 Production)", () => {
  const testDir = join(process.cwd(), ".sim_data", "test_http_server");
  const serverReposDir = join(testDir, "server_repos");
  const clientRepoDir = join(testDir, "client_project");
  const clonedRepoDir = join(testDir, "cloned_project");
  const testPort = 8999;

  let storage: MockR2Storage;
  let server: GitHttpServer;

  beforeAll(async () => {
    await rm(testDir, { recursive: true, force: true });
    await mkdir(serverReposDir, { recursive: true });
    await mkdir(clientRepoDir, { recursive: true });

    storage = new MockR2Storage();
    server = new GitHttpServer({
      port: testPort,
      storage,
      dataDir: serverReposDir,
    });
    await server.start();
  });

  afterAll(async () => {
    server.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test("should handle healthcheck endpoint", async () => {
    const res = await fetch(`http://localhost:${testPort}/health`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe("healthy");
    expect(data.server).toBe("Strata Git Server");
  });

  test("should accept native git push over HTTP and upload to S3 WAL", async () => {
    const repoId = "project-alpha";

    // 1. Create client Git repo locally
    await runGit(["init", "-b", "main"], { cwd: clientRepoDir });
    await writeFile(join(clientRepoDir, "app.ts"), `console.log("Deployed on EC2!");\n`);
    await runGit(["add", "."], { cwd: clientRepoDir });
    await runGit(["commit", "-m", "feat: first commit over smart HTTP"], { cwd: clientRepoDir });

    const localSha = (await runGit(["rev-parse", "HEAD"], { cwd: clientRepoDir })).trim();

    // 2. Execute native git push over HTTP to our Bun server
    const remoteUrl = `http://localhost:${testPort}/${repoId}.git`;
    const pushOutput = await runGit(["push", remoteUrl, "main"], { cwd: clientRepoDir });
    expect(pushOutput).toBeDefined();

    // Give asynchronous S3 sync a few milliseconds to complete
    await Bun.sleep(50);

    // 3. Verify S3 Write-Ahead Log has the committed state!
    const indexRes = await storage.getObject(`${repoId}/wal_index.json`);
    expect(indexRes.status).toBe(200);
    expect(indexRes.data).toBeDefined();

    const wal = JSON.parse(new TextDecoder().decode(indexRes.data!));
    expect(wal.version).toBe(1);
    expect(wal.references["refs/heads/main"]).toBe(localSha);
    expect(wal.packfiles.length).toBeGreaterThanOrEqual(1);
  });

  test("should auto-materialize cold repository from S3 on clone after EC2 host wipe", async () => {
    const repoId = "project-alpha";
    const serverRepoPath = join(serverReposDir, `${repoId}.git`);

    // 1. Simulate EC2 host termination / disk loss: Wipe the server disk completely!
    await rm(serverRepoPath, { recursive: true, force: true });

    // 2. Clone from the server: Server must detect cold disk, pull from S3 WAL, and serve clone!
    const remoteUrl = `http://localhost:${testPort}/${repoId}.git`;
    await runGit(["clone", remoteUrl, clonedRepoDir]);

    // 3. Verify the cloned project has identical commit history and files
    const log = await runGit(["log", "--oneline"], { cwd: clonedRepoDir });
    expect(log).toContain("feat: first commit over smart HTTP");

    const content = await Bun.file(join(clonedRepoDir, "app.ts")).text();
    expect(content).toBe(`console.log("Deployed on EC2!");\n`);
  });
});
