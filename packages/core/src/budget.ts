import { z } from "zod";
import type { ScanReport } from "./report/types.js";

export const BudgetConfigSchema = z.object({
  maxMinutes: z.number().finite().positive().max(120).default(5),
  maxActions: z.number().int().nonnegative().max(1000000).optional(),
  maxStates: z.number().int().positive().max(10000).optional(),
  maxTokens: z.number().int().nonnegative().max(1000000000).optional(),
  maxCostUsd: z.number().finite().nonnegative().max(1000000).optional(),
  models: z.record(z.object({
    /** An upper bound on input tokens accepted by the configured model. */
    contextTokens: z.number().int().positive().max(10000000),
    inputUsdPerMillion: z.number().finite().nonnegative().max(10000).optional(),
    outputUsdPerMillion: z.number().finite().nonnegative().max(10000).optional()
  }).refine((model) => (model.inputUsdPerMillion === undefined) === (model.outputUsdPerMillion === undefined), "Provide both input and output prices")).default({})
});
export type BudgetConfig = z.input<typeof BudgetConfigSchema>;
export type UsagePhase = "agent" | "recovery" | "vision" | "fixer";
export interface PhaseUsage {
  requests: number; promptTokens: number; completionTokens: number; totalTokens: number;
  cacheHits: number; uncertainRequests: number; unpricedRequests: number;
  /** Null when any dispatched request lacks usage or configured pricing. */
  costUsd: number | null;
  knownCostUsd: number; reservedTokens: number; reservedCostUsd: number;
}
export interface UsageSnapshot extends PhaseUsage {
  phases: Record<UsagePhase, PhaseUsage>;
  actions: number; states: number; elapsedMs: number;
  limits: BudgetConfig;
  stopped?: { kind: string; message: string };
  stateLimitReached: boolean;
}
export class BudgetExceededError extends Error {
  readonly code = "PIXELSENTINEL_BUDGET_EXCEEDED";
  constructor(readonly kind: string, message: string) { super(message); this.name = "BudgetExceededError"; }
}
export class StateLimitError extends Error {
  readonly code = "PIXELSENTINEL_STATE_LIMIT";
  constructor(limit: number) { super(`Reached the shared state limit (${limit})`); this.name = "StateLimitError"; }
}
export function isBudgetError(error: unknown): error is BudgetExceededError {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "PIXELSENTINEL_BUDGET_EXCEEDED");
}
export function isStateLimit(error: unknown): error is StateLimitError {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "PIXELSENTINEL_STATE_LIMIT");
}

const phases: UsagePhase[] = ["agent", "recovery", "vision", "fixer"];
const empty = (): PhaseUsage => ({ requests: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, cacheHits: 0,
  uncertainRequests: 0, unpricedRequests: 0, costUsd: 0, knownCostUsd: 0, reservedTokens: 0, reservedCostUsd: 0 });
const receiptSchema = z.object({ prompt_tokens: z.number().int().nonnegative(), completion_tokens: z.number().int().nonnegative(), total_tokens: z.number().int().nonnegative() })
  .refine((usage) => usage.total_tokens === usage.prompt_tokens + usage.completion_tokens);
const moneyUnits = (usd: number) => Math.ceil(usd * 1e9);

/** One ledger is owned by a complete scan/explore/replay + optional fixer job. */
export class RunBudget {
  readonly config: z.output<typeof BudgetConfigSchema>;
  readonly signal: AbortSignal;
  private readonly controller = new AbortController();
  private readonly started = Date.now();
  private deadline: number;
  private timer?: ReturnType<typeof setTimeout>;
  private readonly meters = Object.fromEntries(phases.map((phase) => [phase, empty()])) as Record<UsagePhase, PhaseUsage>;
  private readonly stateKeys = new Set<string>();
  private actions = 0;
  private stateLimitReached = false;
  private stopped?: UsageSnapshot["stopped"];
  private failure?: BudgetExceededError;
  private listeners = new Set<(usage: UsageSnapshot) => void>();

