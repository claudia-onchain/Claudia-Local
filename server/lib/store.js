/**
 * store.js — settings, chats, memory, usage and the activity log, all in the data folder.
 * Nothing in here is secret: keys live in the vault (vault.js).
 *
 *   JSON files   written atomically with 0600 permissions (config, usage, activity, …)
 *   chats        SQLite (db.js) when node:sqlite is available; chats.json is moved in once
 *   memory       Markdown files (memory.js): MEMORY.md, USER.md, daily notes; memory.json is moved in once
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { P, ensureHome, replaceFile } from "./paths.js";
import * as D from "./db.js";
import * as mem from "./memory.js";

const cache = new Map();

export function readJsonFile(file, fallback) {
  if (cache.has(file)) return cache.get(file);
  let v = fallback;
  if (existsSync(file)) {
    try { v = JSON.parse(readFileSync(file, "utf-8")); } catch { v = fallback; }
  }
  cache.set(file, v);
  return v;
}

export function writeJsonFile(file, data) {
  ensureHome();
  const tmp = `${file}.${process.pid}.${Date.now()}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* */ }
  replaceFile(tmp, file);
  cache.set(file, data);
}

export const newId = (prefix = "") => prefix + Date.now().toString(36) + randomBytes(4).toString("hex");

// ── config ─────────────────────────────────────────────────────────────────
export const ROLES = ["research", "market", "risk", "security", "wallet", "trader"];

export const DEFAULT_CONFIG = {
  version: 2,
  // 0.2 settings, kept so old files read cleanly. 0.3 keeps models per provider under `chat`.
  model: "",
  roleModels: { research: "", market: "", risk: "", security: "", wallet: "", trader: "" },
  temperature: 0.6,
  maxTokens: 4096,
  tone: "plain",
  tools: {},              // tool name -> false to switch it off (see agent.js for defaults)
  askBeforePost: true,    // the agent must ask before it posts in the Claudia thread
  autoLockMinutes: 30,    // 0 = stay unlocked until you lock or quit (0.2 setups keep what they had)
  showImages: true,       // coin pictures come from the coin's own image host
  // Which provider the agent chats through (presets in providers.js → CHAT_PRESETS). Empty = none yet:
  // there is no default model, the dashboard asks you to add a key. Everything is kept per provider:
  //   models[p]        main model            roleModels[p]  { helpers, tasks } (empty = main model)
  //   helperModels[p]  { research, … } per helper        caps[p]  monthly USD cap (estimate), 0 = none
  //   fallback         { provider, model } tried once when the main model fails after retries
  chat: { provider: "", baseUrl: "", models: {}, roleModels: {}, helperModels: {}, fallback: { provider: "", model: "" }, caps: {} },
  // First-run wizard: true while it still has steps to show (set by setup and "Run setup again").
  wizardPending: false,
  // MCP servers the agent can use (Settings → MCP). Built-in Claudia entries are added by mcp-client.js.
  mcpClients: { servers: [] },
  studio: {
    // Spending caps handed to @useclaudia/media (US dollars). Jobs above approveAboveUsd wait for you.
    limits: { perJobUsd: 2, perDayUsd: 10, perMonthUsd: 50, approveAboveUsd: 0.5 },
    // Media the agent or MCP asks for waits in Socials → Approvals until you say yes.
    askBeforeAgentMedia: true,
    // Kill switch: posting = nothing publishes; drafts = the agent and MCP can't create drafts either.
    killSwitch: { posting: false, drafts: false },
    // Your own daily caps per network (on top of each network's own limits). 0 or missing = no extra cap.
    postCaps: {},
    // Built-in MCP server for Claude Desktop, Claude Code, Cursor (off by default). tokenHash = SHA-256.
    mcp: { enabled: false, port: 3940, tokenHash: "", tokenHint: "" },
  },
  // Tasks, heartbeat, budgets, kill switch and Telegram (tasks.js, telegram.js). Edited through /api/autonomy.
  autonomy: {
    stopped: false,
    budgets: { runsPerDay: 48, toolCallsPerDay: 400, postsPerDay: 10, tokensPerDay: 1500000, usdPerDay: 0 },
    heartbeat: { enabled: false, everyMinutes: 60, telegram: true },
    telegram: { enabled: false, owners: [] },
  },
  persona: null,          // { template, niche, text } from a template (templates.js)
  template: null,         // { id, niche, appliedAt }
  pendingSkills: [],      // skill slugs a template wanted while the skills library wasn't available
  claudia: {
    baseUrl: "https://useclaudia.xyz",
    rpcUrl: "",
    source: "",           // "" | "manual" | "claudia-home"
    agent: null,          // cached /api/v1/me (display only)
    // Per chain, in the chain's own coin. Sells are capped by value too (see policy.js).
    caps: { maxSolPerTrade: 0.05, maxSolPerDay: 0.2, maxEthPerTrade: 0.01, maxEthPerDay: 0.04 },
    liveTrading: false,   // live buys, sells and launches stay off until you switch them on
    room: "general",
    chain: "sol",         // the chain picked on the Claudia page: sol | hood (bsc is coming soon)
    hoodRpcUrl: "",       // Robinhood Chain RPC; empty uses the public one
    hot: { sol: false, hood: false }, // trade from a separate small hot wallet on this chain
    mainWallet: { sol: "", hood: "" }, // where "Sweep back" sends the hot wallet's balance (default: the agent wallet)
  },
};

