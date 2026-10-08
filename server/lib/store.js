/**
 * store.js — small JSON files in the data folder, written atomically with 0600 permissions.
 * Nothing in here is secret: keys live in the vault (vault.js).
 */
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { P, ensureHome } from "./paths.js";

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
  renameSync(tmp, file);
  cache.set(file, data);
}

export const newId = (prefix = "") => prefix + Date.now().toString(36) + randomBytes(4).toString("hex");

// ── config ─────────────────────────────────────────────────────────────────
export const ROLES = ["research", "market", "risk", "security", "wallet", "trader"];

export const DEFAULT_CONFIG = {
  version: 1,
  // Empty means "use the default model" (see model.js). The UI never shows the default id.
  model: "",
  roleModels: { research: "", market: "", risk: "", security: "", wallet: "", trader: "" },
  temperature: 0.6,
  maxTokens: 4096,
  tone: "plain",
  tools: {},              // tool name -> false to switch it off (see agent.js for defaults)
  askBeforePost: true,    // the agent must ask before it posts in the Claudia thread
  autoLockMinutes: 0,     // 0 = stay unlocked until you lock or quit
  showImages: true,       // coin pictures come from the coin's own image host
  // Which OpenAI-compatible server the agent chats through (presets in providers.js → CHAT_PRESETS).
  // `model` above stays the OpenRouter model; other providers keep their model id in chat.models.
  chat: { provider: "openrouter", baseUrl: "", models: {} },
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
  claudia: {
    baseUrl: "https://useclaudia.xyz",
    rpcUrl: "",
    source: "",           // "" | "manual" | "claudia-home"
    agent: null,          // cached /api/v1/me (display only)
    caps: { maxSolPerTrade: 0.05, maxSolPerDay: 0.2 },
    liveTrading: false,   // live buys, sells and launches stay off until you switch them on
    room: "general",
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
  return merge(structuredClone(DEFAULT_CONFIG), structuredClone(readJsonFile(P.config, {})));
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
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw Object.assign(new Error("The chat server address must start with https:// (or http://localhost for a server on this machine)."), { status: 400 });
  if (u.username || u.password) throw Object.assign(new Error("Put the key in the key field, not in the address."), { status: 400 });
  return s;
};

/** Validates a settings patch from the dashboard. Unknown fields are ignored. */
export function updateConfig(patch) {
  const c = getConfig();
  const p = patch || {};
  if ("model" in p) c.model = modelId(p.model);
  if (p.roleModels && typeof p.roleModels === "object") for (const r of ROLES) if (r in p.roleModels) c.roleModels[r] = modelId(p.roleModels[r]);
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
    if (q.models && typeof q.models === "object") for (const [k, v] of Object.entries(q.models)) if (/^[a-z0-9-]{1,32}$/.test(k)) c.chat.models[k] = modelId(v);
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
      c.claudia.caps = { maxSolPerTrade: t, maxSolPerDay: d };
    }
  }
  return saveConfig(c);
}

// ── memory ─────────────────────────────────────────────────────────────────
const MEMORY_TYPES = ["note", "fact", "preference", "conversation", "task"];
export const listMemories = () => readJsonFile(P.memory, []);

export function addMemory(content, type = "note", tags = []) {
  const text = String(content ?? "").trim().slice(0, 8000);
  if (!text) throw Object.assign(new Error("A memory needs some text."), { status: 400 });
  const entry = {
    id: newId("m_"), content: text, type: MEMORY_TYPES.includes(type) ? type : "note",
    tags: (Array.isArray(tags) ? tags : []).map(t => String(t).slice(0, 32)).filter(Boolean).slice(0, 8), ts: Date.now(),
  };
  const all = [entry, ...listMemories()].slice(0, 2000);
  writeJsonFile(P.memory, all);
  return entry;
}

export function deleteMemory(id) {
  const all = listMemories();
  const next = all.filter(m => m.id !== id);
  writeJsonFile(P.memory, next);
  return all.length !== next.length;
}

/** Simple word-overlap search, newest first on ties. */
export function searchMemories(query, { type = "", limit = 50 } = {}) {
  const all = listMemories().filter(m => !type || m.type === type);
  const words = String(query || "").toLowerCase().split(/[^a-z0-9$]+/i).filter(w => w.length > 1);
  if (!words.length) return all.slice(0, limit);
  return all
    .map(m => {
      const hay = (m.content + " " + m.tags.join(" ")).toLowerCase();
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      return { m, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.ts - a.m.ts)
    .slice(0, limit)
    .map(x => x.m);
}

// ── chats ──────────────────────────────────────────────────────────────────
export const listChats = () => readJsonFile(P.chats, []);
export const getChat = (id) => listChats().find(c => c.id === id) || null;

export function saveChat(id, messages) {
  const all = listChats();
  const firstUser = messages.find(m => m.role === "user");
  const raw = typeof firstUser?.content === "string" ? firstUser.content : Array.isArray(firstUser?.content) ? firstUser.content.find(p => p.type === "text")?.text || "" : "";
  const title = raw.replace(/\s+/g, " ").trim().slice(0, 60) || "New chat";
  // Images are not stored on disk; only the text of each message.
  const stored = messages.slice(-200).map(m => (Array.isArray(m.content) ? { ...m, content: m.content.filter(p => p.type === "text").map(p => p.text).join("\n") } : m));
  const prev = all.find(c => c.id === id);
  const entry = { id, title: prev?.title && prev.title !== "New chat" ? prev.title : title, messages: stored, createdAt: prev?.createdAt || Date.now(), updatedAt: Date.now() };
  writeJsonFile(P.chats, [entry, ...all.filter(c => c.id !== id)].slice(0, 100));
  return entry;
}

export function deleteChat(id) {
  writeJsonFile(P.chats, listChats().filter(c => c.id !== id));
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

/** Removes everything except the vault and the workspace (used by "Clear history"). */
export function clearHistory() {
  writeJsonFile(P.chats, []);
  writeJsonFile(P.activity, []);
  writeJsonFile(P.usage, { days: {} });
}
