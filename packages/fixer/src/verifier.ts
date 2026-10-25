import fs from "node:fs/promises";
import path from "node:path";
import {
  analyzeCapture, attachPageMonitor, captureCurrentState, createVisionProvider, DeviceRegistry,
  executeAction, expandMatrix, resolveTarget, ScanConfigSchema, snapshotPage, stabilizePage,
  type AgentAction, type AnalyzedCapture, type DeviceTarget, type Finding, type ScanConfigInput
} from "@pixelsentinel/core";
import { isBudgetError, type RunBudget } from "@pixelsentinel/core";
import type { PatchProposal } from "./types.js";
import { WorktreeManager } from "./worktree.js";

export interface VerificationContext {
  finding: Finding;
  scanConfig: ScanConfigInput;
  outputDir?: string;
  budget?: RunBudget;
}

function sameFinding(candidate: Finding, original: Finding): boolean {
  if (candidate.type !== original.type) return false;
  if (!original.elements.length) return candidate.description.replace(/:\d+/g, ":PORT") === original.description.replace(/:\d+/g, ":PORT");
  return candidate.elements.some((a) => original.elements.some((b) => a.selector === b.selector));
}

function signature(finding: Finding): string {
  return `${finding.type}|${finding.severity}|${finding.elements.map((el) => el.selector).sort().join(",")}`;
}

export class PatchVerifier {
  constructor(private readonly repoRoot: string) {}