function merge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) out[k] = merge(base[k], v);
    else out[k] = v;
  }
  return out;
}

export function getConfig() {
  const raw = readJsonFile(P.config, {});
  if (raw.version === 1) return migrateConfig(raw);
  return merge(structuredClone(DEFAULT_CONFIG), structuredClone(raw));
}

/** 0.2 → 0.3, once: the OpenRouter model and the helper models move under chat, per provider. */
function migrateConfig(raw) {
  const c = merge(structuredClone(DEFAULT_CONFIG), structuredClone(raw));
  const prov = c.chat.provider || "openrouter";
  c.chat.provider = prov;
  if (c.model && !c.chat.models.openrouter) c.chat.models.openrouter = c.model;
  const helpers = Object.fromEntries(Object.entries(raw.roleModels || {}).filter(([, v]) => v));
  if (Object.keys(helpers).length) c.chat.helperModels[prov] = { ...helpers, ...(c.chat.helperModels[prov] || {}) };
  c.model = "";
  c.roleModels = { ...DEFAULT_CONFIG.roleModels };
  c.version = 2;
  return saveConfig(c);
}

export function saveConfig(next) {
  writeJsonFile(P.config, next);
  return next;
}

const num = (v, min, max, d) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d;
};
const modelId = (v) => {
  const s = String(v ?? "").trim();
  if (!s) return "";
  if (!/^[A-Za-z0-9._\-/:@~]{1,120}$/.test(s)) throw Object.assign(new Error("That model id doesn't look right (letters, numbers and - _ . / : only)."), { status: 400 });
  return s;
};

/** https://…, or http:// on this machine. */
const chatBaseUrl = (v) => {
  const s = String(v ?? "").trim().replace(/\/+$/, "");
  if (!s) return "";
  let u;
  try { u = new URL(s); } catch { throw Object.assign(new Error("The chat server address isn't a valid URL."), { status: 400 }); }
  // In the Docker image, host.docker.internal is this computer (Ollama or LM Studio running outside the container).
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname) || (process.env.CLAUDIA_LOCAL_DOCKER === "1" && u.hostname === "host.docker.internal");
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw Object.assign(new Error("The chat server address must start with https:// (or http://localhost for a server on this machine)."), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error("Put the key in the key field, not in the address."), { status: 400 });
  return s;
};

