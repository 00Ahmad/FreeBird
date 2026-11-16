/**
 * How a project is opened for Visual QA, worked out from its planned files alone: plain code, no file system and no
 * child process (the caller hands in a reader). Conservative: it only picks a way to run what it recognises.
 */

/** A page FreeBird serves itself (HTML, CSS, JS): nothing runs on this computer. */
export interface PageRun {
  kind: "page";
  /** The planned page opened first. */
  entry: string;
}

/** An app that runs a server and shows a web page (Flask, Streamlit, FastAPI, Django, Node, Vite…). */
export interface ServerRun {
  kind: "server";
  /** The command that starts it, run in the project folder. */
  command: string;
  /** What installs what it needs first, when the project says (requirements.txt, package.json), else null. */
  install: string | null;
  /** The planned file that starts it: where a crash with no clearer place is sent back to. */
  main: string;
  /** The port it usually listens on, if known; the address it prints wins. */
  port: number | null;
  /** What it was recognised as, for the activity list. */
  framework: string;
}

/** An app with its own window (Tkinter, PyQt, Electron…): checked only for starting and staying open. */
export interface DesktopRun {
  kind: "desktop";
  command: string;
  install: string | null;
  main: string;
  framework: string;
}

export type RunSpec = PageRun | ServerRun | DesktopRun | { kind: "none" };

export interface RunInput {
  /** The planned files, relative to the output folder with forward slashes. */
  files: string[];
  /** A planned file's text, or null when it isn't there. */
  read(path: string): string | null;
  /** The command for Python on this computer ("python" on Windows, "python3" elsewhere). */
  python?: string;
}

