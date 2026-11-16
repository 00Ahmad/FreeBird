import { describe, expect, it } from "vitest";

import { describeRun, detectRun, portIn } from "./index";

const project = (files: Record<string, string>) => ({
  files: Object.keys(files),
  read: (path: string) => files[path] ?? null,
});

describe("how a project is opened for Visual QA", () => {
  it("serves plain web pages itself, opening the shallowest index.html", () => {
    expect(
      detectRun(project({ "about.html": "", "site/index.html": "", "index.html": "", "app.js": "" })),
    ).toEqual({
      kind: "page",
      entry: "index.html",
    });
    expect(detectRun(project({ "pages/home.html": "", "style.css": "" }))).toEqual({
      kind: "page",
      entry: "pages/home.html",
    });
  });

  it("starts a Flask app the way its file says, installing requirements first", () => {
    const run = detectRun(
      project({
        "app.py":
          'from flask import Flask\napp = Flask(__name__)\nif __name__ == "__main__":\n    app.run(port=5050)',
        "templates/index.html": "<html></html>",
        "requirements.txt": "flask",
      }),
    );
    expect(run).toMatchObject({
      kind: "server",
      command: "python app.py",
      install: "python -m pip install -r requirements.txt",
      main: "app.py",
      port: 5050,
      framework: "Flask",
    });
  });

  it("uses flask run when the file doesn't run itself", () => {
    const run = detectRun(project({ "web/server.py": "from flask import Flask\napp = Flask(__name__)" }));
    expect(run).toMatchObject({
      kind: "server",
      command: "python -m flask --app web.server run --port 5000",
    });
  });

  it("knows Streamlit, FastAPI and Django", () => {
    expect(detectRun(project({ "dash.py": "import streamlit as st\nst.title('x')" }))).toMatchObject({
      command: "python -m streamlit run dash.py --server.headless true",
      port: 8501,
    });
    expect(detectRun(project({ "api.py": "from fastapi import FastAPI\nserver = FastAPI()" }))).toMatchObject(
      {
        command: "python -m uvicorn api:server --port 8000",
        framework: "FastAPI",
      },
    );
    expect(
      detectRun(
        project({ "manage.py": "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'x')\nimport django" }),
      ),
    ).toMatchObject({ framework: "Django", port: 8000 });
  });

  it("checks a desktop app only for starting", () => {
    const run = detectRun(
      project({
        "ui.py": "import tkinter as tk",
        "main.py": 'from ui import App\nif __name__ == "__main__":\n    App()',
        "widgets.py": "from tkinter import ttk",
      }),
    );
    expect(run).toMatchObject({ kind: "desktop", framework: "tkinter" });
    expect(detectRun(project({ "w.py": "from PySide6.QtWidgets import QApplication" }))).toMatchObject({
      kind: "desktop",
      command: "python w.py",
    });
  });

  it("runs a Node project's dev script, with the port the script or server names", () => {
    const vite = detectRun(
      project({
        "package.json": JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "5" } }),
        "index.html": "",
        "src/main.js": "",
      }),
    );
    expect(vite).toMatchObject({
      kind: "server",
      command: "npm run dev",
      install: "npm install",
      port: 5173,
    });
    const express = detectRun(
      project({
        "package.json": JSON.stringify({
          scripts: { start: "node server.js" },
          dependencies: { express: "4" },
        }),
        "server.js":
          "const express = require('express');\nconst app = express();\napp.listen(process.env.PORT || 4000);",
        "public/index.html": "",
      }),
    );
    expect(express).toMatchObject({
      command: "npm start",
      main: "server.js",
      port: 4000,
      framework: "Express",
    });
    expect(
      detectRun(
        project({ "server.js": "const http = require('node:http');\nhttp.createServer(f).listen(8080);" }),
      ),
    ).toMatchObject({ command: "node server.js", install: null, port: 8080 });
  });

  it("says when there is nothing with a screen", () => {
    expect(detectRun(project({ "lib.py": "def add(a, b): return a + b", "README.md": "" }))).toEqual({
      kind: "none",
    });
    expect(describeRun({ kind: "none" })).toBe("nothing with a screen to open");
  });

  it("reads a port only where it is clearly one", () => {
    expect(portIn("app.run(debug=True, port=8080)")).toBe(8080);
    expect(portIn("server.listen(3000, () => {})")).toBe(3000);
    expect(portIn("const PORT = process.env.PORT ?? 4321")).toBe(4321);
    expect(portIn("vite --port 6000")).toBe(6000);
    expect(portIn("timeout = 30")).toBeNull();
  });
});