  constructor(config: BudgetConfig = {}) {
    this.config = BudgetConfigSchema.parse(config); this.signal = this.controller.signal;
    this.deadline = this.config.maxMinutes === undefined ? Infinity : this.started + this.config.maxMinutes * 60000;
    if (Number.isFinite(this.deadline)) {
      this.timer = setTimeout(() => this.stop("time", "Reached the shared time budget"), Math.max(1, this.deadline - Date.now()));
      this.timer.unref();
    }
  }
  dispose(): void { clearTimeout(this.timer); }
  constrain(limits: Pick<BudgetConfig, "maxMinutes" | "maxActions" | "maxStates" | "maxTokens" | "maxCostUsd">): void {
    const parsed = BudgetConfigSchema.parse(limits);
    for (const key of ["maxMinutes", "maxActions", "maxStates", "maxTokens", "maxCostUsd"] as const) {
      if (limits[key] !== undefined) this.config[key] = Math.min(this.config[key] ?? Infinity, parsed[key]!);
    }
    clearTimeout(this.timer);
    this.deadline = this.config.maxMinutes === undefined ? Infinity : this.started + this.config.maxMinutes * 60000;
    if (Number.isFinite(this.deadline)) {
      this.timer = setTimeout(() => this.stop("time", "Reached the shared time budget"), Math.max(1, this.deadline - Date.now())); this.timer.unref();
    }
    this.assertActive(); this.emit();
  }
  subscribe(listener: (usage: UsageSnapshot) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private emit(): void { for (const listener of this.listeners) { try { listener(this.snapshot()); } catch { /* Observers do not control execution. */ } } }
  private stop(kind: string, message: string): BudgetExceededError {
    if (!this.stopped) { this.stopped = { kind, message }; this.failure = new BudgetExceededError(kind, message); this.emit(); }
    // Approved in-flight calls may finish and provide usage receipts when a new
    // reservation is denied. A deadline must also interrupt those calls.
    if (kind === "time" && !this.signal.aborted) this.controller.abort(this.failure);
    return this.failure!;
  }
  assertActive(): void {
    if (Date.now() >= this.deadline) throw this.stop("time", "Reached the shared time budget");
    if (this.failure) throw this.failure;
  }
  rejectConfiguration(message: string): never { throw this.stop("configuration", message); }
  remainingMs(): number { this.assertActive(); return Math.max(1, this.deadline - Date.now()); }
  consumeAction(): void {
    this.assertActive();
    if (this.actions >= (this.config.maxActions ?? Infinity)) throw this.stop("actions", "Reached the shared action budget");
    this.actions++; this.emit();
  }
  claimState(key: string): void {
    this.assertActive(); if (this.stateKeys.has(key)) return;
    if (this.stateKeys.size >= (this.config.maxStates ?? Infinity)) { this.stateLimitReached = true; this.emit(); throw new StateLimitError(this.config.maxStates!); }
    this.stateKeys.add(key); this.emit();
  }
  cacheHit(phase: UsagePhase): void { this.assertActive(); this.meters[phase].cacheHits++; this.emit(); }
  onAbort(cleanup: () => Promise<unknown>): () => void {
    const abort = () => { void cleanup().catch(() => {}); };
    if (this.signal.aborted) abort(); else this.signal.addEventListener("abort", abort, { once: true });
    return () => this.signal.removeEventListener("abort", abort);
  }
  async run<T>(operation: () => Promise<T>, cleanupLateResult?: (result: T) => Promise<unknown>): Promise<T> {
    this.assertActive();
    const pending = operation();
    return new Promise<T>((resolve, reject) => {
      let aborted = false;
      const abort = () => { aborted = true; reject(this.signal.reason); };
      this.signal.addEventListener("abort", abort, { once: true });
      if (this.signal.aborted) abort();
      pending.then((result) => {
        this.signal.removeEventListener("abort", abort);
        if (aborted) { if (cleanupLateResult) void cleanupLateResult(result).catch(() => {}); }
        else resolve(result);
      }, (error) => { this.signal.removeEventListener("abort", abort); reject(error); });
    });
  }

  async request<T extends { usage?: unknown }>(phase: UsagePhase, model: string, maxOutputTokens: number,
    invoke: (context: { signal: AbortSignal; timeout: number }) => Promise<T>): Promise<T> {
    this.assertActive();
    if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) throw this.stop("configuration", "Request output token ceiling must be a positive integer");
    const limits = Object.hasOwn(this.config.models, model) ? this.config.models[model] : undefined, meter = this.meters[phase];
    const priced = limits?.inputUsdPerMillion !== undefined && limits.outputUsdPerMillion !== undefined;
    if ((this.config.maxTokens !== undefined || this.config.maxCostUsd !== undefined) && !limits) {
      throw this.stop("configuration", `Configure model '${model}' token ceiling and pricing before enabling token/cost caps`);
    }
    if (this.config.maxCostUsd !== undefined && !priced) throw this.stop("configuration", `Configure model '${model}' input/output pricing before enabling the cost cap`);
    const reservedTokens = limits ? limits.contextTokens + maxOutputTokens : 0;
    const reserveCost = priced ? moneyUnits((limits.contextTokens * limits.inputUsdPerMillion! + maxOutputTokens * limits.outputUsdPerMillion!) / 1e6) / 1e9 : 0;
    const current = this.snapshot();
    if (this.config.maxTokens !== undefined && current.totalTokens + current.reservedTokens + reservedTokens > this.config.maxTokens) throw this.stop("tokens", "Insufficient capacity in the shared token budget for another request");
    if (this.config.maxCostUsd !== undefined && moneyUnits(current.knownCostUsd + current.reservedCostUsd + reserveCost) > Math.floor(this.config.maxCostUsd * 1e9)) throw this.stop("cost", "Insufficient capacity in the shared cost budget for another request");
    meter.reservedTokens += reservedTokens; meter.reservedCostUsd += reserveCost;
    this.emit();
    let settled = false, dispatched = false;
    try {
      const response = await this.run(() => {
        const context = { signal: this.signal, timeout: Math.min(30000, this.remainingMs()) };
        dispatched = true; meter.requests++; if (!priced) meter.unpricedRequests++;
        const pending = invoke(context); this.emit(); return pending;
      });
      const parsed = receiptSchema.safeParse(response.usage);
      if (parsed.success) {
        const usage = parsed.data;
        meter.reservedTokens -= reservedTokens; meter.reservedCostUsd = Math.max(0, meter.reservedCostUsd - reserveCost);
        meter.promptTokens += usage.prompt_tokens; meter.completionTokens += usage.completion_tokens; meter.totalTokens += usage.total_tokens;
        if (priced) meter.knownCostUsd += moneyUnits((usage.prompt_tokens * limits.inputUsdPerMillion! + usage.completion_tokens * limits.outputUsdPerMillion!) / 1e6) / 1e9;
        settled = true;
        if (limits && (usage.prompt_tokens > limits.contextTokens || usage.completion_tokens > maxOutputTokens)) throw this.stop("model-ceiling", `Model '${model}' reported usage beyond its configured token ceiling; further work stopped`);
      } else { meter.uncertainRequests++; settled = true; }
      this.emit(); return response;
    } catch (error) {
      if (!dispatched) { meter.reservedTokens -= reservedTokens; meter.reservedCostUsd = Math.max(0, meter.reservedCostUsd - reserveCost); }
      else if (!settled) meter.uncertainRequests++;
      // Without a usage receipt, the conservative allocation remains committed.
      this.emit(); throw error;
    }
  }
  snapshot(): UsageSnapshot {
    const phaseMeters = Object.fromEntries(phases.map((phase) => {
      const meter = this.meters[phase];
      return [phase, { ...meter, costUsd: meter.unpricedRequests || meter.uncertainRequests ? null : meter.knownCostUsd }];
    })) as Record<UsagePhase, PhaseUsage>;
    const total = empty();
    for (const meter of Object.values(phaseMeters)) {
      for (const key of ["requests", "promptTokens", "completionTokens", "totalTokens", "cacheHits", "uncertainRequests", "unpricedRequests", "knownCostUsd", "reservedTokens", "reservedCostUsd"] as const) total[key] += meter[key];
    }
    total.costUsd = total.unpricedRequests || total.uncertainRequests ? null : total.knownCostUsd;
    return { ...total, phases: phaseMeters, actions: this.actions, states: this.stateKeys.size, elapsedMs: Date.now() - this.started,
      limits: structuredClone(this.config), stopped: this.stopped, stateLimitReached: this.stateLimitReached };
  }
}

export function attachBudgetToReport(report: ScanReport, budget: RunBudget): void {
  report.usage = budget.snapshot();
  const { agent, recovery } = report.usage.phases;
  report.summary.agentCalls = agent.requests + recovery.requests;
  report.summary.agentTokens = agent.totalTokens + recovery.totalTokens;
  const warnings = new Set(report.warnings ?? []);
  if (report.usage.unpricedRequests) warnings.add("Some AI requests have no configured prices; total dollar cost is unknown.");
  if (report.usage.uncertainRequests) warnings.add("Some AI requests have no valid usage receipt; any configured conservative allocations remain reserved.");
  if (report.usage.stateLimitReached) warnings.add("The shared discovery state limit was reached; only already-discovered states can be replayed.");
  if (report.usage.stopped) {
    const message = report.usage.stopped.message;
    warnings.add(message);
    if (!report.errors?.some((error) => error.targetId === "budget")) (report.errors ??= []).push({ targetId: "budget", message });
  }
  report.warnings = [...warnings];
}
