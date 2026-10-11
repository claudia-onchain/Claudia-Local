/**
 * routes-auto.js — HTTP API for the agent working on its own (all behind the session cookie, see index.js).
 *
 *   /api/tasks…            Tasks: list, create, edit, delete, run now, pause, schedule preview, runs
 *   /api/autonomy…         daily budgets, heartbeat, the kill switch (stop / resume)
 *   /api/approvals…        the approval queue: answer, confirm a trade, cancel
 *   /api/watchers…         conditions that start a task
 *   /api/templates…        templates (contract with the setup wizard: GET and POST /apply)
 *   /api/brand/presets     brand kit presets (Claudia)
 *   /api/telegram…         Settings → Channels: connect, pairing code, owners, test message
 */
import { json, readJson, HttpError } from "./http.js";
import * as tasks from "./tasks.js";
import * as approvals from "./approvals.js";
import * as watchers from "./watchers.js";
import * as templates from "./templates.js";
import * as telegram from "./telegram.js";
import * as studio from "./studio.js";
import { parseSchedule, nextRuns } from "./cron.js";
import { getConfig } from "./store.js";

const qs = (req) => new URL(req.url, "http://x").searchParams;
const seg = (url, prefix) => url.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);
const body = (req, n = 64 * 1024) => readJson(req, n);

function tasksPayload() {
  return { tasks: tasks.listTasks().map(tasks.publicTask), autonomy: tasks.publicAutonomy(), defaults: { tools: tasks.DEFAULT_TASK_TOOLS }, pending: approvals.pending().length };
}

async function taskRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/tasks" && m === "GET") return json(res, 200, tasksPayload());
  if (url === "/api/tasks" && m === "POST") return json(res, 200, { task: tasks.publicTask(tasks.createTask(await body(req))) });
  if (url === "/api/tasks/schedule" && m === "POST") {
    const d = await body(req, 4096);
    try { const s = parseSchedule(d.schedule); return json(res, 200, { ok: true, label: s.label, next: nextRuns(s, 3) }); } catch (e) { return json(res, 200, { ok: false, error: e.message }); }
  }
  if (url === "/api/tasks/runs" && m === "GET") { const q = qs(req); return json(res, 200, { runs: tasks.listRuns({ taskId: q.get("taskId") || undefined, limit: Math.min(300, Number(q.get("limit")) || 100) }) }); }
  if (url.startsWith("/api/tasks/runs/") && m === "GET") { const r = tasks.getRun(seg(url, "/api/tasks/runs/")[0]); return r ? json(res, 200, r) : json(res, 404, { error: "That run log is gone." }); }
  const [id, action] = seg(url, "/api/tasks/");
  if (!id) throw new HttpError(404, "Unknown tasks route");
  if (!action && m === "GET") { const t = tasks.getTask(id); return t ? json(res, 200, { task: tasks.publicTask(t), runs: tasks.listRuns({ taskId: id, limit: 50 }) }) : json(res, 404, { error: "That task is gone." }); }
  if (!action && m === "POST") return json(res, 200, { task: tasks.publicTask(tasks.updateTask(id, await body(req))) });
  if (!action && m === "DELETE") return json(res, 200, tasks.deleteTask(id));
  if (action === "run" && m === "POST") return json(res, 200, tasks.startRun(id, { trigger: "manual" }));
  if (action === "pause" && m === "POST") { const d = await body(req, 1024); return json(res, 200, { task: tasks.publicTask(tasks.updateTask(id, { enabled: d.paused === false })) }); }
  throw new HttpError(404, "Unknown tasks route");
}

async function autonomyRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/autonomy" && m === "GET") return json(res, 200, tasks.publicAutonomy());
  if (url === "/api/autonomy" && m === "POST") return json(res, 200, tasks.updateAutonomy(await body(req, 8192)));
  if (url === "/api/autonomy/stop" && m === "POST") { tasks.stopAll(); return json(res, 200, tasks.publicAutonomy()); }
  if (url === "/api/autonomy/resume" && m === "POST") { tasks.resumeAll(); return json(res, 200, tasks.publicAutonomy()); }
  if (url === "/api/autonomy/heartbeat" && m === "POST") { tasks.runHeartbeat("manual"); return json(res, 200, tasks.publicAutonomy()); }
  throw new HttpError(404, "Unknown autonomy route");
}

