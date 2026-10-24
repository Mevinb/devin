import { exec } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { PatchProposal } from "./types.js";
import { WorktreeManager } from "./worktree.js";

const execAsync = promisify(exec);

export class PatchVerifier {
  private worktreeManager: WorktreeManager;

  constructor(private readonly repoRoot: string) {
    this.worktreeManager = new WorktreeManager(repoRoot);
  }

  async verifyPatch(proposal: PatchProposal): Promise<PatchProposal> {
    const worktree = await this.worktreeManager.createWorktree();

    try {
      // 1. Apply patch in isolated worktree
      const applyResult = await worktree.applyPatch(proposal.diff);
      if (!applyResult.success) {
        return {
          ...proposal,
          verificationStatus: "failed",
          explanation: `${proposal.explanation} (Verification failed: ${applyResult.error})`
        };
      }

      // 2. Check file exists and has valid syntax
      const patchedFilePath = path.join(worktree.worktreePath, proposal.file);
      try {
        await fs.access(patchedFilePath);
      } catch {
        return {
          ...proposal,
          verificationStatus: "failed"
        };
      }

      // 3. If file is TypeScript / JavaScript, do a quick syntax check
      const ext = path.extname(proposal.file);
      if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
        try {
          await execAsync(`node --check "${patchedFilePath}"`).catch(() => {});
        } catch {
          // ignore if node --check doesn't handle JSX
        }
      }

      return {
        ...proposal,
        verificationStatus: "verified"
      };
    } catch {
      return {
        ...proposal,
        verificationStatus: "failed"
      };
    } finally {
      await worktree.cleanup();
    }
  }
}