/** Validates a settings patch from the dashboard. Unknown fields are ignored. */
export function updateConfig(patch) {
  const c = getConfig();
  const p = patch || {};
  // 0.2 shapes: `model` is the OpenRouter model, `roleModels` are helper models for the current provider.
  if ("model" in p) c.chat.models.openrouter = modelId(p.model);
  if (p.roleModels && typeof p.roleModels === "object") {
    const prov = c.chat.provider || "openrouter";
    const h = { ...(c.chat.helperModels[prov] || {}) };
    for (const r of ROLES) if (r in p.roleModels) h[r] = modelId(p.roleModels[r]);
    c.chat.helperModels[prov] = h;
  }
  if ("wizardPending" in p) c.wizardPending = !!p.wizardPending;
  if ("temperature" in p) c.temperature = num(p.temperature, 0, 1.5, c.temperature);
  if ("maxTokens" in p) c.maxTokens = Math.round(num(p.maxTokens, 256, 32768, c.maxTokens));
  if ("tone" in p && ["plain", "friendly", "brief"].includes(p.tone)) c.tone = p.tone;
  if ("askBeforePost" in p) c.askBeforePost = !!p.askBeforePost;
  if ("autoLockMinutes" in p) c.autoLockMinutes = Math.round(num(p.autoLockMinutes, 0, 24 * 60, 0));
  if ("showImages" in p) c.showImages = !!p.showImages;
  if (p.chat && typeof p.chat === "object") {
    const q = p.chat;
    if ("provider" in q) {
      if (!/^[a-z0-9-]{1,32}$/.test(String(q.provider))) throw Object.assign(new Error("Unknown chat provider."), { status: 400 });
      c.chat.provider = String(q.provider);
    }
    if ("baseUrl" in q) c.chat.baseUrl = chatBaseUrl(q.baseUrl);
    const pid = (k) => /^[a-z0-9-]{1,32}$/.test(k);
    if (q.models && typeof q.models === "object") for (const [k, v] of Object.entries(q.models)) if (pid(k)) c.chat.models[k] = modelId(v);
    if (q.roleModels && typeof q.roleModels === "object") for (const [k, v] of Object.entries(q.roleModels)) {
      if (!pid(k) || !v || typeof v !== "object") continue;
      const r = { ...(c.chat.roleModels[k] || {}) };
      for (const role of ["helpers", "tasks"]) if (role in v) r[role] = modelId(v[role]);
      c.chat.roleModels[k] = r;
    }
    if (q.helperModels && typeof q.helperModels === "object") for (const [k, v] of Object.entries(q.helperModels)) {
      if (!pid(k) || !v || typeof v !== "object") continue;
      const h = { ...(c.chat.helperModels[k] || {}) };
      for (const role of ROLES) if (role in v) h[role] = modelId(v[role]);
      c.chat.helperModels[k] = h;
    }
    if (q.fallback && typeof q.fallback === "object") {
      const fp = String(q.fallback.provider ?? c.chat.fallback.provider);
      if (fp && !pid(fp)) throw Object.assign(new Error("Unknown fallback provider."), { status: 400 });
      c.chat.fallback = { provider: fp, model: fp ? modelId(q.fallback.model ?? c.chat.fallback.model) : "" };
    }
    if (q.caps && typeof q.caps === "object") for (const [k, v] of Object.entries(q.caps)) if (pid(k)) c.chat.caps[k] = Math.round(num(v, 0, 100000, 0) * 100) / 100;
  }
  if (p.studio && typeof p.studio === "object") {
    const q = p.studio;
    if (q.limits && typeof q.limits === "object") {
      const L = { ...c.studio.limits };
      for (const k of ["perJobUsd", "perDayUsd", "perMonthUsd", "approveAboveUsd"]) if (k in q.limits) L[k] = Math.round(num(q.limits[k], 0, 100000, L[k]) * 100) / 100;
      if (L.perJobUsd > L.perDayUsd && L.perDayUsd > 0) throw Object.assign(new Error("The per-job cap can't be bigger than the daily cap."), { status: 400 });
      if (L.perDayUsd > L.perMonthUsd && L.perMonthUsd > 0) throw Object.assign(new Error("The daily cap can't be bigger than the monthly cap."), { status: 400 });
      c.studio.limits = L;
    }
    if ("askBeforeAgentMedia" in q) c.studio.askBeforeAgentMedia = !!q.askBeforeAgentMedia;
    if (q.killSwitch && typeof q.killSwitch === "object") {
      if ("posting" in q.killSwitch) c.studio.killSwitch.posting = !!q.killSwitch.posting;
      if ("drafts" in q.killSwitch) c.studio.killSwitch.drafts = !!q.killSwitch.drafts;
    }
    if (q.postCaps && typeof q.postCaps === "object") for (const [k, v] of Object.entries(q.postCaps)) if (/^[a-z-]{1,20}$/.test(k)) c.studio.postCaps[k] = Math.round(num(v, 0, 1000, 0));
    if (q.mcp && typeof q.mcp === "object") {
      if ("enabled" in q.mcp) c.studio.mcp.enabled = !!q.mcp.enabled;
      if ("port" in q.mcp) c.studio.mcp.port = Math.round(num(q.mcp.port, 1024, 65535, c.studio.mcp.port));
    }
  }
  if (p.tools && typeof p.tools === "object") for (const [k, v] of Object.entries(p.tools)) if (/^[a-z_]{1,40}$/.test(k)) c.tools[k] = !!v;
  if (p.claudia && typeof p.claudia === "object") {
    const q = p.claudia;
    if ("room" in q && /^[a-z0-9-]{1,64}$/.test(String(q.room))) c.claudia.room = String(q.room);
    if ("liveTrading" in q) c.claudia.liveTrading = !!q.liveTrading;
    if (q.caps && typeof q.caps === "object") {
      const t = num(q.caps.maxSolPerTrade, 0, 100, c.claudia.caps.maxSolPerTrade);
      const d = num(q.caps.maxSolPerDay, 0, 1000, c.claudia.caps.maxSolPerDay);
      if (t > d) throw Object.assign(new Error("The per-trade cap can't be bigger than the daily cap."), { status: 400 });
      const et = num(q.caps.maxEthPerTrade, 0, 10, c.claudia.caps.maxEthPerTrade);
      const ed = num(q.caps.maxEthPerDay, 0, 100, c.claudia.caps.maxEthPerDay);
      if (et > ed) throw Object.assign(new Error("The per-trade cap can't be bigger than the daily cap."), { status: 400 });
      c.claudia.caps = { maxSolPerTrade: t, maxSolPerDay: d, maxEthPerTrade: et, maxEthPerDay: ed };
    }
    if ("chain" in q && ["sol", "hood"].includes(q.chain)) c.claudia.chain = q.chain;
    if (q.hot && typeof q.hot === "object") for (const k of ["sol", "hood"]) if (k in q.hot) c.claudia.hot[k] = !!q.hot[k];
  }
  return saveConfig(c);
}

