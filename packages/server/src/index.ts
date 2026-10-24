import fs from "node:fs";
import path from "node:path";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify from "fastify";
import { scan, type ScanConfigInput, type ScanReport } from "@pixelsentinel/core";

export interface ScanJob {
  id: string;
  target: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: {
    step: string;
    completed: number;
    total: number;
    detail?: string;
  };
  report?: ScanReport;
  error?: string;
  createdAt: string;
}

const jobs = new Map<string, ScanJob>();

export function createServer(options: { outputDir?: string } = {}) {
  const server = Fastify({
    logger: true
  });

  server.register(cors, {
    origin: true
  });

  const outputDir = path.resolve(process.cwd(), options.outputDir || "./pixelsentinel-output");
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Serve generated artifacts (screenshots, reports)
  server.register(fastifyStatic, {
    root: outputDir,
    prefix: "/artifacts/",
    decorateReply: false
  });

  // Serve built web dashboard if available
  const webDistPath = path.resolve(process.cwd(), "packages/web/dist");
  if (fs.existsSync(webDistPath)) {
    server.register(fastifyStatic, {
      root: webDistPath,
      prefix: "/",
      decorateReply: false
    });
  }

  // API Endpoints
  server.get("/api/health", async () => {
    return { status: "ok", timestamp: new Date().toISOString() };
  });

  server.get("/api/scans", async () => {
    return Array.from(jobs.values()).sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    );
  });

  server.get("/api/scans/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job) {
      reply.status(404).send({ error: "Scan job not found" });
      return;
    }
    return job;
  });

  server.get("/api/scans/:id/report", async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = jobs.get(id);
    if (!job) {
      reply.status(404).send({ error: "Scan job not found" });
      return;
    }
    if (!job.report) {
      reply.status(400).send({ error: "Scan not yet completed" });
      return;
    }
    return job.report;
  });

  server.post("/api/scans", async (req, reply) => {
    const body = req.body as Partial<ScanConfigInput>;
    if (!body || !body.target) {
      reply.status(400).send({ error: "Target URL or path is required" });
      return;
    }

    const jobId = `job-${Date.now()}`;
    const job: ScanJob = {
      id: jobId,
      target: body.target,
      status: "queued",
      progress: {
        step: "queued",
        completed: 0,
        total: 1,
        detail: "Queued for execution"
      },
      createdAt: new Date().toISOString()
    };

    jobs.set(jobId, job);

    // Launch scan in background
    (async () => {
      try {
        job.status = "running";
        const scanReport = await scan(
          {
            ...body,
            output: {
              ...(body.output || {}),
              dir: outputDir
            }
          },
          {
            onProgress: (step, completed, total, detail) => {
              job.progress = { step, completed, total, detail };
            }
          }
        );

        job.status = "completed";
        job.report = scanReport;
        job.progress = {
          step: "completed",
          completed: scanReport.summary.totalViewports,
          total: scanReport.summary.totalViewports,
          detail: "Scan completed"
        };
      } catch (err: unknown) {
        job.status = "failed";
        job.error = err instanceof Error ? err.message : String(err);
      }
    })();

    reply.status(202).send({ jobId, status: "queued" });
  });

  return server;
}

export async function startServer(port: number = 3000, openBrowser: boolean = false): Promise<void> {
  const server = createServer();
  try {
    await server.listen({ port, host: "0.0.0.0" });
    const url = `http://localhost:${port}`;
    console.log(`\n🚀 PixelSentinel Dashboard running at: ${url}\n`);

    if (openBrowser) {
      const open = (await import("open")).default;
      await open(url).catch(() => {});
    }
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

// Direct execution support
if (process.argv[1] && process.argv[1].endsWith("index.js")) {
  const port = parseInt(process.env.PORT || "3000", 10);
  startServer(port);
}
