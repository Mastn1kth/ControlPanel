import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import express from "express";

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const dataDir = path.join(rootDir, "data");
const logsDir = path.join(rootDir, "logs");
const projectsPath = path.join(dataDir, "projects.json");
const dbPath = path.join(dataDir, "panel.sqlite");
const distDir = path.join(rootDir, "dist");

const host = process.env.PANEL_HOST || "127.0.0.1";
const port = Number(process.env.PANEL_PORT || 8787);
const panelEmail = process.env.PANEL_EMAIL || "admin@gory-staff.local";
const panelPassword = process.env.PANEL_PASSWORD || "admin123";
const tokenSecret = process.env.PANEL_TOKEN_SECRET || "local-dev-secret-change-before-cloudflare";

const processes = new Map();
const db = new DatabaseSync(dbPath);

await fs.mkdir(logsDir, { recursive: true });

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS system_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    cpu_load REAL,
    memory_percent INTEGER,
    disk_percent INTEGER,
    uptime_seconds INTEGER
  );
  CREATE TABLE IF NOT EXISTS project_metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    project_id TEXT NOT NULL,
    state TEXT NOT NULL,
    health_score INTEGER,
    log_errors INTEGER,
    log_warnings INTEGER,
    open_ports INTEGER,
    total_ports INTEGER
  );
  CREATE TABLE IF NOT EXISTS action_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    user TEXT,
    project_id TEXT,
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    detail TEXT
  );
  CREATE TABLE IF NOT EXISTS web_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    project_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    session_id TEXT,
    visitor_id TEXT,
    path TEXT,
    title TEXT,
    referrer TEXT,
    origin TEXT,
    user_agent TEXT,
    ip_hash TEXT,
    language TEXT,
    screen TEXT,
    duration_ms INTEGER,
    load_ms INTEGER,
    metadata TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_system_metrics_ts ON system_metrics(ts);
  CREATE INDEX IF NOT EXISTS idx_project_metrics_project_ts ON project_metrics(project_id, ts);
  CREATE INDEX IF NOT EXISTS idx_action_log_ts ON action_log(ts);
  CREATE INDEX IF NOT EXISTS idx_web_events_project_ts ON web_events(project_id, ts);
  CREATE INDEX IF NOT EXISTS idx_web_events_project_type ON web_events(project_id, event_type);
