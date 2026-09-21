import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Clock3,
  Cpu,
  Copy,
  Database,
  ExternalLink,
  FileCode2,
  FolderOpen,
  Gauge,
  HardDrive,
  History,
  LayoutDashboard,
  LineChart,
  Lock,
  MemoryStick,
  Package,
  Play,
  Plus,
  RefreshCcw,
  RotateCcw,
  Search,
  Signal,
  Server,
  ShieldCheck,
  Square,
  Terminal,
  X
} from "lucide-react";
import "./styles.css";

const API = "http://127.0.0.1:8787/api";
const ALL_GROUPS = "Все";

function fmtBytes(value) {
  if (!value && value !== 0) return "-";
  const gb = value / 1024 / 1024 / 1024;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function fmtUptime(seconds) {
  if (!seconds) return "-";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${d}д ${h}ч ${m}м`;
}

function fmtDate(value) {
  if (!value) return "-";
  return new Intl.DateTimeFormat("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(value));
}

function request(token, url, options = {}) {
  return fetch(`${API}${url}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers || {})
    }
  }).then(async (response) => {
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error || `Ошибка ${response.status}`);
    }
    const contentType = response.headers.get("content-type") || "";
    return contentType.includes("application/json") ? response.json() : response.text();
  });
}

function Login({ onLogin }) {
  const [email, setEmail] = useState("admin@gory-staff.local");
  const [password, setPassword] = useState("admin123");
  const [error, setError] = useState("");

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      const response = await fetch(`${API}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "Ошибка входа");
      localStorage.setItem("panel_token", body.token);
      onLogin(body.token, body);
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <main className="login-shell">
      <form className="login-panel" onSubmit={submit}>
        <div className="login-mark">
          <Lock size={22} />
        </div>
        <h1>Gory Control Panel</h1>
        <p>Пункт управления проектами на этом ПК.</p>
        <label>
          Почта
          <input value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
        </label>
        <label>
          Пароль
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
        </label>
        {error ? <div className="error">{error}</div> : null}
        <button className="primary" type="submit">Войти</button>
        <small>Перед Cloudflare обязательно поменяй пароль и секрет в .env.</small>
      </form>
    </main>
  );
}

function StatusBadge({ state }) {
  return <span className={`badge ${state}`}>{state === "running" ? "Работает" : "Остановлен"}</span>;
}

function ActionButton({ title, icon: Icon, onClick, disabled, danger }) {
  return (
    <button className={`icon-button ${danger ? "danger" : ""}`} title={title} onClick={onClick} disabled={disabled}>
      <Icon size={16} />
    </button>
  );
}

function Kpi({ icon: Icon, label, value, tone = "blue", hint }) {
  return (
    <div className={`kpi ${tone}`}>
      <div className="kpi-icon"><Icon size={18} /></div>
      <span>{label}</span>
      <strong>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

function MiniBar({ value }) {
  const safeValue = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="mini-bar">
      <span style={{ width: `${safeValue}%` }} />
    </div>
  );
}

function Sparkline({ rows, field, color = "#2563eb", height = 92 }) {
  const values = (rows || []).map((row) => Number(row[field] ?? 0));
  if (!values.length) {
    return <div className="empty-chart">История появится после нескольких снимков метрик.</div>;
  }
  const max = Math.max(1, ...values);
  const width = 520;
  const points = values.map((value, index) => {
    const x = values.length === 1 ? 0 : (index / (values.length - 1)) * width;
    const y = height - (value / max) * (height - 10) - 5;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const singleY = height - (values[0] / max) * (height - 10) - 5;
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={field}>
      {values.length === 1 ? (
        <circle cx={width / 2} cy={singleY} r="5" fill={color} />
      ) : (
        <polyline points={points} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      )}
      <line x1="0" y1={height - 5} x2={width} y2={height - 5} stroke="#e2e8f0" />
    </svg>
  );
}

function UptimeBars({ rows }) {
  const items = (rows || []).slice(-80);
  if (!items.length) return <div className="empty-chart">Нет данных uptime.</div>;
  return (
    <div className="uptime-bars">
      {items.map((row) => (
        <span key={row.id} className={row.state === "running" ? "up" : "down"} title={`${fmtDate(row.ts)}: ${row.state}`} />
      ))}
    </div>
  );
}

function ActionTimeline({ actions }) {
  if (!actions?.length) return <p className="muted">Действий пока нет.</p>;
  return (
    <div className="timeline">
      {actions.slice(0, 12).map((action) => (
        <div key={action.id}>
          <span className={action.result}>{action.result}</span>
          <strong>{action.action}</strong>
          <small>{action.project_id || "panel"} · {fmtDate(action.ts)}</small>
          {action.detail ? <p>{action.detail}</p> : null}
        </div>
      ))}
    </div>
  );
}

function MetricTable({ rows, firstLabel, secondLabel, valueKey = "visits" }) {
  if (!rows?.length) return <p className="muted">Данных пока нет. Вставь счётчик на сайт и открой страницу.</p>;
  return (
    <div className="metric-table">
      <div><strong>{firstLabel}</strong><strong>{secondLabel}</strong></div>
      {rows.map((row, index) => (
        <div key={`${row.path || row.referrer || row.event_type}-${index}`}>
          <span>{row.path || row.referrer || row.event_type || "-"}</span>
          <strong>{row[valueKey] ?? row.count ?? row.pageviews ?? 0}</strong>
        </div>
      ))}
    </div>
  );
}

function WebAnalytics({ analytics }) {
  const summary = analytics?.summary || {};
  const timeline = analytics?.timeline || [];
  return (
    <div className="web-analytics">
      <div className="kpi-grid compact-kpis">
        <Kpi icon={Activity} label="Посетители" value={summary.visitors ?? 0} tone="green" hint="уникальные" />
        <Kpi icon={BarChart3} label="Просмотры" value={summary.pageviews ?? 0} hint="pageview" />
        <Kpi icon={Signal} label="Сессии" value={summary.sessions ?? 0} hint="визиты" />
        <Kpi icon={Terminal} label="JS ошибки" value={summary.js_errors ?? 0} tone={summary.js_errors ? "red" : "green"} hint="frontend" />
        <Kpi icon={Clock3} label="Средняя загрузка" value={summary.avg_load_ms ? `${summary.avg_load_ms} ms` : "-"} hint="load" />
        <Kpi icon={MouseIcon} label="Клики" value={summary.clicks ?? 0} hint="кнопки/ссылки" />
      </div>

      <div className="history-grid">
        <div className="panel">
          <div className="panel-title"><LineChart size={17} /> Посетители по часам</div>
          <Sparkline rows={timeline} field="visitors" color="#16a34a" />
        </div>
        <div className="panel">
          <div className="panel-title"><BarChart3 size={17} /> Просмотры по часам</div>
          <Sparkline rows={timeline} field="pageviews" color="#2563eb" />
        </div>
        <div className="panel">
          <div className="panel-title"><FileCode2 size={17} /> Топ страниц</div>
          <MetricTable rows={analytics?.pages || []} firstLabel="Страница" secondLabel="Просмотры" valueKey="pageviews" />
        </div>
        <div className="panel">
          <div className="panel-title"><ExternalLink size={17} /> Источники</div>
          <MetricTable rows={analytics?.referrers || []} firstLabel="Источник" secondLabel="Визиты" valueKey="visits" />
        </div>
      </div>

      <div className="panel">
        <div className="panel-title">
          <Copy size={17} />
          Код счётчика для сайта
        </div>
        <pre className="snippet">{analytics?.snippet || "Сначала выбери проект."}</pre>
        <p className="muted">Вставь этот script перед закрывающим тегом body на сайте проекта. Если сайт доступен извне через Cloudflare, endpoint будет собирать события из любой точки мира.</p>
      </div>

      <div className="panel">
        <div className="panel-title"><History size={17} /> Последние события</div>
        <MetricTable rows={analytics?.recent || []} firstLabel="Событие" secondLabel="Время" valueKey="ts" />
      </div>
    </div>
  );
}

function MouseIcon(props) {
  return <Activity {...props} />;
}

function AddProjectModal({ token, onClose, onAdded }) {
  const [form, setForm] = useState({
    name: "",
    path: "D:\\prodect\\",
    group: "Other",
    kind: "folder",
    description: "",
    url: "",
    ports: "",
    startType: "none",
    startScript: "start",
    batFile: "start.bat",
    allowLogs: true
  });
  const [error, setError] = useState("");

  function setField(name, value) {
    setForm((current) => ({ ...current, [name]: value }));
  }

  async function submit(event) {
    event.preventDefault();
    setError("");
    try {
      await request(token, "/projects", {
        method: "POST",
        body: JSON.stringify(form)
      });
      await onAdded();
      onClose();
    } catch (err) {
      setError(err.message);
    }
  }

  return (
    <div className="modal-backdrop">
      <form className="project-modal" onSubmit={submit}>
        <div className="modal-head">
          <div>
            <h2>Добавить проект</h2>
            <p>Проект появится в боковом списке и в общей таблице.</p>
          </div>
          <button type="button" onClick={onClose} title="Закрыть"><X size={18} /></button>
        </div>

        <div className="form-grid">
          <label>
            Название
            <input value={form.name} onChange={(e) => setField("name", e.target.value)} placeholder="Например: New API" />
          </label>
          <label>
            Группа
            <input value={form.group} onChange={(e) => setField("group", e.target.value)} placeholder="Main, Apps, Docker..." />
          </label>
          <label className="wide-field">
            Путь
            <input value={form.path} onChange={(e) => setField("path", e.target.value)} placeholder="D:\prodect\project" />
          </label>
          <label>
            Тип
            <select value={form.kind} onChange={(e) => setField("kind", e.target.value)}>
              <option value="folder">folder</option>
              <option value="node">node</option>
              <option value="node-workspace">node-workspace</option>
              <option value="docker-compose">docker-compose</option>
              <option value="expo">expo</option>
              <option value="bat-project">bat-project</option>
            </select>
          </label>
          <label>
            URL
            <input value={form.url} onChange={(e) => setField("url", e.target.value)} placeholder="http://localhost:3000" />
          </label>
          <label>
            Порты
            <input value={form.ports} onChange={(e) => setField("ports", e.target.value)} placeholder="3000, 5173" />
          </label>
          <label>
            Запуск
            <select value={form.startType} onChange={(e) => setField("startType", e.target.value)}>
              <option value="none">без запуска</option>
              <option value="npm">npm script</option>
              <option value="docker-compose">docker compose</option>
              <option value="bat">bat файл</option>
            </select>
          </label>
          {form.startType === "npm" ? (
            <label>
              npm script
              <input value={form.startScript} onChange={(e) => setField("startScript", e.target.value)} placeholder="start" />
            </label>
          ) : null}
          {form.startType === "bat" ? (
            <label>
              bat файл
              <input value={form.batFile} onChange={(e) => setField("batFile", e.target.value)} placeholder="start.bat" />
            </label>
          ) : null}
          <label className="wide-field">
            Описание
            <textarea value={form.description} onChange={(e) => setField("description", e.target.value)} placeholder="Коротко что это за проект" />
          </label>
          <label className="check-field">
            <input type="checkbox" checked={form.allowLogs} onChange={(e) => setField("allowLogs", e.target.checked)} />
            Показывать логи панели для проекта
          </label>
        </div>

        {error ? <div className="error">{error}</div> : null}
        <div className="modal-actions">
          <button type="button" onClick={onClose}>Отмена</button>
          <button className="primary" type="submit">Добавить</button>
        </div>
      </form>
    </div>
  );
}

function ProjectAnalytics({ selected, insights, history, overview, security, webAnalytics, activeTab, setActiveTab, onRun, onLogs, onOpenPath }) {
  if (!selected) return null;
  const summary = insights?.summary;
  const infrastructure = insights?.infrastructure;
  const pkg = insights?.package;
  const status = insights?.status || selected.status;
  const projectHistory = history?.history || [];

  return (
    <section className="analytics">
      <div className="analytics-head">
        <div>
          <div className="eyeline">
            <BarChart3 size={17} />
            Главная по выбранному проекту
          </div>
          <h1>{selected.name}</h1>
          <p>{selected.description}</p>
        </div>
        <div className="analytics-actions">
          <StatusBadge state={status?.state} />
          <button onClick={() => onRun(selected, "start")} disabled={!selected.enabledActions?.includes("start") || status?.state === "running"}><Play size={16} /> Запуск</button>
          <button onClick={() => onRun(selected, "restart")} disabled={!selected.enabledActions?.includes("restart")}><RotateCcw size={16} /> Рестарт</button>
          <button onClick={() => onRun(selected, "stop")} disabled={!selected.enabledActions?.includes("stop") || status?.state !== "running"}><Square size={16} /> Стоп</button>
        </div>
      </div>

      <div className="kpi-grid">
        <Kpi icon={Gauge} label="Здоровье" value={`${summary?.healthScore ?? "-"}%`} tone={summary?.healthScore >= 70 ? "green" : "amber"} hint="по локальным проверкам" />
        <Kpi icon={Terminal} label="Ошибки в логах" value={summary?.logErrors ?? "-"} tone={summary?.logErrors ? "red" : "green"} hint={`${summary?.logWarnings ?? 0} предупреждений`} />
        <Kpi icon={FileCode2} label="Scripts" value={summary?.scripts ?? "-"} hint="из package.json" />
        <Kpi icon={Package} label="Зависимости" value={(summary?.dependencies ?? 0) + (summary?.devDependencies ?? 0)} hint="prod + dev" />
        <Kpi icon={Database} label=".env ключи" value={summary?.envKeys ?? "-"} tone={summary?.envKeys ? "amber" : "blue"} hint="значения не читаются" />
        <Kpi icon={FolderOpen} label="Папки / файлы" value={`${summary?.topLevelDirectories ?? "-"} / ${summary?.topLevelFiles ?? "-"}`} hint="верхний уровень" />
      </div>

      <div className="tabs">
        {[
          ["overview", "Обзор", BarChart3],
          ["metrika", "Метрика", Signal],
          ["history", "История", LineChart],
          ["audit", "Журнал", History],
          ["security", "Безопасность", ShieldCheck]
        ].map(([id, label, Icon]) => (
          <button key={id} className={activeTab === id ? "active" : ""} onClick={() => setActiveTab(id)}>
            <Icon size={16} />
            {label}
          </button>
        ))}
      </div>

      {activeTab === "overview" ? <div className="analytics-grid">
        <div className="panel wide-panel">
          <div className="panel-title">
            <ShieldCheck size={17} />
            Диагностика проекта
          </div>
          <div className="checks">
            {(insights?.checks || []).map((check) => (
              <div className="check-row" key={check.label}>
                {check.ok ? <CheckCircle2 size={17} /> : <AlertTriangle size={17} />}
                <span>{check.label}</span>
                <strong>{check.detail}</strong>
              </div>
            ))}
          </div>
          <MiniBar value={summary?.healthScore} />
        </div>

        <div className="panel">
          <div className="panel-title">
            <Server size={17} />
            Инфраструктура
          </div>
          <dl className="compact-dl">
            <dt>Тип</dt><dd>{selected.kind}</dd>
            <dt>Группа</dt><dd>{selected.group}</dd>
            <dt>PID</dt><dd>{status?.pid || "-"}</dd>
            <dt>URL</dt><dd>{selected.url || "-"}</dd>
            <dt>Порты</dt><dd>{infrastructure?.ports?.length ? infrastructure.ports.map((p) => `${p.port}: ${p.open ? "открыт" : "закрыт"}`).join(", ") : "-"}</dd>
            <dt>Docker</dt><dd>{infrastructure?.dockerCompose ? "есть" : "нет"}</dd>
            <dt>BAT</dt><dd>{infrastructure?.batFiles?.length ? infrastructure.batFiles.join(", ") : "-"}</dd>
          </dl>
        </div>

        <div className="panel">
          <div className="panel-title">
            <FileCode2 size={17} />
            Package
          </div>
          {pkg ? (
            <>
              <dl className="compact-dl">
                <dt>name</dt><dd>{pkg.name || "-"}</dd>
                <dt>version</dt><dd>{pkg.version || "-"}</dd>
                <dt>private</dt><dd>{pkg.private ? "да" : "нет"}</dd>
                <dt>workspaces</dt><dd>{pkg.workspaces.length || "-"}</dd>
              </dl>
              <div className="script-list">
                {pkg.scripts.slice(0, 8).map((script) => <span key={script}>{script}</span>)}
              </div>
            </>
          ) : (
            <p className="muted">package.json на верхнем уровне не найден.</p>
          )}
        </div>

        <div className="panel">
          <div className="panel-title">
            <Clock3 size={17} />
            Последние изменения
          </div>
          <div className="changes">
            {(insights?.changes || []).map((item) => (
              <div key={item.name}>
                <span>{item.name}</span>
                <strong>{fmtDate(item.updatedAt)}</strong>
              </div>
            ))}
          </div>
        </div>
      </div> : null}

      {activeTab === "metrika" ? <WebAnalytics analytics={webAnalytics} /> : null}

      {activeTab === "history" ? (
        <div className="history-grid">
          <div className="panel">
            <div className="panel-title"><LineChart size={17} /> Здоровье по времени</div>
            <Sparkline rows={projectHistory} field="health_score" color="#16a34a" />
          </div>
          <div className="panel">
            <div className="panel-title"><Terminal size={17} /> Ошибки по времени</div>
            <Sparkline rows={projectHistory} field="log_errors" color="#dc2626" />
          </div>
          <div className="panel full-span">
            <div className="panel-title"><Activity size={17} /> Uptime-снимки</div>
            <UptimeBars rows={projectHistory} />
          </div>
          <div className="panel full-span">
            <div className="panel-title"><Cpu size={17} /> Система за последние снимки</div>
            <Sparkline rows={overview?.system || []} field="memory_percent" color="#2563eb" />
            <div className="chart-legend">
              <span>RAM %</span>
              <span>{overview?.system?.length || 0} снимков</span>
            </div>
          </div>
        </div>
      ) : null}

      {activeTab === "audit" ? (
        <div className="panel">
          <div className="panel-title"><History size={17} /> Журнал действий</div>
          <ActionTimeline actions={history?.actions || overview?.actions || []} />
        </div>
      ) : null}

      {activeTab === "security" ? (
        <div className="security-grid">
          <div className="panel">
            <div className="panel-title"><ShieldCheck size={17} /> Готовность к Cloudflare</div>
            <div className="security-status">
              <div><span>Пароль</span><strong>{security?.defaultPassword ? "стандартный, плохо" : "задан"}</strong></div>
              <div><span>Token secret</span><strong>{security?.defaultTokenSecret ? "стандартный, плохо" : "задан"}</strong></div>
              <div><span>Host</span><strong>{security?.boundHost || "-"}</strong></div>
              <div><span>Cloudflare</span><strong>{security?.cloudflareReady ? "можно готовить tunnel" : "сначала .env"}</strong></div>
            </div>
          </div>
          <div className="panel">
            <div className="panel-title"><Lock size={17} /> Правила безопасности</div>
            <div className="rule-list">
              {(security?.rules || []).map((rule) => <span key={rule}>{rule}</span>)}
            </div>
          </div>
        </div>
      ) : null}

      <div className="panel log-panel">
        <div className="panel-title">
          <Terminal size={17} />
          Логи и быстрые переходы
          <div className="panel-actions">
            <button onClick={() => onLogs(selected)} disabled={!selected.enabledActions?.includes("logs")}>Логи</button>
            <button onClick={() => onOpenPath(selected)} disabled={!selected.enabledActions?.includes("openPath")}>Папка</button>
            <button onClick={() => window.open(selected.url, "_blank")} disabled={!selected.url}>Сайт</button>
          </div>
        </div>
        <div className="log-stats">
          <span>Размер: {fmtBytes(insights?.logs?.size || 0)}</span>
          <span>Строк: {insights?.logs?.lines ?? 0}</span>
          <span>Обновлён: {fmtDate(insights?.logs?.updatedAt)}</span>
        </div>
      </div>
    </section>
  );
}

function App() {
  const [token, setToken] = useState(localStorage.getItem("panel_token"));
  const [projects, setProjects] = useState([]);
  const [system, setSystem] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [insights, setInsights] = useState(null);
  const [history, setHistory] = useState(null);
  const [overview, setOverview] = useState(null);
  const [security, setSecurity] = useState(null);
  const [webAnalytics, setWebAnalytics] = useState(null);
  const [activeTab, setActiveTab] = useState("overview");
  const [filter, setFilter] = useState("");
  const [group, setGroup] = useState(ALL_GROUPS);
  const [logs, setLogs] = useState("");
  const [message, setMessage] = useState("");
  const [insecure, setInsecure] = useState(false);
  const [showAddProject, setShowAddProject] = useState(false);

  const selected = projects.find((p) => p.id === selectedId) || projects[0];
  const groups = useMemo(() => [ALL_GROUPS, ...Array.from(new Set(projects.map((p) => p.group)))], [projects]);
  const visible = projects.filter((p) => {
    const text = `${p.name} ${p.kind} ${p.description}`.toLowerCase();
    return (group === ALL_GROUPS || p.group === group) && text.includes(filter.toLowerCase());
  });

  async function loadInsights(projectId = selected?.id, activeToken = token) {
    if (!projectId || !activeToken) return;
    const [nextInsights, nextHistory] = await Promise.all([
      request(activeToken, `/projects/${projectId}/insights`),
      request(activeToken, `/projects/${projectId}/history?hours=24`)
    ]);
    setInsights(nextInsights);
    setHistory(nextHistory);
    setWebAnalytics(await request(activeToken, `/projects/${projectId}/web-analytics?hours=24`));
  }

  async function loadAll(activeToken = token) {
    if (!activeToken) return;
    try {
      const [projectBody, systemBody, overviewBody, securityBody] = await Promise.all([
        request(activeToken, "/projects"),
        request(activeToken, "/system"),
        request(activeToken, "/metrics/overview"),
        request(activeToken, "/security")
      ]);
      setProjects(projectBody.projects);
      setSystem(systemBody);
      setOverview(overviewBody);
      setSecurity(securityBody);
      const nextSelected = selectedId || projectBody.projects[0]?.id;
      if (!selectedId && nextSelected) setSelectedId(nextSelected);
      if (nextSelected) await loadInsights(nextSelected, activeToken);
    } catch (err) {
      if (err.message === "unauthorized") {
        localStorage.removeItem("panel_token");
        setToken(null);
      }
    }
  }

  useEffect(() => {
    if (!token) return;
    request(token, "/me").then((body) => setInsecure(body.insecureDefaults)).catch(() => setToken(null));
    loadAll(token);
    const id = setInterval(() => loadAll(token), 5000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => {
    if (selectedId && token) loadInsights(selectedId).catch(() => {});
  }, [selectedId]);

  async function run(project, action) {
    setMessage("");
    try {
      await request(token, `/projects/${project.id}/${action}`, { method: "POST" });
      await loadAll();
      setMessage(`${project.name}: действие выполнено`);
    } catch (err) {
      setMessage(`${project.name}: ${err.message}`);
    }
  }

  async function showLogs(project) {
    setSelectedId(project.id);
    setLogs(await request(token, `/projects/${project.id}/logs`));
  }

  async function openPath(project) {
    await request(token, `/projects/${project.id}/open-path`, { method: "POST" });
  }

  if (!token) {
    return <Login onLogin={(nextToken, body) => { setToken(nextToken); setInsecure(body.insecureDefaults); }} />;
  }

  return (
    <main className="app-shell">
      {showAddProject ? (
        <AddProjectModal token={token} onClose={() => setShowAddProject(false)} onAdded={() => loadAll()} />
      ) : null}
      <aside className="sidebar">
        <div className="brand">
          <LayoutDashboard size={24} />
          <div>
            <strong>Control Panel</strong>
            <span>D:\prodect</span>
          </div>
        </div>
        <nav>
          {groups.map((item) => (
            <button key={item} className={group === item ? "active" : ""} onClick={() => setGroup(item)}>
              <Server size={16} />
              {item}
              <span>{item === ALL_GROUPS ? projects.length : projects.filter((p) => p.group === item).length}</span>
            </button>
          ))}
        </nav>
        <div className="side-projects">
          <div className="side-projects-head">
            <strong>Все мои проекты</strong>
            <button type="button" onClick={() => setShowAddProject(true)} title="Добавить проект">
              <Plus size={16} />
            </button>
          </div>
          <div className="side-project-list">
            {projects.map((project) => (
              <button
                key={project.id}
                className={selected?.id === project.id ? "active" : ""}
                onClick={() => {
                  setSelectedId(project.id);
                  setGroup(ALL_GROUPS);
                }}
              >
                <span className={`dot ${project.status?.state || "stopped"}`} />
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.kind}</small>
                </span>
              </button>
            ))}
          </div>
        </div>
        <div className="sidebar-foot">
          <div><Activity size={15} /> Панель: локально</div>
          <button onClick={() => { localStorage.removeItem("panel_token"); setToken(null); }}>Выйти</button>
        </div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div className="metric">
            <Cpu size={18} />
            <span>CPU</span>
            <strong>{system?.cpu?.cores || "-"} ядер</strong>
          </div>
          <div className="metric">
            <MemoryStick size={18} />
            <span>RAM</span>
            <strong>{system?.memory?.percent ?? "-"}%</strong>
          </div>
          <div className="metric">
            <HardDrive size={18} />
            <span>Disk C:</span>
            <strong>{system?.disk?.percent ?? "-"}%</strong>
          </div>
          <div className="metric wide">
            <Terminal size={18} />
            <span>Uptime</span>
            <strong>{fmtUptime(system?.uptimeSeconds)}</strong>
          </div>
        </header>

        {insecure ? (
          <div className="warning">Сейчас стоят локальные стандартные данные входа. Перед Cloudflare Tunnel поменяй .env.</div>
        ) : null}
        {message ? <div className="toast">{message}</div> : null}

        <div className="main-content">
          <ProjectAnalytics
            selected={selected}
            insights={insights}
            history={history}
            overview={overview}
            security={security}
            webAnalytics={webAnalytics}
            activeTab={activeTab}
            setActiveTab={setActiveTab}
            onRun={run}
            onLogs={showLogs}
            onOpenPath={openPath}
          />

          <section className="project-list">
            <div className="list-head">
              <div>
                <h2>Все проекты</h2>
                <p>{visible.length} из {projects.length} проектов</p>
              </div>
              <label className="search">
                <Search size={17} />
                <input placeholder="Поиск проекта..." value={filter} onChange={(e) => setFilter(e.target.value)} />
              </label>
              <button className="refresh" onClick={() => loadAll()}>
                <RefreshCcw size={16} />
              </button>
            </div>

            <div className="table">
              <div className="row head">
                <span>Проект</span>
                <span>Статус</span>
                <span>Тип</span>
                <span>Порты</span>
                <span>Действия</span>
              </div>
              {visible.map((project) => {
                const actions = project.enabledActions || [];
                return (
                  <button className={`row ${selected?.id === project.id ? "selected" : ""}`} key={project.id} onClick={() => setSelectedId(project.id)}>
                    <span className="project-name">
                      <strong>{project.name}</strong>
                      <small>{project.path}</small>
                    </span>
                    <StatusBadge state={project.status?.state} />
                    <span>{project.kind}</span>
                    <span>{project.ports?.length ? project.ports.join(", ") : "-"}</span>
                    <span className="actions" onClick={(event) => event.stopPropagation()}>
                      <ActionButton title="Запустить" icon={Play} disabled={!actions.includes("start") || project.status?.state === "running"} onClick={() => run(project, "start")} />
                      <ActionButton title="Остановить" icon={Square} danger disabled={!actions.includes("stop") || project.status?.state !== "running"} onClick={() => run(project, "stop")} />
                      <ActionButton title="Перезапустить" icon={RotateCcw} disabled={!actions.includes("restart")} onClick={() => run(project, "restart")} />
                      <ActionButton title="Логи" icon={Terminal} disabled={!actions.includes("logs")} onClick={() => showLogs(project)} />
                      <ActionButton title="Папка" icon={FolderOpen} disabled={!actions.includes("openPath")} onClick={() => openPath(project)} />
                    </span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="logs-drawer">
            <div className="panel-title">
              <Database size={16} />
              Последние логи выбранного проекта
            </div>
            <pre>{logs || "Нажми “Логи”, чтобы загрузить вывод проекта."}</pre>
          </section>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")).render(<App />);
