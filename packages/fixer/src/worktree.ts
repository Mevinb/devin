import { exec } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

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
    const baseDir = path.join(this.repoRoot, ".pixelsentinel", "worktrees");
    await fs.mkdir(baseDir, { recursive: true });

    const worktreePath = path.join(baseDir, id);

    // Create detached worktree at HEAD
    await execAsync(`git worktree add -d "${worktreePath}" HEAD`, { cwd: this.repoRoot });

    return {
      id,
      worktreePath,
      applyPatch: async (diff: string): Promise<{ success: boolean; error?: string }> => {
        const patchFile = path.join(worktreePath, ".pixelsentinel-patch.diff");
        const patchContent = diff.endsWith("\n") ? diff : `${diff}\n`;
        await fs.writeFile(patchFile, patchContent, "utf8");

        try {
          // If the file exists in repo root but not yet in worktree (e.g. uncommitted fixture/source file), mirror it
          const fileMatch = diff.match(/--- a\/([^\t\n\r]+)/) || diff.match(/\+\+\+ b\/([^\t\n\r]+)/);
          if (fileMatch) {
            const relFile = fileMatch[1].trim();
            const srcInRepo = path.join(this.repoRoot, relFile);
            const dstInWorktree = path.join(worktreePath, relFile);

            try {
              await fs.access(dstInWorktree);
            } catch {
              // Not present in HEAD, check if present in current working directory
              try {
                await fs.access(srcInRepo);
                await fs.mkdir(path.dirname(dstInWorktree), { recursive: true });
                await fs.copyFile(srcInRepo, dstInWorktree);
              } catch {
                // ignore
              }
            }
          }

          // 1. Dry run check
          await execAsync(`git apply --check --ignore-whitespace "${patchFile}"`, { cwd: worktreePath });
          // 2. Apply patch in worktree
          await execAsync(`git apply --ignore-whitespace "${patchFile}"`, { cwd: worktreePath });
          await fs.unlink(patchFile).catch(() => {});
          return { success: true };
        } catch (err: unknown) {
          await fs.unlink(patchFile).catch(() => {});
          return { success: false, error: (err as Error).message };
        }
      },

      cleanup: async () => {
        try {
          await execAsync(`git worktree remove --force "${worktreePath}"`, {
            cwd: this.repoRoot
          });
        } catch {
          // ignore
        }
        await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => {});
      }
    };
  }
}