`);

const app = express();
app.use(express.json({ limit: "256kb" }));

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", tokenSecret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

function verify(token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", tokenSecret).update(body).digest("base64url");
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

function auth(req, res, next) {
  const header = req.headers.authorization || "";
  const payload = verify(header.replace(/^Bearer\s+/i, ""));
  if (!payload) return res.status(401).json({ error: "unauthorized" });
  req.user = payload;
  next();
}

function recordAction({ user = null, projectId = null, action, result = "ok", detail = "" }) {
  db.prepare("INSERT INTO action_log (ts, user, project_id, action, result, detail) VALUES (?, ?, ?, ?, ?, ?)").run(
    new Date().toISOString(),
    user,
    projectId,
    action,
    result,
    String(detail || "").slice(0, 1000)
  );
}

async function loadProjects() {
  const raw = (await fs.readFile(projectsPath, "utf8")).replace(/^\uFEFF/, "");
  return JSON.parse(raw);
}

async function saveProjects(projects) {
  await fs.writeFile(projectsPath, `${JSON.stringify(projects, null, 2)}\n`, "utf8");
}

function slugify(value) {
  return String(value || "project")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || `project-${Date.now()}`;
}

function normalizeProjectInput(body) {
  const name = String(body.name || "").trim();
  const projectPath = String(body.path || "").trim();
  if (!name) throw new Error("Название проекта обязательно.");
  if (!projectPath) throw new Error("Путь проекта обязателен.");

  const ports = String(body.ports || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port < 65536);

  const project = {
    id: slugify(body.id || name),
    name,
    path: projectPath,
    group: String(body.group || "Other").trim() || "Other",
    kind: String(body.kind || "folder").trim() || "folder",
    description: String(body.description || "Добавлен вручную из панели.").trim(),
    url: String(body.url || "").trim(),
    ports,
    enabledActions: ["openPath"]
  };

  if (body.allowLogs) project.enabledActions.push("logs");

  if (body.startType === "npm") {
    const script = String(body.startScript || "").trim();
    if (!/^[\w:-]+$/.test(script)) throw new Error("Для npm нужен корректный script, например start, dev или server.");
    project.start = { type: "npm", script };
    project.stop = { type: "managed-process" };
    project.enabledActions.push("start", "stop", "restart", "logs");
  }

  if (body.startType === "docker-compose") {
    project.start = { type: "docker-compose", action: "up" };
    project.stop = { type: "docker-compose", action: "down" };
    project.enabledActions.push("start", "stop", "restart", "logs");
  }

  if (body.startType === "bat") {
    const file = path.basename(String(body.batFile || "").trim());
    if (!file || !file.toLowerCase().endsWith(".bat") || file.includes("..")) {
      throw new Error("Для bat нужен конкретный файл, например start.bat.");
    }
    project.start = { type: "bat", file };
    project.stop = { type: "managed-process" };
    project.enabledActions.push("start", "stop", "restart", "logs");
  }

  project.enabledActions = Array.from(new Set(project.enabledActions));
  return project;
}

function safeProject(project) {
  return {
    id: project.id,
    name: project.name,
    path: project.path,
    group: project.group,
    kind: project.kind,
    description: project.description,
    url: project.url,
    ports: project.ports || [],
    enabledActions: project.enabledActions || []
  };
}

async function portOpen(portNumber) {
  if (!portNumber) return false;
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: portNumber, timeout: 600 });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(false);
    });
    socket.once("error", () => resolve(false));
  });
}

async function projectStatus(project) {
  const managed = processes.get(project.id);
  const portStates = await Promise.all((project.ports || []).map(async (p) => ({ port: p, open: await portOpen(p) })));
  const anyPortOpen = portStates.some((p) => p.open);
  const running = Boolean(managed && !managed.exited) || anyPortOpen;
  return {
    id: project.id,
    state: running ? "running" : "stopped",
    pid: managed && !managed.exited ? managed.child.pid : null,
    startedAt: managed?.startedAt || null,
    ports: portStates,
    logPath: path.join(logsDir, `${project.id}.log`)
  };
}

async function systemStatus() {
  const disk = await new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-Command", "$d=Get-PSDrive C; Write-Output \"$($d.Free),$($d.Used)\""], {
      windowsHide: true
    });
    let out = "";
    child.stdout.on("data", (chunk) => (out += chunk));
    child.on("close", () => {
      const [free, used] = out.trim().split(",").map(Number);
      const total = free + used;
      resolve(Number.isFinite(total) && total > 0 ? { free, used, total, percent: Math.round((used / total) * 100) } : null);
    });
  });

  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  return {
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
    uptimeSeconds: Math.round(os.uptime()),
    memory: {
      total: totalMem,
      free: freeMem,
      used: totalMem - freeMem,
      percent: Math.round(((totalMem - freeMem) / totalMem) * 100)
    },
    cpu: {
      model: os.cpus()[0]?.model || "CPU",
      cores: os.cpus().length,
      load: os.loadavg()[0]
    },
    disk
  };
}

function commandSpec(project, action) {
  if (action === "start") return project.start;
  if (action === "stop") return project.stop;
  return null;
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonSafe(targetPath) {
  try {
    return JSON.parse(await fs.readFile(targetPath, "utf8"));
  } catch {
    return null;
  }
}

async function listProjectFiles(projectPath) {
  try {
    return await fs.readdir(projectPath, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function countEnvKeys(envPath) {
  try {
    const raw = await fs.readFile(envPath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("=")).length;
  } catch {
    return 0;
  }
}

async function logStats(projectId) {
  const targetPath = path.join(logsDir, `${projectId}.log`);
  try {
    const stat = await fs.stat(targetPath);
    const raw = await fs.readFile(targetPath, "utf8");
    const tail = raw.slice(-24000);
    const lines = tail.split(/\r?\n/).filter(Boolean);
    const errors = lines.filter((line) => /error|failed|exception|fatal|crash/i.test(line)).length;
    const warnings = lines.filter((line) => /warn|warning|deprecated/i.test(line)).length;
    return {
      exists: true,
      size: stat.size,
      lines: lines.length,
      errors,
      warnings,
      updatedAt: stat.mtime.toISOString()
    };
  } catch {
    return { exists: false, size: 0, lines: 0, errors: 0, warnings: 0, updatedAt: null };
  }
}

async function recentTopLevelChanges(projectPath) {
  const entries = await listProjectFiles(projectPath);
  const stats = await Promise.all(
    entries.slice(0, 80).map(async (entry) => {
      try {
        const stat = await fs.stat(path.join(projectPath, entry.name));
        return { name: entry.name, type: entry.isDirectory() ? "dir" : "file", updatedAt: stat.mtime.toISOString(), size: stat.size };
      } catch {
        return null;
      }
    })
  );
  return stats
    .filter(Boolean)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .slice(0, 8);
}

async function projectInsights(project) {
  const projectExists = await exists(project.path);
  const entries = projectExists ? await listProjectFiles(project.path) : [];
  const files = entries.filter((entry) => entry.isFile());
  const directories = entries.filter((entry) => entry.isDirectory());
  const packagePath = path.join(project.path, "package.json");
  const packageJson = await readJsonSafe(packagePath);
  const dockerCompose = (await exists(path.join(project.path, "docker-compose.yml"))) || (await exists(path.join(project.path, "compose.yml")));
  const envPath = path.join(project.path, ".env");
  const hasEnv = await exists(envPath);
  const batFiles = files.filter((entry) => entry.name.toLowerCase().endsWith(".bat")).map((entry) => entry.name);
  const status = await projectStatus(project);
  const logs = await logStats(project.id);
  const changes = projectExists ? await recentTopLevelChanges(project.path) : [];
  const scripts = packageJson?.scripts ? Object.keys(packageJson.scripts) : [];
  const dependencies = packageJson?.dependencies ? Object.keys(packageJson.dependencies).length : 0;
  const devDependencies = packageJson?.devDependencies ? Object.keys(packageJson.devDependencies).length : 0;
  const envKeys = hasEnv ? await countEnvKeys(envPath) : 0;
  const checks = [
    { label: "Папка проекта", ok: projectExists, detail: projectExists ? "найдена" : "не найдена" },
    { label: "package.json", ok: Boolean(packageJson), detail: packageJson ? `${scripts.length} scripts` : "нет" },
    { label: "Docker compose", ok: dockerCompose, detail: dockerCompose ? "есть" : "нет" },
    { label: ".env", ok: hasEnv, detail: hasEnv ? `${envKeys} ключей, значения скрыты` : "нет" },
    { label: "Логи панели", ok: logs.exists, detail: logs.exists ? `${logs.lines} строк` : "нет" },
    { label: "Разрешён запуск", ok: project.enabledActions?.includes("start"), detail: project.enabledActions?.includes("start") ? "да" : "нет" }
  ];
  const okCount = checks.filter((check) => check.ok).length;
  const healthScore = Math.round((okCount / checks.length) * 100);

  return {
    project: safeProject(project),
    status,
    summary: {
      healthScore,
      topLevelFiles: files.length,
      topLevelDirectories: directories.length,
      scripts: scripts.length,
      dependencies,
      devDependencies,
      envKeys,
      batFiles: batFiles.length,
      logErrors: logs.errors,
      logWarnings: logs.warnings
    },
    package: packageJson
      ? {
          name: packageJson.name || null,
          version: packageJson.version || null,
          private: Boolean(packageJson.private),
          workspaces: Array.isArray(packageJson.workspaces) ? packageJson.workspaces : [],
          scripts: scripts.slice(0, 14),
          dependencies,
          devDependencies
        }
      : null,
    infrastructure: {
      dockerCompose,
      hasEnv,
      envKeys,
      batFiles,
      ports: status.ports,
      url: project.url || null
    },
    checks,
    logs,
    changes
  };
}

async function appendLog(projectId, line) {
  await fs.appendFile(path.join(logsDir, `${projectId}.log`), line);
}

async function startProject(project) {
  if (!project.enabledActions?.includes("start")) {
    throw new Error("Для этого проекта запуск не разрешён в конфиге.");
  }
  if (processes.get(project.id) && !processes.get(project.id).exited) {
    return processes.get(project.id);
  }
  const spec = commandSpec(project, "start");
  const command = buildAllowedCommand(project, spec);

  await appendLog(project.id, `\n\n[panel] start ${new Date().toISOString()} ${command.label}\n`);
  const child = spawn(command.file, command.args, {
    cwd: project.path,
    shell: command.shell,
    windowsHide: true,
    env: { ...process.env, FORCE_COLOR: "0" }
  });

  const entry = { child, startedAt: new Date().toISOString(), exited: false };
  processes.set(project.id, entry);

  child.stdout.on("data", (chunk) => appendLog(project.id, chunk.toString()).catch(() => {}));
  child.stderr.on("data", (chunk) => appendLog(project.id, chunk.toString()).catch(() => {}));
  child.on("error", (error) => {
    entry.exited = true;
    appendLog(project.id, `\n[panel] spawn error ${new Date().toISOString()} ${error.message}\n`).catch(() => {});
  });
  child.on("exit", (code, signal) => {
    entry.exited = true;
    appendLog(project.id, `\n[panel] exit ${new Date().toISOString()} code=${code} signal=${signal}\n`).catch(() => {});
  });

  return entry;
}

function buildAllowedCommand(project, spec) {
  if (!spec?.type) throw new Error("Команда не настроена в projects.json.");
  if (spec.type === "npm") {
    if (!spec.script || !/^[\w:-]+$/.test(spec.script)) throw new Error("Некорректный npm script в конфиге.");
    return { file: "npm.cmd", args: ["run", spec.script], shell: false, label: `npm run ${spec.script}` };
  }
  if (spec.type === "docker-compose") {
    const action = spec.action === "down" ? "down" : "up";
    const args = action === "up" ? ["compose", "up", "-d"] : ["compose", "down"];
    return { file: "docker", args, shell: false, label: `docker ${args.join(" ")}` };
  }
  if (spec.type === "bat") {
    const file = path.basename(spec.file || "");
    if (!file || !file.toLowerCase().endsWith(".bat")) throw new Error("Некорректный bat-файл в конфиге.");
    if (file.includes("/") || file.includes("\\") || file.includes("..")) throw new Error("Bat-файл должен быть только именем файла.");
    return { file: "cmd.exe", args: ["/c", file], shell: false, label: file };
  }
  throw new Error(`Тип команды не поддержан: ${spec.type}`);
}

function stopProject(project) {
  const entry = processes.get(project.id);
  if (!entry || entry.exited) {
    const spec = commandSpec(project, "stop");
    if (spec?.type === "docker-compose") {
      const command = buildAllowedCommand(project, spec);
      const child = spawn(command.file, command.args, { cwd: project.path, shell: command.shell, windowsHide: true });
      child.on("error", (error) => appendLog(project.id, `\n[panel] stop error ${new Date().toISOString()} ${error.message}\n`).catch(() => {}));
      appendLog(project.id, `\n[panel] stop ${new Date().toISOString()} ${command.label}\n`).catch(() => {});
      return true;
    }
    return false;
  }
  spawn("taskkill", ["/PID", String(entry.child.pid), "/T", "/F"], { windowsHide: true });
  entry.exited = true;
  return true;
}

async function collectMetrics() {
  try {
    const ts = new Date().toISOString();
    const [sys, projects] = await Promise.all([systemStatus(), loadProjects()]);
    db.prepare("INSERT INTO system_metrics (ts, cpu_load, memory_percent, disk_percent, uptime_seconds) VALUES (?, ?, ?, ?, ?)").run(
      ts,
      sys.cpu.load,
      sys.memory.percent,
      sys.disk?.percent ?? null,
      sys.uptimeSeconds
    );

    for (const project of projects) {
      const insights = await projectInsights(project);
      const ports = insights.status.ports || [];
      db.prepare(`
        INSERT INTO project_metrics (ts, project_id, state, health_score, log_errors, log_warnings, open_ports, total_ports)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        ts,
        project.id,
        insights.status.state,
        insights.summary.healthScore,
        insights.summary.logErrors,
        insights.summary.logWarnings,
        ports.filter((p) => p.open).length,
        ports.length
      );
    }

    db.prepare("DELETE FROM system_metrics WHERE ts < datetime('now', '-14 days')").run();
    db.prepare("DELETE FROM project_metrics WHERE ts < datetime('now', '-14 days')").run();
    db.prepare("DELETE FROM action_log WHERE ts < datetime('now', '-30 days')").run();
  } catch (error) {
    recordAction({ action: "collect_metrics", result: "error", detail: error.message });
  }
}

