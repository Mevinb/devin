import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  attachBudgetToReport, DeviceRegistry, explore, RunBudget, scan, writeHtmlReport, writeJsonReport,
  type DeviceLifecycleEvent, type ExploreConfig, type ExploreProgressEvent, type ScanConfig, type ScanReport, type UsageSnapshot
} from "@pixelsentinel/core";
import { attachProposalsToReport, FixProposalEngine } from "@pixelsentinel/fixer";

const exec = promisify(execFile);
export interface JobEvent {
  id: number;
  type: "status" | "progress" | "agent" | "fleet" | "usage";
  timestamp: string;
  data: unknown;
}
export interface ScanJob {
  id: string;
  target: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: { step: string; completed: number; total: number; detail?: string };
  artifactBaseUrl: string;
  events: JobEvent[];
  fleet: Record<string, DeviceLifecycleEvent>;
  usage: { agentCalls: number; agentTokens: number; budget?: UsageSnapshot };
  report?: ScanReport;
  error?: string;
  createdAt: string;
}
export interface JobOptions {
  explore?: Partial<ExploreConfig>;
  proposeFixes?: boolean;
}

/** One queue per server: jobs cannot tear down another job's emulator or overwrite its artifacts. */
export class ScanJobManager {
  private jobs = new Map<string, ScanJob>();
  private listeners = new Map<string, Set<(event: JobEvent) => void>>();
  private sequences = new Map<string, number>();
  private pending: Promise<void> = Promise.resolve();
  private closing = false;

  constructor(readonly outputDir: string) {}
  list(): ScanJob[] { return [...this.jobs.values()].reverse(); }
  get(id: string): ScanJob | undefined { return this.jobs.get(id); }
  subscribe(id: string, callback: (event: JobEvent) => void): () => void {
    const set = this.listeners.get(id) ?? new Set();
    set.add(callback); this.listeners.set(id, set);
    return () => { set.delete(callback); if (!set.size) this.listeners.delete(id); };
  }
  private publish(job: ScanJob, type: JobEvent["type"], data: unknown) {
    const id = (this.sequences.get(job.id) ?? 0) + 1;
    this.sequences.set(job.id, id);
    const event = { id, type, data, timestamp: new Date().toISOString() };
    job.events.push(event);
    if (job.events.length > 1000) job.events.shift();
    for (const listener of this.listeners.get(job.id) ?? []) {
      try { listener(event); } catch { /* A disconnected observer must not interrupt the scan. */ }
    }
  }
  enqueue(config: ScanConfig, options: JobOptions = {}): ScanJob {
    if (this.closing) throw new Error("Server is shutting down");
    const id = `job-${crypto.randomUUID()}`;
    const job: ScanJob = {
      id, target: config.target, status: "queued", artifactBaseUrl: `/artifacts/${id}/`,
      progress: { step: "queued", completed: 0, total: 1, detail: "Waiting for the device fleet" },
      events: [], fleet: {}, usage: { agentCalls: 0, agentTokens: 0 }, createdAt: new Date().toISOString()
    };
    this.jobs.set(id, job);
    this.publish(job, "status", { status: job.status });
    const jobConfig = structuredClone(config);
    jobConfig.output.dir = path.join(this.outputDir, id);
    this.pending = this.pending.then(() => this.execute(job, jobConfig, options));
    return job;
  }
  async settled(): Promise<void> { await this.pending; }
  async close(): Promise<void> { this.closing = true; await this.pending; }

  private async execute(job: ScanJob, config: ScanConfig, options: JobOptions): Promise<void> {
    const budget = new RunBudget(config.budget);
    const unsubscribeUsage = budget.subscribe((usage) => {
      job.usage = { agentCalls: usage.phases.agent.requests + usage.phases.recovery.requests,
        agentTokens: usage.phases.agent.totalTokens + usage.phases.recovery.totalTokens, budget: usage };
      this.publish(job, "usage", job.usage);
    });
    const registry = new DeviceRegistry((event) => {
      job.fleet[event.targetId] = event;
      this.publish(job, "fleet", event);
    });
    const progress = (step: string, completed: number, total: number, detail?: string) => {
      job.progress = { step, completed, total, detail };
      this.publish(job, "progress", job.progress);
    };
    const onExploreProgress = (event: ExploreProgressEvent) => {
      const screenshotPath = event.screenshotPath
        ? path.relative(config.output.dir, event.screenshotPath).split(path.sep).join("/") : undefined;
      this.publish(job, "agent", { ...event, screenshotPath, usage: job.usage });
      progress(event.phase, event.step, options.explore?.maxSteps ?? 20, event.message ?? `${event.deviceId}: ${event.stateName ?? event.action?.type ?? event.phase}`);
    };
    try {
      job.status = "running";
      this.publish(job, "status", { status: job.status });
      let report: ScanReport;
      if (options.explore) {
        report = (await explore(config, options.explore, { registry, budget, onProgress: onExploreProgress })).report;
      } else report = await scan(config, { registry, budget, onProgress: progress });
      if (options.proposeFixes && !budget.snapshot().stopped) {
        progress("fixes", 0, 1, "Generating and verifying source patches in isolated worktrees");
        const project = path.resolve(config.target);
        const { stdout } = await exec("git", ["rev-parse", "--show-toplevel"], {
          cwd: (await fs.stat(project)).isDirectory() ? project : path.dirname(project)
        });
        const proposals = await new FixProposalEngine({ repoRoot: stdout.trim(), scanConfig: config, model: config.vision.model, budget })
          .proposeFixes(report.matrix.flatMap((item) => item.findings), config.output.dir);
        attachProposalsToReport(report, proposals, config.output.dir);
      }
      attachBudgetToReport(report, budget);
      if (config.output.json) await writeJsonReport(report, config.output.dir);
      if (config.output.html) await writeHtmlReport(report, config.output.dir);
      job.report = report;
      job.usage = { agentCalls: report.summary.agentCalls ?? 0, agentTokens: report.summary.agentTokens ?? 0, budget: report.usage };
      job.status = "completed";
      progress("completed", report.summary.totalViewports, report.summary.totalViewports, report.errors?.length ? "Scan finished with device or replay errors" : "Scan completed");
      this.publish(job, "status", { status: job.status });
    } catch (err) {
      job.status = "failed";
      job.error = err instanceof Error ? err.message : String(err);
      progress("failed", 0, 1, job.error);
      this.publish(job, "status", { status: job.status, error: job.error });
    } finally { unsubscribeUsage(); budget.dispose(); await registry.shutdownAll(); }
  }
}
