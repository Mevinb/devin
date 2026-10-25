import { useEffect, useState } from "react";
import type { DeviceLifecycleEvent, ExploreProgressEvent, ScanReport, UsageSnapshot } from "@pixelsentinel/core";
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
export function artifactUrl(base: string, relative: string): string {
  return base + relative.split(/[\\/]/).map(encodeURIComponent).join("/");
}
export class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "HttpError"; }
}
export async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, options);
  const data = await response.json();
  if (!response.ok) throw new HttpError(response.status, data.error ?? `Request failed (${response.status})`);
  return data as T;
}

/** SSE supplies immediate events; one non-overlapping poll recovers missed events and reconnects. */
export function useScanJob(id: string | null) {
  const [job, setJob] = useState<ScanJob | null>(null);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [missingJobId, setMissingJobId] = useState<string | null>(null);
  useEffect(() => {
    setConnectionError(null); setMissingJobId(null); setJob(null);
    if (!id) return;
    let alive = true, fetching = false, failures = 0;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    const apply = (next: ScanJob) => { if (alive) { setJob(next); setConnectionError(null); } };
    const poll = async () => {
      if (!alive || fetching) return;
      fetching = true;
      try {
        apply(await fetchJson<ScanJob>(`/api/scans/${id}`, { signal: controller.signal })); failures = 0;
      } catch (error) {
        if (alive && error instanceof HttpError && error.status === 404) {
          setMissingJobId(id);
          source?.close();
          return;
        }
        if (alive && ++failures >= 3) setConnectionError(`Connection interrupted: ${(error as Error).message}`);
      } finally { fetching = false; }
    };
    const source = typeof EventSource !== "undefined" ? new EventSource(`/api/scans/${id}/events`) : null;
    source?.addEventListener("snapshot", (message) => apply(JSON.parse((message as MessageEvent).data)));
    const onEvent = (message: Event) => {
      const event = JSON.parse((message as MessageEvent).data) as JobEvent;
      if (event.type === "status") { void poll(); return; }
      setJob((current) => {
        if (!alive || !current || current.id !== id) return current;
        const events = current.events.some((item) => item.id === event.id) ? current.events : [...current.events, event].slice(-1000);
        if (event.type === "progress") return { ...current, events, progress: event.data as ScanJob["progress"] };
        if (event.type === "usage") return { ...current, events, usage: event.data as ScanJob["usage"] };
        if (event.type === "fleet") {
          const device = event.data as DeviceLifecycleEvent;
          return { ...current, events, fleet: { ...current.fleet, [device.targetId]: device } };
        }
        const observation = event.data as ExploreProgressEvent & { usage?: ScanJob["usage"] };
        return { ...current, events, usage: observation.usage ?? current.usage };
      });
    };
    for (const type of ["status", "progress", "fleet", "agent", "usage"]) source?.addEventListener(type, onEvent);
    const schedule = async () => { await poll(); if (alive) timer = setTimeout(schedule, 1500); };
    void schedule();
    return () => { alive = false; clearTimeout(timer); source?.close(); controller.abort(); };
  }, [id]);
  return { job, connectionError, missingJobId };
}
