import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { defaultAdbClient, runDevicesDoctor } from "@pixelsentinel/android";
import { DeviceRegistry, ExploreConfigSchema, globalDeviceRegistry, resolveScanConfig, type ScanConfigInput } from "@pixelsentinel/core";
import { ScanJobManager } from "./jobs.js";
export * from "./jobs.js";

export function createServer(options: { outputDir?: string; logger?: boolean; webDistPath?: string } = {}) {
  const server = Fastify({ logger: options.logger ?? true });
  server.register(cors, { origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    try { callback(null, ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname)); }
    catch { callback(null, false); }
  } });
  const outputDir = path.resolve(options.outputDir ?? "./pixelsentinel-output");
  fs.mkdirSync(outputDir, { recursive: true });
  const manager = new ScanJobManager(outputDir);
  server.addHook("onClose", async () => { await manager.close(); });
  server.register(fastifyStatic, { root: outputDir, prefix: "/artifacts/", decorateReply: false });
  const webDistPath = options.webDistPath ?? fileURLToPath(new URL("../../web/dist", import.meta.url));
  if (fs.existsSync(webDistPath)) server.register(fastifyStatic, { root: webDistPath, prefix: "/", decorateReply: false });

  server.get("/api/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));
  server.get("/api/devices/doctor", async () => runDevicesDoctor());
  server.get("/api/devices", async () => ({
    devices: globalDeviceRegistry.listBuiltins(), adbDevices: await defaultAdbClient.listDevices(),
    sessions: manager.list().filter((job) => job.status === "running").flatMap((job) => Object.values(job.fleet))
  }));
  server.get("/api/scans", async () => manager.list());
  server.get("/api/scans/:id", async (req, reply) => {
    const job = manager.get((req.params as { id: string }).id);
    return job ?? reply.code(404).send({ error: "Scan job not found" });
  });
  server.get("/api/scans/:id/report", async (req, reply) => {
    const job = manager.get((req.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: "Scan job not found" });
    return job.report ?? reply.code(409).send({ error: "Scan has no completed report", status: job.status });
  });
  server.get("/api/scans/:id/fixes", async (req, reply) => {
    const job = manager.get((req.params as { id: string }).id);
    return job ? job.report?.fixes ?? [] : reply.code(404).send({ error: "Scan job not found" });
  });
  server.get("/api/fixes", async (req, reply) => {
    const { scanId } = req.query as { scanId?: string };
    const job = scanId ? manager.get(scanId) : manager.list().find((item) => item.report);
    if (scanId && !job) return reply.code(404).send({ error: "Scan job not found" });
    return job?.report?.fixes ?? [];
  });

  server.get("/api/scans/:id/events", async (req, reply) => {
    const job = manager.get((req.params as { id: string }).id);
    if (!job) return reply.code(404).send({ error: "Scan job not found" });
    const lastId = req.headers["last-event-id"] ? Number(req.headers["last-event-id"]) : 0;
    if (!Number.isSafeInteger(lastId) || lastId < 0) return reply.code(400).send({ error: "Invalid Last-Event-ID" });
    reply.hijack();
    reply.raw.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "connection": "keep-alive", "x-accel-buffering": "no" });
    reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(job)}\n\n`);
    for (const event of job.events.filter((e) => e.id > lastId)) {
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    }
    if (job.status === "completed" || job.status === "failed") { reply.raw.end(); return; }
    const unsubscribe = manager.subscribe(job.id, (event) => {
      reply.raw.write(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      if (event.type === "status" && (job.status === "completed" || job.status === "failed")) reply.raw.end();
    });
    const heartbeat = setInterval(() => { reply.raw.write(": heartbeat\n\n"); }, 15000);
    heartbeat.unref();
    reply.raw.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
  });

  server.post("/api/scans", async (req, reply) => {
    const body = req.body as Record<string, unknown> | null;
    if (!body || Array.isArray(body) || typeof body.target !== "string" || !body.target.trim()) {
      return reply.code(400).send({ error: "Target URL or path is required" });
    }
    if (body.explore !== undefined && typeof body.explore !== "boolean" && (typeof body.explore !== "object" || body.explore === null)) {
      return reply.code(400).send({ error: "explore must be a boolean or an exploration configuration" });
    }
    if (body.proposeFixes !== undefined && typeof body.proposeFixes !== "boolean") return reply.code(400).send({ error: "proposeFixes must be a boolean" });
    const exploreConfig = ExploreConfigSchema.safeParse(body.exploreConfig ?? (typeof body.explore === "object" ? body.explore : {}));
    if (!exploreConfig.success) return reply.code(400).send({ error: "Invalid exploration configuration", details: exploreConfig.error.issues });
    if (body.proposeFixes && /^https?:\/\//i.test(body.target)) return reply.code(400).send({ error: "Fix proposals require a local source project" });
    try {
      const config = await resolveScanConfig({ ...body, target: body.target.trim() } as Partial<ScanConfigInput>);
      const registry = new DeviceRegistry();
      for (const device of config.devices ?? []) registry.resolveTarget(device);
      const job = manager.enqueue(config, {
        ...(body.explore ? { explore: exploreConfig.data } : {}), proposeFixes: body.proposeFixes === true
      });
      return reply.code(202).send({ jobId: job.id, status: "queued", artifactBaseUrl: job.artifactBaseUrl });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
  return server;
}

export async function startServer(port = 3000, openBrowser = false): Promise<void> {
  const server = createServer();
  const url = await server.listen({ port, host: "127.0.0.1" });
  console.log(`\nPixelSentinel Dashboard running at: ${url}\n`);
  if (openBrowser) await (await import("open")).default(url).catch(() => {});
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  (await import("dotenv")).config();
  startServer(Number(process.env.PORT ?? "3000")).catch((err) => { console.error(err); process.exitCode = 1; });
}