const extensionOf = (path: string) => /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? "";
const nameOf = (path: string) => (path.split("/").at(-1) ?? "").toLowerCase();
const depth = (path: string) => path.split("/").length;
/** Quoted for PowerShell and sh alike when it has a space in it. */
const arg = (path: string) => (/[\s'"]/.test(path) ? `"${path.replaceAll('"', "")}"` : path);
/** A Python file as a module name: src/app.py is src.app. */
const moduleOf = (path: string) => path.replace(/\.py$/i, "").replaceAll("/", ".");

/** The first port number a file names for its server (port=8080, listen(3000), PORT || 4000, --port 5173). */
export function portIn(text: string): number | null {
  const match =
    /(?:\bport\s*[=:]\s*|\.listen\(\s*|\bPORT\s*(?:\|\||\?\?|or)\s*|--port[ =]|\s-p\s+)["']?(\d{2,5})\b/i.exec(
      text,
    );
  const port = match ? Number(match[1]) : NaN;
  return port >= 80 && port <= 65535 ? port : null;
}

/** Entry files first: one that runs as a program, then the usual names, then the shallowest. */
function byEntry(files: string[], read: (path: string) => string | null): string[] {
  const usual = [
    "main.py",
    "app.py",
    "run.py",
    "server.py",
    "manage.py",
    "index.js",
    "server.js",
    "app.js",
    "main.js",
  ];
  const score = (path: string) => {
    const text = read(path) ?? "";
    const runs = /if\s+__name__\s*==\s*["']__main__["']/.test(text) ? 0 : 1;
    const named = usual.indexOf(nameOf(path));
    return runs * 100 + (named < 0 ? 50 : named) + depth(path);
  };
  return files.toSorted((a, b) => score(a) - score(b));
}

const DESKTOP_PYTHON =
  /^\s*(?:import|from)\s+(tkinter|customtkinter|PyQt5|PyQt6|PySide2|PySide6|wx|kivy|pygame|flet)\b/m;

function pythonRun(files: string[], read: RunInput["read"], python: string): RunSpec | null {
  const scripts = files.filter((path) => extensionOf(path) === "py");
  if (scripts.length === 0) return null;
  const requirements = files.find((path) => nameOf(path) === "requirements.txt" && depth(path) === 1);
  const install = requirements ? `${python} -m pip install -r ${arg(requirements)}` : null;
  const ordered = byEntry(scripts, read);
  const textOf = (path: string) => read(path) ?? "";

  const manage = scripts.find((path) => nameOf(path) === "manage.py");
  if (manage && /django/i.test(textOf(manage)))
    return {
      kind: "server",
      command: `${python} ${arg(manage)} runserver 127.0.0.1:8000 --noreload`,
      install,
      main: manage,
      port: 8000,
      framework: "Django",
    };
  for (const path of ordered) {
    const text = textOf(path);
    if (/^\s*import\s+streamlit\b|^\s*from\s+streamlit\b/m.test(text))
      return {
        kind: "server",
        command: `${python} -m streamlit run ${arg(path)} --server.headless true`,
        install,
        main: path,
        port: 8501,
        framework: "Streamlit",
      };
    if (/^\s*import\s+gradio\b|^\s*from\s+gradio\b/m.test(text))
      return {
        kind: "server",
        command: `${python} ${arg(path)}`,
        install,
        main: path,
        port: portIn(text) ?? 7860,
        framework: "Gradio",
      };
  }
  for (const path of ordered) {
    const text = textOf(path);
    const flask = /\bFlask\s*\(/.exec(text);
    if (flask) {
      const runs = /\.run\s*\(/.test(text) && /__main__/.test(text);
      return {
        kind: "server",
        command: runs
          ? `${python} ${arg(path)}`
          : `${python} -m flask --app ${moduleOf(path)} run --port ${portIn(text) ?? 5000}`,
        install,
        main: path,
        port: portIn(text) ?? 5000,
        framework: "Flask",
      };
    }
    const fastapi = /^(\w+)\s*=\s*FastAPI\s*\(/m.exec(text);
    if (fastapi) {
      const runs = /uvicorn\.run\s*\(/.test(text) && /__main__/.test(text);
      const port = portIn(text) ?? 8000;
      return {
        kind: "server",
        command: runs
          ? `${python} ${arg(path)}`
          : `${python} -m uvicorn ${moduleOf(path)}:${fastapi[1]} --port ${port}`,
        install,
        main: path,
        port,
        framework: "FastAPI",
      };
    }
  }
  for (const path of ordered) {
    const found = DESKTOP_PYTHON.exec(textOf(path));
    if (found)
      return {
        kind: "desktop",
        command: `${python} ${arg(path)}`,
        install,
        main: path,
        framework: found[1]!,
      };
  }
  return null;
}

interface PackageJson {
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const parseJson = (text: string | null): PackageJson | null => {
  if (!text) return null;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as PackageJson) : null;
  } catch {
    return null;
  }
};

const NODE_SERVER = /\bexpress\s*\(|\bcreateServer\s*\(|\bfastify\s*\(|\bnew\s+Koa\s*\(|\.listen\s*\(/;

function nodeRun(files: string[], read: RunInput["read"]): RunSpec | null {
  const manifest = files.find((path) => path === "package.json");
  const pkg = parseJson(manifest ? read(manifest) : null);
  const scripts = files.filter((path) => ["js", "mjs", "cjs", "ts"].includes(extensionOf(path)));
  if (pkg && manifest) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    const has = (name: string) => name in deps;
    const main = (pkg.main && files.find((path) => path === pkg.main?.replace(/^\.\//, ""))) || manifest;
    if (has("electron") && pkg.scripts?.start)
      return { kind: "desktop", command: "npm start", install: "npm install", main, framework: "Electron" };
    const dev = pkg.scripts?.dev;
    const start = pkg.scripts?.start;
    const script = dev ? "dev" : start ? "start" : null;
    if (script) {
      const line = (dev ?? start)!;
      const framework = has("next")
        ? "Next.js"
        : has("vite") || /\bvite\b/.test(line)
          ? "Vite"
          : has("react-scripts")
            ? "Create React App"
            : has("express")
              ? "Express"
              : "Node";
      const usual = framework === "Vite" ? 5173 : 3000;
      const server = scripts.find((path) => NODE_SERVER.test(read(path) ?? ""));
      return {
        kind: "server",
        command: script === "dev" ? "npm run dev" : "npm start",
        install: "npm install",
        main: server ?? main,
        port: portIn(line) ?? (server ? portIn(read(server) ?? "") : null) ?? usual,
        framework,
      };
    }
  }
  for (const path of byEntry(scripts, read)) {
    if (extensionOf(path) === "ts") continue;
    const text = read(path) ?? "";
    if (NODE_SERVER.test(text) && /\brequire\(|\bimport\b/.test(text))
      return {
        kind: "server",
        command: `node ${arg(path)}`,
        install: pkg ? "npm install" : null,
        main: path,
        port: portIn(text),
        framework: "Node",
      };
  }
  return null;
}

/** How to open the project for Visual QA, or kind "none" when it has no UI this can open. */
export function detectRun(input: RunInput): RunSpec {
  const python = input.python ?? "python";
  const files = input.files.map((path) => path.replaceAll("\\", "/").replace(/^\.\//, ""));
  const found = pythonRun(files, input.read, python) ?? nodeRun(files, input.read);
  if (found) return found;
  const pages = files.filter((path) => ["html", "htm"].includes(extensionOf(path)));
  if (pages.length > 0) {
    const entry =
      pages.filter((path) => nameOf(path) === "index.html").toSorted((a, b) => depth(a) - depth(b))[0] ??
      pages.toSorted((a, b) => depth(a) - depth(b))[0]!;
    return { kind: "page", entry };
  }
  return { kind: "none" };
}

/** The run as one line for the activity list and QA's message. */
export function describeRun(run: RunSpec): string {
  if (run.kind === "page") return `a web page, opened at ${run.entry} (FreeBird serves the folder itself)`;
  if (run.kind === "server")
    return `a ${run.framework} app, started with \`${run.command}\`${run.port ? ` (usually on port ${run.port})` : ""}`;
  if (run.kind === "desktop") return `a ${run.framework} desktop app, started with \`${run.command}\``;
  return "nothing with a screen to open";
}
