/**
 * Subprocess wrapper for executing native Git commands using Bun.spawn.
 */

export interface GitRunOptions {
  cwd?: string;
  env?: Record<string, string>;
}

/**
 * Executes a native Git command asynchronously using Bun's process runner.
 * Throws a descriptive error if the exit code is non-zero.
 */
export async function runGit(args: string[], options: GitRunOptions = {}): Promise<string> {
  const env: Record<string, string> = {
    ...process.env,
    GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || "Continuity Engine",
    GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || "engine@continuity.cursor.com",
    GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || "Continuity Engine",
    GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || "engine@continuity.cursor.com",
    ...options.env,
  };

  const proc = Bun.spawn(["git", ...args], {
    cwd: options.cwd,
    stdout: "pipe",
    stderr: "pipe",
    env,
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    const errorDetails = stderr.trim() || stdout.trim();
    throw new Error(`Git command failed [git ${args.join(" ")}] (exit ${exitCode}): ${errorDetails}`);
  }

  return stdout.trim();
}