function rows(sql, params = []) {
  return db.prepare(sql).all(...params);
}

function hashIp(value) {
  return crypto.createHash("sha256").update(`${value || ""}:${tokenSecret}`).digest("hex").slice(0, 24);
}

function clampString(value, max = 500) {
  return String(value || "").slice(0, max);
}

function trackerScript() {
  return `(() => {
  const script = document.currentScript;
  const project = script?.dataset.project || script?.getAttribute("data-project") || "";
  const endpoint = script?.dataset.endpoint || new URL("/api/collect", script?.src || location.href).toString();
  if (!project || window.__goryMetricLoaded) return;
  window.__goryMetricLoaded = true;
  const key = "gory_metric_visitor";
  const sidKey = "gory_metric_session";
  const now = Date.now();
  const visitor = localStorage.getItem(key) || crypto.randomUUID();
  localStorage.setItem(key, visitor);
  let session = JSON.parse(sessionStorage.getItem(sidKey) || "null");
  if (!session || now - session.t > 30 * 60 * 1000) session = { id: crypto.randomUUID(), t: now };
  session.t = now;
  sessionStorage.setItem(sidKey, JSON.stringify(session));
  const base = {
    projectId: project,
    visitorId: visitor,
    sessionId: session.id,
    path: location.pathname + location.search,
    title: document.title,
    referrer: document.referrer,
    origin: location.origin,
    language: navigator.language,
    screen: screen.width + "x" + screen.height
  };
  const send = (eventType, extra = {}) => {
    const body = JSON.stringify({ ...base, eventType, ...extra, ts: new Date().toISOString() });
    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
      return;
    }
    fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body, keepalive: true }).catch(() => {});
  };
  const perf = performance.getEntriesByType("navigation")[0];
  send("pageview", { loadMs: perf ? Math.round(perf.loadEventEnd) : null });
  document.addEventListener("click", (event) => {
    const target = event.target.closest("a,button,[data-metric]");
    if (!target) return;
    send("click", { metadata: { text: (target.innerText || target.ariaLabel || target.href || "").slice(0, 120), tag: target.tagName } });
  }, { passive: true });
  window.addEventListener("error", (event) => send("js_error", { metadata: { message: event.message, source: event.filename, line: event.lineno } }));
  const started = Date.now();
  window.addEventListener("pagehide", () => send("heartbeat", { durationMs: Date.now() - started }));
})();`;
}