// ── memory (Markdown files, see memory.js) ──────────────────────────────────
export const listMemories = () => mem.entries();

/** `opts.source` (untrusted.js) tags where it came from; outside sources wait in quarantine. */
export function addMemory(content, type = "note", tags = [], opts = {}) {
  return mem.add(content, type, tags, opts);
}

export function deleteMemory(id) {
  return mem.remove(id);
}

/** Full-text search (SQLite FTS5) or word overlap when SQLite isn't there, best first. */
export function searchMemories(query, { type = "", limit = 50 } = {}) {
  return mem.search(query, { type, limit });
}

// ── chats (SQLite; chats.json when node:sqlite isn't available) ──────────────
const CHAT_KEEP = 100;
const chatTitle = (messages) => {
  const firstUser = messages.find(m => m.role === "user");
  const raw = typeof firstUser?.content === "string" ? firstUser.content : Array.isArray(firstUser?.content) ? firstUser.content.find(p => p.type === "text")?.text || "" : "";
  return raw.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
};
// Images and provider-specific blocks are not stored on disk; only the text of each message.
const storable = (messages) => messages.slice(-200).map(m => {
  const { raw, ...rest } = m;
  return Array.isArray(rest.content) ? { ...rest, content: rest.content.filter(p => p.type === "text").map(p => p.text).join("\n") } : rest;
});
const rowToChat = (r) => r && { id: r.id, title: r.title, messages: JSON.parse(r.messages), createdAt: r.created_at, updatedAt: r.updated_at };

let chatsMigrated = false;
function migrateChats() {
  if (chatsMigrated || !D.db) return;
  chatsMigrated = true;
  if (!existsSync(P.chats)) return;
  let old = [];
  try { old = JSON.parse(readFileSync(P.chats, "utf-8")); } catch { old = []; }
  const ins = D.db.prepare("INSERT OR IGNORE INTO chats (id, title, created_at, updated_at, count, messages) VALUES (?, ?, ?, ?, ?, ?)");
  D.tx(() => { for (const c of Array.isArray(old) ? old : []) if (c?.id) ins.run(String(c.id), String(c.title || "New chat"), Number(c.createdAt) || Date.now(), Number(c.updatedAt) || Date.now(), (c.messages || []).length, JSON.stringify(c.messages || [])); });
  renameSync(P.chats, P.chats + ".migrated");
  cache.delete(P.chats);
}