async function approvalRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/approvals" && m === "GET") {
    const all = approvals.list();
    const st = qs(req).get("status");
    const items = st === "pending" ? all.filter((x) => x.status === "pending" || x.status === "confirm") : all.slice(0, 200);
    return json(res, 200, { items: items.map((x) => (x.status === "confirm" ? { ...x, previewText: approvals.previewText(x.preview) } : x)), pending: approvals.pending().length });
  }
  const [id, action] = seg(url, "/api/approvals/");
  if (action === "answer" && m === "POST") { const d = await body(req, 8192); return json(res, 200, { item: await approvals.answer(id, { answers: d.answers, custom: d.custom, by: "dashboard" }) }); }
  if (action === "confirm" && m === "POST") return json(res, 200, { item: await approvals.confirmTrade(id, { by: "dashboard" }) });
  if (action === "cancel" && m === "POST") return json(res, 200, { item: approvals.cancel(id) });
  throw new HttpError(404, "Unknown approvals route");
}

async function watcherRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/watchers" && m === "GET") return json(res, 200, { watchers: watchers.list(), types: watchers.TYPES });
  if (url === "/api/watchers" && m === "POST") return json(res, 200, { watcher: watchers.create(await body(req, 8192)) });
  const [id] = seg(url, "/api/watchers/");
  if (id && m === "POST") return json(res, 200, { watcher: watchers.update(id, await body(req, 8192)) });
  if (id && m === "DELETE") return json(res, 200, watchers.remove(id));
  throw new HttpError(404, "Unknown watchers route");
}

/**
 * Installs one skill through core's POST /api/skills/install on this same server, with the caller's
 * session cookie. 404 (no skills route in this build) → "missing", so the slug waits in pendingSkills.
 */
function skillInstaller(req, port) {
  return async (slug) => {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/skills/install`, {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
        headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${port}`, Cookie: String(req.headers.cookie || "") },
        body: JSON.stringify({ slug }),
      });
      await r.arrayBuffer().catch(() => {});
      if (r.ok) return "installed";
      return r.status === 404 ? "missing" : "failed";
    } catch { return "missing"; }
  };
}

async function templateRoutes(req, res, url, port) {
  const m = req.method;
  if (url === "/api/templates" && m === "GET") return json(res, 200, { templates: templates.listTemplates(), current: getConfig().template || null });
  if (url === "/api/templates/apply" && m === "POST") { const d = await body(req, 4096); return json(res, 200, await templates.apply({ id: String(d.id || ""), niche: d.niche ? String(d.niche) : undefined }, { installSkill: skillInstaller(req, port) })); }
  throw new HttpError(404, "Unknown templates route");
}

async function telegramRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/telegram" && m === "GET") return json(res, 200, telegram.info());
  if (url === "/api/telegram/connect" && m === "POST") { const d = await body(req, 1024); return json(res, 200, await telegram.connect(d.enabled !== false)); }
  if (url === "/api/telegram/pair" && m === "POST") return json(res, 200, telegram.newPairingCode());
  if (url === "/api/telegram/test" && m === "POST") return json(res, 200, await telegram.test());
  const [what, id] = seg(url, "/api/telegram/");
  if (what === "owners" && id && m === "DELETE") return json(res, 200, telegram.unpair(id));
  throw new HttpError(404, "Unknown Telegram route");
}

/** Returns true when it handled the request. `port` is this server's port (for the skills install call). */
export async function handleAuto(req, res, url, { port }) {
  if (url === "/api/tasks" || url.startsWith("/api/tasks/")) { await taskRoutes(req, res, url); return true; }
  if (url === "/api/autonomy" || url.startsWith("/api/autonomy/")) { await autonomyRoutes(req, res, url); return true; }
  if (url === "/api/approvals" || url.startsWith("/api/approvals/")) { await approvalRoutes(req, res, url); return true; }
  if (url === "/api/watchers" || url.startsWith("/api/watchers/")) { await watcherRoutes(req, res, url); return true; }
  if (url === "/api/templates" || url.startsWith("/api/templates/")) { await templateRoutes(req, res, url, port); return true; }
  if (url === "/api/telegram" || url.startsWith("/api/telegram/")) { await telegramRoutes(req, res, url); return true; }
  if (url === "/api/brand/presets" && req.method === "GET") { json(res, 200, { presets: Object.entries(studio.BRAND_PRESETS).map(([id, p]) => ({ id, name: p.name, style: p.style, topics: p.topics, banned: p.banned, visuals: p.visuals })) }); return true; }
  if (url === "/api/brand/presets" && req.method === "POST") { const d = await body(req, 1024); json(res, 200, { brand: await studio.loadBrandPreset(String(d.id || "")) }); return true; }
  return false;
}