app.options("/api/collect", (_req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.sendStatus(204);
});

app.get("/tracker.js", (_req, res) => {
  res.type("application/javascript").send(trackerScript());
});

app.post("/api/collect", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  try {
    const body = req.body || {};
    const projectId = clampString(body.projectId, 80);
    const eventType = clampString(body.eventType || "event", 40);
    if (!projectId) return res.status(400).json({ error: "projectId_required" });
    const projects = await loadProjects();
    if (!projects.some((project) => project.id === projectId)) {
      return res.status(404).json({ error: "project_not_found" });
    }
    db.prepare(`
      INSERT INTO web_events (
        ts, project_id, event_type, session_id, visitor_id, path, title, referrer,
        origin, user_agent, ip_hash, language, screen, duration_ms, load_ms, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      body.ts || new Date().toISOString(),
      projectId,
      eventType,
      clampString(body.sessionId, 120),
      clampString(body.visitorId, 120),
      clampString(body.path, 1000),
      clampString(body.title, 300),
      clampString(body.referrer, 1000),
      clampString(body.origin, 300),
      clampString(req.headers["user-agent"], 500),
      hashIp(req.ip || req.socket?.remoteAddress),
      clampString(body.language, 80),
      clampString(body.screen, 80),
      Number.isFinite(Number(body.durationMs)) ? Math.round(Number(body.durationMs)) : null,
      Number.isFinite(Number(body.loadMs)) ? Math.round(Number(body.loadMs)) : null,
      body.metadata ? JSON.stringify(body.metadata).slice(0, 2000) : null
    );
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/login", (req, res) => {
  const { email, password } = req.body || {};
  if (email !== panelEmail || password !== panelPassword) {
    recordAction({ user: email || null, action: "login", result: "error", detail: "bad_credentials" });
    return res.status(401).json({ error: "Неверная почта или пароль" });
  }
  recordAction({ user: email, action: "login", result: "ok" });
  res.json({
    token: sign({ email, exp: Date.now() + 1000 * 60 * 60 * 12 }),
    user: { email },
    insecureDefaults: !process.env.PANEL_PASSWORD || !process.env.PANEL_TOKEN_SECRET
  });
});

app.get("/api/me", auth, (req, res) => {
  res.json({ user: { email: req.user.email }, insecureDefaults: !process.env.PANEL_PASSWORD || !process.env.PANEL_TOKEN_SECRET });
});

app.get("/api/projects", auth, async (_req, res) => {
  const projects = await loadProjects();
  const statuses = await Promise.all(projects.map(projectStatus));
  const statusById = Object.fromEntries(statuses.map((s) => [s.id, s]));
  res.json({ projects: projects.map((p) => ({ ...safeProject(p), status: statusById[p.id] })) });
});

app.post("/api/projects", auth, async (req, res) => {
  try {
    const projects = await loadProjects();
    const project = normalizeProjectInput(req.body || {});
    if (projects.some((item) => item.id === project.id)) {
      project.id = `${project.id}-${Date.now().toString(36)}`;
    }
    if (!(await exists(project.path))) {
      return res.status(400).json({ error: "Папка проекта не найдена. Проверь путь." });
    }
    projects.push(project);
    await saveProjects(projects);
    recordAction({ user: req.user.email, projectId: project.id, action: "add_project", result: "ok", detail: project.path });
    res.status(201).json({ project: safeProject(project) });
  } catch (error) {
    recordAction({ user: req.user.email, action: "add_project", result: "error", detail: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/system", auth, async (_req, res) => {
  res.json(await systemStatus());
});

app.get("/api/metrics/overview", auth, async (_req, res) => {
  const system = rows("SELECT * FROM system_metrics ORDER BY ts DESC LIMIT 240").reverse();
  const actions = rows("SELECT * FROM action_log ORDER BY ts DESC LIMIT 30");
  const projects = rows(`
    SELECT
      project_id,
      COUNT(*) AS samples,
      SUM(CASE WHEN state = 'running' THEN 1 ELSE 0 END) AS running_samples,
      MAX(log_errors) AS max_errors,
      MAX(log_warnings) AS max_warnings,
      ROUND(AVG(health_score)) AS avg_health
    FROM project_metrics
    WHERE ts >= datetime('now', '-24 hours')
    GROUP BY project_id
    ORDER BY project_id
  `);
  res.json({ system, projects, actions });
});

app.get("/api/projects/:id/insights", auth, async (req, res) => {
  const project = (await loadProjects()).find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  res.json(await projectInsights(project));
});

app.get("/api/projects/:id/history", auth, async (req, res) => {
  const hours = Math.max(1, Math.min(336, Number(req.query.hours || 24)));
  const project = (await loadProjects()).find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  const history = rows(
    "SELECT * FROM project_metrics WHERE project_id = ? AND ts >= datetime('now', ?) ORDER BY ts ASC",
    [project.id, `-${hours} hours`]
  );
  const actions = rows(
    "SELECT * FROM action_log WHERE project_id = ? OR project_id IS NULL ORDER BY ts DESC LIMIT 50",
    [project.id]
  );
  res.json({ history, actions });
});

app.get("/api/projects/:id/web-analytics", auth, async (req, res) => {
  const hours = Math.max(1, Math.min(720, Number(req.query.hours || 24)));
  const project = (await loadProjects()).find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  const windowSql = `-${hours} hours`;
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS events,
      COUNT(DISTINCT visitor_id) AS visitors,
      COUNT(DISTINCT session_id) AS sessions,
      SUM(CASE WHEN event_type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
      SUM(CASE WHEN event_type = 'click' THEN 1 ELSE 0 END) AS clicks,
      SUM(CASE WHEN event_type = 'js_error' THEN 1 ELSE 0 END) AS js_errors,
      ROUND(AVG(CASE WHEN load_ms IS NOT NULL AND load_ms > 0 THEN load_ms ELSE NULL END)) AS avg_load_ms,
      ROUND(AVG(CASE WHEN duration_ms IS NOT NULL AND duration_ms > 0 THEN duration_ms ELSE NULL END)) AS avg_duration_ms
    FROM web_events
    WHERE project_id = ? AND ts >= datetime('now', ?)
  `).get(project.id, windowSql);
  const timeline = rows(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00Z', ts) AS bucket,
      COUNT(*) AS events,
      COUNT(DISTINCT visitor_id) AS visitors,
      SUM(CASE WHEN event_type = 'pageview' THEN 1 ELSE 0 END) AS pageviews,
      SUM(CASE WHEN event_type = 'js_error' THEN 1 ELSE 0 END) AS js_errors
    FROM web_events
    WHERE project_id = ? AND ts >= datetime('now', ?)
    GROUP BY bucket
    ORDER BY bucket ASC
  `, [project.id, windowSql]);
  const pages = rows(`
    SELECT path, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
    FROM web_events
    WHERE project_id = ? AND ts >= datetime('now', ?) AND event_type = 'pageview'
    GROUP BY path
    ORDER BY pageviews DESC
    LIMIT 10
  `, [project.id, windowSql]);
  const referrers = rows(`
    SELECT COALESCE(NULLIF(referrer, ''), 'direct') AS referrer, COUNT(*) AS visits
    FROM web_events
    WHERE project_id = ? AND ts >= datetime('now', ?) AND event_type = 'pageview'
    GROUP BY COALESCE(NULLIF(referrer, ''), 'direct')
    ORDER BY visits DESC
    LIMIT 10
  `, [project.id, windowSql]);
  const events = rows(`
    SELECT event_type, COUNT(*) AS count
    FROM web_events
    WHERE project_id = ? AND ts >= datetime('now', ?)
    GROUP BY event_type
    ORDER BY count DESC
  `, [project.id, windowSql]);
  const recent = rows(`
    SELECT ts, event_type, path, title, referrer, origin, language, screen, duration_ms, load_ms
    FROM web_events
    WHERE project_id = ?
    ORDER BY ts DESC
    LIMIT 30
  `, [project.id]);
  const endpointOrigin = `${req.protocol}://${req.get("host")}`;
  res.json({
    summary,
    timeline,
    pages,
    referrers,
    events,
    recent,
    snippet: `<script async src="${endpointOrigin}/tracker.js" data-project="${project.id}"></script>`
  });
});

app.get("/api/audit", auth, async (_req, res) => {
  res.json({ actions: rows("SELECT * FROM action_log ORDER BY ts DESC LIMIT 200") });
});

app.get("/api/security", auth, async (_req, res) => {
  res.json({
    defaultPassword: !process.env.PANEL_PASSWORD,
    defaultTokenSecret: !process.env.PANEL_TOKEN_SECRET,
    boundHost: host,
    cloudflareReady: Boolean(process.env.PANEL_PASSWORD && process.env.PANEL_TOKEN_SECRET && host === "127.0.0.1"),
    rules: [
      "Нет произвольного ввода команд из браузера.",
      "Запускаются только команды, явно прописанные в data/projects.json.",
      ".env значения не отдаются в интерфейс.",
      "Журнал действий хранится локально в SQLite."
    ]
  });
});

app.post("/api/projects/:id/start", auth, async (req, res) => {
  const project = (await loadProjects()).find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  try {
    await startProject(project);
    recordAction({ user: req.user.email, projectId: project.id, action: "start", result: "ok" });
    res.json({ ok: true, status: await projectStatus(project) });
  } catch (error) {
    recordAction({ user: req.user.email, projectId: project.id, action: "start", result: "error", detail: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/projects/:id/stop", auth, async (req, res) => {
  const project = (await loadProjects()).find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  stopProject(project);
  recordAction({ user: req.user.email, projectId: project.id, action: "stop", result: "ok" });
  res.json({ ok: true, status: await projectStatus(project) });
});

app.post("/api/projects/:id/restart", auth, async (req, res) => {
  const project = (await loadProjects()).find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  try {
    stopProject(project);
    setTimeout(() => startProject(project).catch(() => {}), 800);
    recordAction({ user: req.user.email, projectId: project.id, action: "restart", result: "ok" });
    res.json({ ok: true });
  } catch (error) {
    recordAction({ user: req.user.email, projectId: project.id, action: "restart", result: "error", detail: error.message });
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/projects/:id/logs", auth, async (req, res) => {
  const project = (await loadProjects()).find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  try {
    const log = await fs.readFile(path.join(logsDir, `${project.id}.log`), "utf8");
    res.type("text/plain").send(log.slice(-12000));
  } catch {
    res.type("text/plain").send("Логов пока нет.");
  }
});

app.post("/api/projects/:id/open-path", auth, async (req, res) => {
  const project = (await loadProjects()).find((p) => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "project_not_found" });
  spawn("explorer.exe", [project.path], { windowsHide: true, detached: true });
  recordAction({ user: req.user.email, projectId: project.id, action: "open_path", result: "ok" });
  res.json({ ok: true });
});

app.use(express.static(distDir));
app.use(async (_req, res, next) => {
  try {
    await fs.access(path.join(distDir, "index.html"));
    res.sendFile(path.join(distDir, "index.html"));
  } catch {
    next();
  }
});

await collectMetrics();
setInterval(() => {
  collectMetrics();
}, 60_000);

app.listen(port, host, () => {
  console.log(`ControlPanel API: http://${host}:${port}`);
  if (!process.env.PANEL_PASSWORD || !process.env.PANEL_TOKEN_SECRET) {
    console.log("WARNING: using local default credentials. Change .env before Cloudflare Tunnel.");
  }
});
