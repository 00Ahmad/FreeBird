import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, relative, resolve, sep } from "node:path";

/** A folder served on this computer only, for Visual QA to open a project's pages in the browser. */
export interface ServedFolder {
  /** http://127.0.0.1:<port> */
  origin: string;
  close(): Promise<void>;
}

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".cjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".wasm": "application/wasm",
  ".pdf": "application/pdf",
};

/**
 * The file a request asks for inside `root`, or null when it may not be served: outside the folder (../, an encoded
 * slash, a drive letter), a hidden name (.env, .git), or a file `refuse` turns down (one that may hold secrets).
 * "/" and a folder mean its index.html.
 */
export function servedPath(
  root: string,
  urlPath: string,
  refuse: (rel: string) => string | null,
): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split("?")[0]!.split("#")[0]!);
  } catch {
    return null;
  }
  if (decoded.includes("\0") || decoded.includes("\\")) return null;
  const parts = decoded.split("/").filter(Boolean);
  if (parts.some((part) => part === ".." || part.startsWith(".") || /^[a-z]:$/i.test(part))) return null;
  const base = resolve(root);
  let abs = resolve(base, ...parts);
  if (abs !== base && !abs.startsWith(base + sep)) return null;
  try {
    if (statSync(abs).isDirectory()) abs = join(abs, "index.html");
  } catch {
    // Not there: answered with a 404 by the caller.
  }
  const rel = relative(base, abs).split(sep).join("/");
  if (!rel || rel.startsWith("..") || refuse(rel)) return null;
  return abs;
}

/**
 * Serves `root` read-only on 127.0.0.1 at a free port: only GET and HEAD, no folder listings, nothing outside it and
 * nothing `refuse` names. Nothing on the network can reach it.
 */
export function serveFolder(root: string, refuse: (rel: string) => string | null): Promise<ServedFolder> {
  const server = createServer((request, response) => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405).end();
      return;
    }
    const abs = servedPath(root, request.url ?? "/", refuse);
    let size = -1;
    try {
      if (abs && statSync(abs).isFile()) size = statSync(abs).size;
    } catch {
      size = -1;
    }
    if (!abs || size < 0) {
      response.writeHead(404, { "content-type": "text/plain; charset=utf-8" }).end("Not found");
      return;
    }
    response.writeHead(200, {
      "content-type": TYPES[extname(abs).toLowerCase()] ?? "application/octet-stream",
      "content-length": size,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    if (request.method === "HEAD") return void response.end();
    createReadStream(abs)
      .on("error", () => response.destroy())
      .pipe(response);
  });
  return new Promise((done, failed) => {
    server.once("error", failed);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      done({
        origin: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections();
            server.close(() => closed());
          }),
      });
    });
  });
}
