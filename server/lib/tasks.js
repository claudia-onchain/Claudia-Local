/**
 * tasks.js — the agent works on its own: scheduled tasks, the heartbeat, daily budgets and the kill switch.
 *
 *   ~/.claudia-local/tasks.json          tasks and watchers
 *   ~/.claudia-local/runs/               one JSON log per run (the newest 300) + index.json
 *   ~/.claudia-local/autonomy-state.json today's counters, heartbeat and Telegram bookkeeping
 *   ~/.claudia-local/STOP                create this file to pause everything (same as the Stop button)
 *   config.autonomy                      { stopped, budgets, heartbeat, telegram }
 *
 * Tasks run only while Claudia Local is open and unlocked (the keys are in the vault). The scheduler
 * (auto.js) ticks every 30 s, never runs two copies of the same task, and after sleep catches up at most
 * one missed run: the next run is always worked out from "now".
 * Budgets are counted and enforced here, in server code, for everything that runs on its own.
 */
import { existsSync, mkdirSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { HOME, ensurePrivateDir, tilde } from "./paths.js";
import { getConfig, saveConfig, readJsonFile, writeJsonFile, newId, trackActivity, readUsage } from "./store.js";
import * as vault from "./vault.js";
import * as wsp from "./workspace.js";
import * as approvals from "./approvals.js";
import * as runner from "./runner.js";
import * as untrusted from "./untrusted.js";
import { parseSchedule, nextRuns } from "./cron.js";

export const FILES = {
  tasks: join(HOME, "tasks.json"),
  runs: join(HOME, "runs"),
  runIndex: join(HOME, "runs", "index.json"),
  state: join(HOME, "autonomy-state.json"),
  stop: join(HOME, "STOP"),
};
const MAX_RUNS = 300;
const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const clip = (s, n = 200) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

// ── wiring (auto.js) ───────────────────────────────────────────────────────
let broadcast = () => {};
let log = () => {};
let notify = async () => false;    // Telegram: (text) => sent?
let toolNames = [];
export function wire(o) {
  if (o.broadcast) broadcast = o.broadcast;
  if (o.log) log = o.log;
  if (o.notify) notify = o.notify;
  if (o.tools) toolNames = o.tools.map((t) => t.name);
}
const emit = (topic, data) => { try { broadcast({ type: "auto", topic, data }); } catch { /* */ } };

// Tools a task gets when you don't pick: reading, the workspace, paper trading and drafts that wait for you.
export const DEFAULT_TASK_TOOLS = ["read_file", "write_file", "list_dir", "search_files", "memory_search", "claudia_overview", "claudia_coins", "claudia_coin", "claudia_thread", "claudia_agent", "claudia_my_agent", "paper_trade", "paper_portfolio", "trading_limits", "list_media", "list_posts", "inbox", "preview_post", "draft_post"];
export const HEARTBEAT_TOOLS = ["read_file", "list_dir", "search_files", "memory_search", "claudia_overview", "claudia_coins", "claudia_coin", "claudia_thread", "claudia_my_agent", "paper_portfolio", "trading_limits", "list_posts", "inbox", "list_media"];

// ── settings (config.autonomy) ─────────────────────────────────────────────
export const DEFAULT_AUTONOMY = {
  stopped: false,
  budgets: { runsPerDay: 48, toolCallsPerDay: 400, postsPerDay: 10, tokensPerDay: 1_500_000, usdPerDay: 0 },
  heartbeat: { enabled: false, everyMinutes: 60, telegram: true },
  telegram: { enabled: false, owners: [] },
};
const BUDGET_BOUNDS = { runsPerDay: [0, 2000], toolCallsPerDay: [0, 20000], postsPerDay: [0, 500], tokensPerDay: [0, 100_000_000], usdPerDay: [0, 10000] };

export function autonomy() {
  const a = getConfig().autonomy || {};
  return {
    ...DEFAULT_AUTONOMY, ...a,
    budgets: { ...DEFAULT_AUTONOMY.budgets, ...(a.budgets || {}) },
    heartbeat: { ...DEFAULT_AUTONOMY.heartbeat, ...(a.heartbeat || {}) },
    telegram: { ...DEFAULT_AUTONOMY.telegram, ...(a.telegram || {}), owners: Array.isArray(a.telegram?.owners) ? a.telegram.owners : [] },
  };
}
export function saveAutonomy(next) {
  const c = getConfig();
  c.autonomy = next;
  saveConfig(c);
  return next;
}

/** Settings patch from the dashboard: { budgets, heartbeat }. */
export function updateAutonomy(p = {}) {
  const a = autonomy();
  if (p.budgets && typeof p.budgets === "object") {
    for (const [k, [lo, hi]] of Object.entries(BUDGET_BOUNDS)) if (k in p.budgets) {
      const n = Number(p.budgets[k]);
      if (!Number.isFinite(n)) throw err(400, "Budgets must be numbers.");
      a.budgets[k] = Math.min(hi, Math.max(lo, k === "usdPerDay" ? Math.round(n * 100) / 100 : Math.round(n)));
    }
  }
  if (p.heartbeat && typeof p.heartbeat === "object") {
    if ("enabled" in p.heartbeat) a.heartbeat.enabled = !!p.heartbeat.enabled;
    if ("telegram" in p.heartbeat) a.heartbeat.telegram = !!p.heartbeat.telegram;
    if ("everyMinutes" in p.heartbeat) {
      const n = Math.round(Number(p.heartbeat.everyMinutes));
      if (!(n >= 5 && n <= 1440)) throw err(400, "Check in every 5 to 1440 minutes.");
      a.heartbeat.everyMinutes = n;
    }
    if (a.heartbeat.enabled) ensureHeartbeatFile();
  }
  saveAutonomy(a);
  emit("autonomy", publicAutonomy());
  return publicAutonomy();
}

// ── today's counters ───────────────────────────────────────────────────────
const localDay = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
export const readState = () => readJsonFile(FILES.state, {});
export function writeState(fn) { const s = structuredClone(readState()); fn(s); writeJsonFile(FILES.state, s); return s; }

function counts() {
  const s = readState();
  return s.day === localDay() ? { runs: 0, toolCalls: 0, posts: 0, tokens: 0, ...s.counts } : { runs: 0, toolCalls: 0, posts: 0, tokens: 0 };
}
function add(k, n = 1) {
  writeState((s) => {
    if (s.day !== localDay()) { s.day = localDay(); s.counts = { runs: 0, toolCalls: 0, posts: 0, tokens: 0 }; }
    s.counts = { runs: 0, toolCalls: 0, posts: 0, tokens: 0, ...s.counts };
    s.counts[k] = (s.counts[k] || 0) + n;
  });
}

/** Model spend today in USD from core's estimate (usage.json), or null when there is none. */
export function spendToday() {
  const u = readUsage();
  const d = u?.days?.[new Date().toISOString().slice(0, 10)];
  const v = d && (d.usd ?? d.costUsd ?? d.spendUsd);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Why nothing more may run today, or null. */
function overBudget(kind) {
  const b = autonomy().budgets, c = counts();
  if (kind === "run" && b.runsPerDay > 0 && c.runs >= b.runsPerDay) return `The daily limit of ${b.runsPerDay} runs is reached.`;
  if (kind === "tool" && b.toolCallsPerDay > 0 && c.toolCalls >= b.toolCallsPerDay) return `The daily limit of ${b.toolCallsPerDay} tool calls is reached. Write your summary now.`;
  if (b.tokensPerDay > 0 && c.tokens >= b.tokensPerDay) return `The daily model budget (${b.tokensPerDay.toLocaleString("en-US")} tokens) is used up.`;
  const usd = spendToday();
  if (b.usdPerDay > 0 && usd !== null && usd >= b.usdPerDay) return `The daily model spend cap ($${b.usdPerDay}) is reached.`;
  return null;
}
/** Posting alone (tasks with "post without asking"): 0 posts a day means never. */
export const canPost = () => { const b = autonomy().budgets; return b.postsPerDay > 0 && counts().posts < b.postsPerDay; };
export const countPost = () => add("posts", 1);

// ── kill switch ────────────────────────────────────────────────────────────
const running = new Map(); // task id ("heartbeat" too) -> { ac, runId, startedAt }
export const isStopped = () => !!autonomy().stopped || existsSync(FILES.stop);
export const isRunning = (id) => running.has(id);

export function stopAll(reason = "you pressed Stop") {
  const a = autonomy();
  if (!a.stopped) { a.stopped = true; saveAutonomy(a); }
  abortAll();
  trackActivity("tasks", `Everything on its own is paused (${reason})`);
  log(`[tasks] stopped: ${reason}`);
  emit("autonomy", publicAutonomy());
}
export function resumeAll() {
  const a = autonomy();
  a.stopped = false;
  saveAutonomy(a);
  try { if (existsSync(FILES.stop)) unlinkSync(FILES.stop); } catch { /* */ }
  trackActivity("tasks", "Tasks and heartbeat resumed");
  emit("autonomy", publicAutonomy());
}
export function abortAll() { for (const r of running.values()) { try { r.ac.abort(); } catch { /* */ } } }

export function publicAutonomy() {
  const a = autonomy();
  return {
    stopped: isStopped(), stopFile: existsSync(FILES.stop), stopFilePath: tilde(FILES.stop),
    budgets: a.budgets, used: counts(), spendToday: spendToday(), spendEstimate: spendToday() !== null,
    heartbeat: { ...a.heartbeat, lastRun: readState().heartbeat?.lastRun || null, nextRun: a.heartbeat.enabled ? Math.max(Date.now(), (readState().heartbeat?.lastRun || 0) + a.heartbeat.everyMinutes * 60_000) : null, running: running.has("heartbeat") },
    running: [...running.entries()].map(([id, r]) => ({ id, runId: r.runId, startedAt: r.startedAt })),
    unlocked: vault.isUnlocked(),
  };
}

// ── tasks ──────────────────────────────────────────────────────────────────
const data = () => { const d = readJsonFile(FILES.tasks, { version: 1, tasks: [], watchers: [] }); return { version: 1, tasks: [], watchers: [], ...d }; };
const saveData = (d) => writeJsonFile(FILES.tasks, d);
export const listTasks = () => data().tasks;
export const getTask = (id) => listTasks().find((t) => t.id === id) || null;
export const listWatchers = () => data().watchers;
export function updateData(fn) { const d = structuredClone(data()); const out = fn(d); saveData(d); return out; }

const PATH_RE = /^\/[A-Za-z0-9 _\-./{}]{1,200}$/;
function normTask(x = {}, prev = null) {
  const t = prev ? structuredClone(prev) : { id: newId("t_"), createdAt: Date.now(), enabled: false, lastRun: null, nextRun: null, template: null };
  if (!prev || "name" in x) { t.name = String(x.name ?? "").trim().slice(0, 80); if (!t.name) throw err(400, "Give the task a name."); }
  if (!prev || "prompt" in x) { t.prompt = String(x.prompt ?? "").trim().slice(0, 8000); if (!t.prompt) throw err(400, "Write what the task should do."); }
  if (!prev || "schedule" in x) t.schedule = parseSchedule(x.schedule).text;
  if (!prev || "model" in x) {
    const m = String(x.model ?? "").trim();
    if (m && !/^[A-Za-z0-9._\-/:@~]{1,120}$/.test(m)) throw err(400, "That model id doesn't look right.");
    t.model = m;
  }
  if (!prev || "tools" in x) {
    const want = Array.isArray(x.tools) ? x.tools.map(String) : [];
    const unknown = toolNames.length ? want.filter((n) => !toolNames.includes(n)) : [];
    if (unknown.length) throw err(400, `Unknown tool: ${unknown.join(", ")}.`);
    t.tools = [...new Set(want)].slice(0, 60);
  }
  if (!prev || "skills" in x) t.skills = [...new Set((Array.isArray(x.skills) ? x.skills : []).map((s) => String(s).trim()).filter((s) => /^[a-z0-9][a-z0-9-]{0,63}$/.test(s)))].slice(0, 20);
  if (!prev || "budget" in x) t.budget = runner.normBudget(x.budget);
  if (!prev || "delivery" in x) {
    const d = x.delivery || {};
    const file = String(d.file ?? "").trim();
    if (file && (!PATH_RE.test(file) || file.includes(".."))) throw err(400, "The file must be a workspace path like /reports/{date}.md.");
    t.delivery = { telegram: !!d.telegram, file };
  }
  if (!prev || "allowPost" in x) t.allowPost = !!x.allowPost;
  if ("template" in x) t.template = x.template ? String(x.template).slice(0, 40) : null;
  if ("enabled" in x) t.enabled = !!x.enabled;
  t.nextRun = t.enabled ? parseSchedule(t.schedule).next(Date.now()) : null;
  t.updatedAt = Date.now();
  return t;
}

export function createTask(x) {
  const t = normTask(x);
  updateData((d) => { if (d.tasks.length >= 200) throw err(409, "That's 200 tasks already. Delete some first."); d.tasks.push(t); });
  trackActivity("tasks", `Task created: ${t.name}${t.enabled ? "" : " (paused)"}`);
  emit("task", t);
  return t;
}
export function updateTask(id, x) {
  const t = updateData((d) => {
    const i = d.tasks.findIndex((y) => y.id === id);
    if (i < 0) throw err(404, "That task is gone.");
    d.tasks[i] = normTask(x, d.tasks[i]);
    return d.tasks[i];
  });
  emit("task", t);
  return t;
}
export function deleteTask(id) {
  updateData((d) => { d.tasks = d.tasks.filter((t) => t.id !== id); d.watchers = d.watchers.map((w) => (w.taskId === id ? { ...w, taskId: null, enabled: false } : w)); });
  running.get(id)?.ac.abort();
  emit("task", { id, deleted: true });
  return { ok: true };
}
const setTaskFields = (id, f) => updateData((d) => { const t = d.tasks.find((y) => y.id === id); if (t) Object.assign(t, f); return t; });

export function publicTask(t) {
  let nextList = [], label = t.schedule, scheduleError = null;
  try { const s = parseSchedule(t.schedule); label = s.label; nextList = nextRuns(s, 3); } catch (e) { scheduleError = e.message; }
  return { ...t, scheduleLabel: label, scheduleError, upcoming: t.enabled ? nextList : [], running: running.has(t.id) };
}

// ── runs ───────────────────────────────────────────────────────────────────
export const listRuns = ({ taskId, limit = 100 } = {}) => readJsonFile(FILES.runIndex, []).filter((r) => !taskId || r.taskId === taskId).slice(0, limit);
export function getRun(id) {
  if (!/^run_[a-z0-9]{6,40}$/.test(String(id))) return null;
  return readJsonFile(join(FILES.runs, `${id}.json`), null);
}
function saveRun(run) {
  ensurePrivateDir(FILES.runs);
  writeJsonFile(join(FILES.runs, `${run.id}.json`), run);
  const entry = { id: run.id, taskId: run.taskId, name: run.name, trigger: run.trigger, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt, summary: clip(run.summary, 300), toolCalls: run.toolCalls, tokens: run.usage.prompt + run.usage.completion, approvals: run.approvals.length };
  const idx = [entry, ...readJsonFile(FILES.runIndex, []).filter((r) => r.id !== run.id)];
  writeJsonFile(FILES.runIndex, idx.slice(0, MAX_RUNS));
  for (const old of idx.slice(MAX_RUNS)) { try { rmSync(join(FILES.runs, `${old.id}.json`), { force: true }); } catch { /* */ } }
  return entry;
}

const fillPath = (p, t) => p.replace(/\{date\}/g, localDay(t)).replace(/\{time\}/g, new Date(t).toTimeString().slice(0, 5).replace(":", "-"));

async function deliver(task, run) {
  const out = [];
  const text = `${task.name}: ${run.status === "ok" ? "" : `(${run.status}) `}${run.summary}`;
  if (task.delivery?.telegram) { try { if (await notify(text)) out.push("telegram"); } catch (e) { log(`[tasks] telegram: ${e.message}`); } }
  if (task.delivery?.file) {
    try {
      const path = fillPath(task.delivery.file, run.startedAt);
      let prev = "";
      try { const f = wsp.read(path); prev = f.binary ? "" : f.content; } catch { /* new file */ }
      const block = `## ${task.name} · ${new Date(run.startedAt).toLocaleString("en-GB")}\n\n${run.summary}\n`;
      const w = wsp.write(path, (prev ? prev.replace(/\s*$/, "") + "\n\n" : "") + block);
      out.push(w.path);
    } catch (e) { log(`[tasks] file delivery: ${e.message}`); out.push(`file failed: ${e.message}`); }
  }
  return out;
}

/** Why a run can't start now, or null. */
function blocker() {
  if (!vault.isUnlocked()) return "Claudia Local is locked. Tasks run only while it's open and unlocked.";
  if (isStopped()) return "Everything is paused (the Stop button or the STOP file).";
  if (!runner.ready()) return "Still starting up.";
  return null;
}

function gateFor(ac) {
  return {
    beforeRound: () => (isStopped() ? (ac.abort(), "Stopped.") : overBudget("round")),
    beforeTool: () => {
      if (isStopped()) { ac.abort(); return "Stopped by the kill switch."; }
      const over = overBudget("tool");
      if (over) return over;
      add("toolCalls", 1);
      return null;
    },
    onUsage: (p, c) => add("tokens", (p || 0) + (c || 0)),
    canPost,
    onPost: countPost,
  };
}

/**
 * Start a run of a task (or the heartbeat). trigger: "schedule" | "manual" | "watcher".
 * context: extra text for the prompt (already wrapped with untrusted.wrap when it came from outside).
 * origin: untrusted.js source of whatever started it ("user" for your schedule or Run now).
 * Returns { runId } at once; the run carries on in the background.
 */
export function startRun(taskOrId, { trigger = "manual", context = "", origin = "user", label } = {}) {
  const task = typeof taskOrId === "string" ? getTask(taskOrId) : taskOrId;
  if (!task) throw err(404, "That task is gone.");
  if (running.has(task.id)) throw err(409, "It's already running.", "running");
  const stop = blocker();
  if (stop) throw err(423, stop, "blocked");
  const over = overBudget("run");
  if (over) {
    if (task.id !== "heartbeat") setTaskFields(task.id, { lastRun: { at: Date.now(), status: "skipped", summary: over } });
    trackActivity("tasks", `Skipped ${task.name}: ${over}`);
    throw err(429, over, "budget");
  }
  add("runs", 1);
  const ac = new AbortController();
  const runId = newId("run_");
  const startedAt = Date.now();
  running.set(task.id, { ac, runId, startedAt });
  emit("run_started", { taskId: task.id, runId, name: task.name, startedAt });
  trackActivity("tasks", `${task.name} started (${trigger})`);

  const skills = task.skills?.length ? `\n\nSkills from your library that fit this task: ${task.skills.join(", ")}. Read them if you have a tool for it.` : "";
  const prompt = `${task.prompt}${skills}${context ? `\n\nWhat started this run:\n${context}` : ""}`;
  (async () => {
    let res;
    try {
      res = await runner.run({
        prompt, label: label || `the scheduled task "${task.name}"`, tools: task.tools?.length ? task.tools : DEFAULT_TASK_TOOLS,
        role: "tasks", model: task.model, budget: task.budget, origin, source: trigger === "watcher" ? "watcher" : task.id === "heartbeat" ? "heartbeat" : "task",
        allowPost: task.allowPost && untrusted.mayAct(origin), gate: gateFor(ac), signal: ac.signal, taskId: task.id, runId,
        onEvent: (e) => emit("run_event", { runId, taskId: task.id, event: e }),
      });
    } catch (e) {
      res = { status: "error", summary: e.message, events: [{ t: Date.now(), type: "error", text: e.message }], toolCalls: 0, usage: { prompt: 0, completion: 0 }, approvals: [] };
    }
    const run = { id: runId, taskId: task.id, name: task.name, trigger, origin, startedAt, endedAt: Date.now(), ...res, delivered: [] };
    running.delete(task.id);
    if (run.status !== "stopped") run.delivered = await deliver(task, run).catch(() => []);
    const entry = saveRun(run);
    if (task.id === "heartbeat") writeState((s) => { s.heartbeat = { ...(s.heartbeat || {}), lastRunId: runId }; });
    else setTaskFields(task.id, { lastRun: { at: startedAt, status: run.status, runId, summary: clip(run.summary, 300) } });
    trackActivity("tasks", `${task.name}: ${run.status}${run.approvals.length ? `, ${run.approvals.length} waiting for approval` : ""}`);
    emit("run", entry);
  })().catch((e) => { running.delete(task.id); log(`[tasks] run failed: ${e.stack || e.message}`); });
  return { runId };
}

// ── heartbeat ──────────────────────────────────────────────────────────────
const HEARTBEAT_FILE = "/HEARTBEAT.md";
const HEARTBEAT_DEFAULT = `# Heartbeat

Your agent reads this list at every check-in and reports back in a few lines.
Edit it any time: add what you want watched, remove what you don't.

- Is anything waiting for me in Approvals?
- How are $CLAUDIA and the coins I follow doing since the last check-in? Only mention big moves.
- Anything new in the Claudia thread that mentions my agent or my coins?
- How is my paper portfolio doing?
- Anything in my notes or memories that is due today?

If nothing needs me, say "All quiet."
`;
export function ensureHeartbeatFile() {
  try { if (!wsp.stat(HEARTBEAT_FILE)) wsp.write(HEARTBEAT_FILE, HEARTBEAT_DEFAULT); } catch (e) { log(`[tasks] HEARTBEAT.md: ${e.message}`); }
}
const HEARTBEAT_TASK = () => {
  const hb = autonomy().heartbeat;
  return { id: "heartbeat", name: "Heartbeat", tools: HEARTBEAT_TOOLS, budget: { maxRounds: 4, maxToolCalls: 8 }, allowPost: false, model: "", skills: [], delivery: { telegram: !!hb.telegram, file: "" }, prompt: "" };
};

export function runHeartbeat(trigger = "schedule") {
  ensureHeartbeatFile();
  let list = "";
  try { list = wsp.read(HEARTBEAT_FILE).content.slice(0, 8000); } catch { list = HEARTBEAT_DEFAULT; }
  const waiting = approvals.pending().length;
  const t = { ...HEARTBEAT_TASK(), prompt: `Heartbeat check-in. Go through my checklist below (from HEARTBEAT.md in the workspace) and report in at most 8 short lines. Approvals waiting right now: ${waiting}.\n\n${list}` };
  writeState((s) => { s.heartbeat = { ...(s.heartbeat || {}), lastRun: Date.now() }; });
  return startRun(t, { trigger, label: "a heartbeat check-in" });
}

// ── the scheduler's tick (auto.js calls this every 30 s) ───────────────────
export function tick() {
  if (blocker()) return;
  const now = Date.now();
  for (const t of listTasks()) {
    if (!t.enabled || running.has(t.id)) continue;
    if (!t.nextRun) { setTaskFields(t.id, { nextRun: safeNext(t.schedule, now) }); continue; }
    if (t.nextRun > now) continue;
    // Due (or overdue after sleep): run once, and work the next time out from now so missed runs don't pile up.
    setTaskFields(t.id, { nextRun: safeNext(t.schedule, now) });
    try { startRun(t, { trigger: "schedule" }); } catch (e) { if (e.code !== "budget") log(`[tasks] ${t.name}: ${e.message}`); }
  }
  const hb = autonomy().heartbeat;
  if (hb.enabled && !running.has("heartbeat")) {
    const last = readState().heartbeat?.lastRun || 0;
    if (now - last >= hb.everyMinutes * 60_000) { try { runHeartbeat(); } catch (e) { if (e.code !== "budget") log(`[tasks] heartbeat: ${e.message}`); } }
  }
}
function safeNext(schedule, from) { try { return parseSchedule(schedule).next(from); } catch { return null; } }

/** Watches the STOP file between ticks so it takes effect within seconds. */
export function watchStopFile() {
  let was = existsSync(FILES.stop);
  setInterval(() => {
    const now = existsSync(FILES.stop);
    if (now && !was) { abortAll(); trackActivity("tasks", "STOP file found: everything on its own is paused"); emit("autonomy", publicAutonomy()); }
    if (!now && was) emit("autonomy", publicAutonomy());
    was = now;
  }, 3000).unref();
}

export function init() {
  try { if (!existsSync(FILES.runs)) mkdirSync(FILES.runs, { recursive: true, mode: 0o700 }); } catch { /* */ }
}