export function listChats() {
  migrateChats();
  if (!D.db) return readJsonFile(P.chats, []);
  return D.db.prepare("SELECT * FROM chats ORDER BY updated_at DESC LIMIT ?").all(CHAT_KEEP).map(rowToChat);
}

/** Id, title, dates and message count only (the chat list). */
export function listChatSummaries() {
  migrateChats();
  if (!D.db) return listChats().map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length }));
  return D.db.prepare("SELECT id, title, updated_at, count FROM chats ORDER BY updated_at DESC LIMIT ?").all(CHAT_KEEP).map(r => ({ id: r.id, title: r.title, updatedAt: r.updated_at, count: r.count }));
}

export function getChat(id) {
  migrateChats();
  if (!D.db) return listChats().find(c => c.id === id) || null;
  return rowToChat(D.db.prepare("SELECT * FROM chats WHERE id = ?").get(String(id))) || null;
}

export function saveChat(id, messages) {
  migrateChats();
  const stored = storable(messages);
  const title = chatTitle(messages);
  if (!D.db) {
    const all = listChats();
    const prev = all.find(c => c.id === id);
    const entry = { id, title: prev?.title && prev.title !== "New chat" ? prev.title : title, messages: stored, createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now() };
    writeJsonFile(P.chats, [entry, ...all.filter(c => c.id !== id)].slice(0, CHAT_KEEP));
    return entry;
  }
  const prev = D.db.prepare("SELECT title, created_at FROM chats WHERE id = ?").get(String(id));
  const entry = { id, title: prev?.title && prev.title !== "New chat" ? prev.title : title, messages: stored, createdAt: prev?.created_at || Date.now(), updatedAt: Date.now() };
  D.db.prepare("INSERT INTO chats (id, title, created_at, updated_at, count, messages) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at, count = excluded.count, messages = excluded.messages")
    .run(String(id), entry.title, entry.createdAt, entry.updatedAt, stored.length, JSON.stringify(stored));
  D.db.prepare("DELETE FROM chats WHERE id NOT IN (SELECT id FROM chats ORDER BY updated_at DESC LIMIT ?)").run(CHAT_KEEP);
  return entry;
}

export function deleteChat(id) {
  migrateChats();
  if (!D.db) return writeJsonFile(P.chats, listChats().filter(c => c.id !== id));
  D.db.prepare("DELETE FROM chats WHERE id = ?").run(String(id));
}

// ── usage + activity ───────────────────────────────────────────────────────
export function trackUsage(model, promptTokens, completionTokens) {
  const u = readJsonFile(P.usage, { days: {} });
  const d = new Date().toISOString().slice(0, 10);
  const day = u.days[d] || { calls: 0, prompt: 0, completion: 0, models: {} };
  day.calls += 1;
  day.prompt += Math.round(promptTokens || 0);
  day.completion += Math.round(completionTokens || 0);
  day.models[model] = (day.models[model] || 0) + 1;
  u.days[d] = day;
  for (const k of Object.keys(u.days).sort().slice(0, -90)) delete u.days[k];
  writeJsonFile(P.usage, u);
}
export const readUsage = () => readJsonFile(P.usage, { days: {} });

export function trackActivity(type, text) {
  const all = readJsonFile(P.activity, []);
  const entry = { id: newId("a_"), type, text: String(text).slice(0, 500), ts: Date.now() };
  writeJsonFile(P.activity, [entry, ...all].slice(0, 500));
  return entry;
}
export const listActivity = (limit = 100) => readJsonFile(P.activity, []).slice(0, limit);

/** "Clear history": deletes chats, the activity log and usage numbers. Memories, files, skills and keys stay. */
export function clearHistory() {
  migrateChats();
  if (D.db) D.db.exec("DELETE FROM chats");
  else writeJsonFile(P.chats, []);
  writeJsonFile(P.activity, []);
  writeJsonFile(P.usage, { days: {} });
}
