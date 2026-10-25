import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";

const execAsync = promisify(execFile);

export interface IsolatedWorktree {
  id: string;
  worktreePath: string;
  applyPatch(diff: string): Promise<{ success: boolean; error?: string }>;
  cleanup(): Promise<void>;
}

export class WorktreeManager {
  constructor(private readonly repoRoot: string) {}

  async createWorktree(): Promise<IsolatedWorktree> {
    const id = `ps-${crypto.randomUUID().slice(0, 8)}`;
    // Keep verification files outside the app's file watchers and source directory.
    const sandboxDir = await fs.mkdtemp(path.join(os.tmpdir(), `${id}-`));
    const metadata = path.join(sandboxDir, "repository.git");
    const worktreePath = path.join(sandboxDir, "tree");
    try {
      // Private metadata keeps the source .git untouched (also works in read-only checkouts).
      await execAsync("git", ["clone", "--bare", "--shared", "--", this.repoRoot, metadata]);
      await execAsync("git", [`--git-dir=${metadata}`, "worktree", "add", "--detach", worktreePath, "HEAD"]);
      // Verify the current source, including dirty/untracked files, rather than stale HEAD contents.
      const { stdout } = await execAsync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
        cwd: this.repoRoot, maxBuffer: 20 * 1024 * 1024
      });
      for (const file of new Set(stdout.split("\0").filter(Boolean))) {
        if (file.startsWith(".pixelsentinel/") || file.split("/").includes("node_modules")) continue;
        const source = path.join(this.repoRoot, file);
        const destination = path.join(worktreePath, file);
        await fs.rm(destination, { force: true, recursive: true });
        try {
          const stat = await fs.lstat(source);
          // External symlinks must never turn an isolated patch into a write to user source.
          if (!stat.isFile()) continue;
          await fs.mkdir(path.dirname(destination), { recursive: true });
          await fs.copyFile(source, destination);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
    } catch (err) {
      await fs.rm(sandboxDir, { recursive: true, force: true });
      throw err;
    }

    return {
      id,
      worktreePath,
      applyPatch: async (diff: string): Promise<{ success: boolean; error?: string }> => {
        const patchFile = path.join(worktreePath, ".pixelsentinel-patch.diff");
        const patchContent = diff.endsWith("\n") ? diff : `${diff}\n`;
        await fs.writeFile(patchFile, patchContent, "utf8");

        try {
          const { stdout } = await execAsync("git", ["apply", "--numstat", "-z", patchFile], { cwd: worktreePath });
          const files = stdout.split("\0").filter(Boolean).map((entry) => entry.split("\t").slice(2).join("\t"));
          if (!files.length) throw new Error("Patch does not change any files");
          for (const file of files) {
            if (!file || path.isAbsolute(file) || file.split(/[\\/]/).some((p) => p === ".." || p === ".git")) {
              throw new Error(`Invalid patch path: ${file}`);
            }
            // A proposal must map to a real source file, not a hallucinated filename.
            const stat = await fs.lstat(path.join(worktreePath, file));
            if (!stat.isFile()) throw new Error(`Patch path is not a source file: ${file}`);
          }

          // 1. Dry run check
          await execAsync("git", ["apply", "--check", patchFile], { cwd: worktreePath });
          // 2. Apply patch in worktree
          await execAsync("git", ["apply", patchFile], { cwd: worktreePath });
          await fs.unlink(patchFile).catch(() => {});
          return { success: true };
        } catch (err: unknown) {
          await fs.unlink(patchFile).catch(() => {});
          return { success: false, error: (err as Error).message };
        }
      },

      cleanup: async () => {
        await fs.rm(sandboxDir, { recursive: true, force: true });
      }
    };
  }
}
