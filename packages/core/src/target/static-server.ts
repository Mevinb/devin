import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import sirv from "sirv";
import type { TargetResolution } from "./types.js";

export function findServeDirectory(targetPath: string): string {
  const resolved = path.resolve(process.cwd(), targetPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Target directory does not exist: ${resolved}`);
  }

  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    // If it points directly to an html file
    return path.dirname(resolved);
  }

  // Check common static output folders
  const candidates = [
    resolved,
    path.join(resolved, "dist"),
    path.join(resolved, "build"),
    path.join(resolved, "out"),
    path.join(resolved, "public")
  ];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) {
      return dir;
    }
  }

  return resolved;
}

export async function startStaticServer(targetDir: string): Promise<TargetResolution> {
  const resolved = path.resolve(process.cwd(), targetDir);
  const isFile = fs.existsSync(resolved) && !fs.statSync(resolved).isDirectory();
  const serveDir = findServeDirectory(targetDir);
  const fileName = isFile ? path.basename(resolved) : "";

  const handler = sirv(serveDir, {
    dev: true,
    single: !isFile,
    dotfiles: false
  });

  const server = http.createServer((req, res) => {
    handler(req, res);
  });

  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to get server port"));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/${fileName}`;
      resolve({
        url,
        isLocal: true,
        cleanup: async () => {
          await new Promise<void>((res) => {
            server.close(() => res());
          });
        }
      });
    });


    server.on("error", (err) => {
      reject(err);
    });
  });
}