  async verifyPatch(proposal: PatchProposal, context?: VerificationContext): Promise<PatchProposal> {
    let worktree: Awaited<ReturnType<WorktreeManager["createWorktree"]>> | undefined;
    const captures: Record<string, string> = {};
    const result = (verificationStatus: PatchProposal["verificationStatus"], verificationMessage: string) => ({
      ...proposal, verificationStatus, verificationMessage,
      beforeScreenshotPath: context?.outputDir ? captures.before : proposal.beforeScreenshotPath,
      verifiedScreenshotPath: context?.outputDir ? captures.after : proposal.verifiedScreenshotPath
    });
    try {
      context?.budget?.assertActive();
      const create = () => new WorktreeManager(this.repoRoot).createWorktree();
      worktree = context?.budget ? await context.budget.run(create, (late) => late.cleanup()) : await create();
      if (!context) {
        const applied = await worktree.applyPatch(proposal.diff);
        return applied.success
          ? result("unverified", "Patch applies, but no finding and scan configuration were supplied for rendering verification.")
          : result("failed", `Patch did not apply: ${applied.error}`);
      }
      const { scanConfig, finding } = context;
      if (/^https?:\/\//i.test(scanConfig.target)) return result("unverified", "Rendering verification requires a local project target.");
      if (finding.sources.includes("vision") && (!scanConfig.vision?.enabled || !process.env.OPENAI_API_KEY)) {
        return result("unverified", "Vision findings require the original vision analysis to be enabled for verification.");
      }
      const relative = path.relative(this.repoRoot, path.resolve(scanConfig.target));
      if (relative.startsWith("..") || path.isAbsolute(relative)) return result("unverified", "Scan target is outside the source repository.");
      const target = path.join(worktree.worktreePath, relative);
      const registry = new DeviceRegistry();
      const config = ScanConfigSchema.parse({ ...scanConfig, target, extraWaitMs: scanConfig.extraWaitMs ?? 250 });
      let device: DeviceTarget;
      if (finding.renderConfig) device = finding.renderConfig.deviceTarget ?? registry.resolveTarget(finding.renderConfig);
      else if (finding.targetId) device = registry.resolveTarget(
        config.devices?.find((d) => typeof d !== "string" && d.id === finding.targetId) as DeviceTarget | undefined ?? finding.targetId
      );
      else {
        const viewport = expandMatrix(config).find((v) => v.renderId === finding.renderId);
        if (!viewport) return result("unverified", "Original render configuration is missing; cannot verify on the affected viewport.");
        device = registry.resolveTarget(viewport);
      }
      // Node dependencies may be reused; authored source files are independent copies.
      if (config.devServer?.command) {
        for (let dir = path.resolve(scanConfig.target); dir.startsWith(this.repoRoot); dir = path.dirname(dir)) {
          const source = path.join(dir, "node_modules");
          try {
            if ((await fs.stat(source)).isDirectory()) {
              const destination = path.join(worktree.worktreePath, path.relative(this.repoRoot, dir), "node_modules");
              await fs.mkdir(path.dirname(destination), { recursive: true });
              await fs.symlink(source, destination, "dir");
            }
          } catch (err) {
            if (!["ENOENT", "EEXIST"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
          }
          if (dir === this.repoRoot || path.dirname(dir) === dir) break;
        }
        // Port 0 requests an ephemeral port; {port} and PORT are resolved by the dev-server runner.
        config.devServer.port = 0;
      }
      const artifactRoot = context.outputDir
        ? path.resolve(context.outputDir, "fixes", "verification", proposal.id, finding.renderId.replace(/[^\w.-]/g, "_"))
        : path.join(worktree.worktreePath, ".verification");
      const vision = createVisionProvider(config.vision, context.budget);
      let visionCalls = 0;
      const checkedVision: typeof vision = {
        ...vision,
        analyze: async (...args) => { const response = await vision.analyze(...args); visionCalls++; return response; }
      };
      const capture = async (stage: string): Promise<AnalyzedCapture> => {
        context.budget?.assertActive();
        const server = await resolveTarget(config, undefined, context.budget?.signal);
        let session: Awaited<ReturnType<ReturnType<DeviceRegistry["getRuntime"]>["launch"]>> | undefined;
        try {
          const launch = () => registry.getRuntime(device.runtime).launch(device);
          session = context.budget ? await context.budget.run(launch, (late) => late.close()) : await launch();
          const detachAbort = context.budget?.onAbort(() => session!.page.close());
          if (finding.fidelity && session.target.fidelity !== finding.fidelity) throw new Error("Verification runtime fidelity differs from the original scan");
          const monitor = attachPageMonitor(session.page);
          try {
            const url = session.prepareUrl ? await session.prepareUrl(server.url) : server.url;
            await session.page.goto(url, { waitUntil: config.waitUntil, timeout: 30000 });
            for (const recorded of finding.actions ?? proposal.actions ?? []) {
              if ((recorded as AgentAction).type !== "done") context.budget?.consumeAction();
              let action = recorded as AgentAction;
              if (action.type === "navigate") {
                const original = new URL(action.url, server.url);
                // Replay local navigation against this worktree's server, not the original app.
                if (["localhost", "127.0.0.1", "[::1]"].includes(original.hostname)) {
                  action = { ...action, url: new URL(original.pathname + original.search + original.hash, server.url).href };
                }
              }
              const executed = await executeAction(session, action, await snapshotPage(session.page));
              if (!executed.success) throw new Error(`State replay failed: ${executed.details}`);
            }
            await stabilizePage(session.page, config.extraWaitMs);
            const shot = await captureCurrentState({ session, renderId: `verify-${stage}`, renderDir: path.join(artifactRoot, stage),
              url, fullPage: config.fullPage, monitor, probeKeyboard: true });
            captures[stage] = shot.screenshotPath;
            const analyzed = await analyzeCapture(shot, config, checkedVision, {}, context.budget);
            context.budget?.assertActive();
            return analyzed;
          } finally { monitor.detach(); detachAbort?.(); }
        } finally {
          await session?.close();
          await server.cleanup();
        }
      };
      try {
        const before = await capture("before");
        if (!before.findings.some((f) => sameFinding(f, finding))) {
          return result("unverified", "The original finding did not reproduce before applying the patch.");
        }
        const applied = await worktree.applyPatch(proposal.diff);
        if (!applied.success) return result("failed", `Patch did not apply: ${applied.error}`);
        const after = await capture("after");
        if (config.vision.enabled && (vision.warning || visionCalls !== 2)) return result("unverified", "Configured vision verification did not complete for both captures.");
        const remaining = after.findings.some((f) => sameFinding(f, finding));
        const counts = new Map<string, number>();
        for (const f of before.findings) counts.set(signature(f), (counts.get(signature(f)) ?? 0) + 1);
        const introduced = after.findings.filter((f) => {
          const key = signature(f), available = counts.get(key) ?? 0;
          counts.set(key, available - 1);
          return available <= 0;
        });
        return {
          ...result(remaining || introduced.length ? "failed" : "verified", remaining
            ? "The original finding remains after applying the patch."
            : introduced.length ? `Patch introduced ${introduced.length} new findings in the affected state.`
              : "Original finding reproduced before the patch, cleared afterwards, and no new findings appeared."),
          beforeScreenshotPath: context.outputDir ? before.capture.screenshotPath : undefined,
          verifiedScreenshotPath: context.outputDir ? after.capture.screenshotPath : undefined
        };
      } finally { await registry.shutdownAll(); }
    } catch (err) {
      if (isBudgetError(err) || context?.budget?.signal.aborted) return result("unverified", `Verification stopped: ${context?.budget?.snapshot().stopped?.message ?? (err as Error).message}`);
      return result("unverified", `Rendering verification could not complete: ${(err as Error).message}`);
    } finally { await worktree?.cleanup(); }
  }
}
