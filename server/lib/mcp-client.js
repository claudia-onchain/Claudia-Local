/**
 * mcp-client.js — MCP servers your agent can use (Settings → MCP).
 *
 *   Streamable HTTP   a URL, with an optional Bearer token (kept in the vault as keys["mcp.<id>"])
 *   stdio             a program on this computer started with a command and arguments. It runs with your
 *                     user's permissions, so the dashboard warns before you add one.
 *
 * Built in (off until you switch them on):
 *   Claudia Data    https://useclaudia.xyz/mcp/data    read-only data, no key
 *   Claudia Trade   https://useclaudia.xyz/mcp/trade   needs your cmk_ key (Settings → Keys → Claudia). It only
 *                                                      prepares trades and launches; you confirm them yourself.
 *
 * Their tools reach the agent as mcp__<server>__<tool>, each one can be switched off, and every result is
 * wrapped as outside content (untrusted.wrap("mcp", …)). Locking the app closes every connection and stops
 * stdio programs.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { McpHttpClient, mcpResultText } from "@useclaudia/sdk";
import { getConfig, saveConfig, trackActivity } from "./store.js";
import * as vault from "./vault.js";
import { providerValue } from "./providers.js";
import { wrap } from "./untrusted.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
let appVersion = "0.0.0";
let log = () => {};
export function init(opts = {}) { appVersion = opts.version || appVersion; log = opts.log || log; }

export const BUILTIN = [
  { id: "claudia-data", name: "Claudia Data", kind: "http", url: "https://useclaudia.xyz/mcp/data", auth: "none", about: "Coins, holders, scores and feeds from Claudia. Read-only, no key needed." },
  { id: "claudia-trade", name: "Claudia Trade", kind: "http", url: "https://useclaudia.xyz/mcp/trade", auth: "key", keyProvider: "claudia-trade", about: "Prepares trades and launches for you to confirm. Needs your cmk_ key under Settings → Keys → Claudia." },
];

// ── config ─────────────────────────────────────────────────────────────────
/** Built-in entries merged with your settings for them, then the servers you added. */
export function servers(cfg = getConfig()) {
  const saved = Array.isArray(cfg.mcpClients?.servers) ? cfg.mcpClients.servers : [];
  const byId = new Map(saved.map(s => [s.id, s]));
  return [
    ...BUILTIN.map(b => ({ ...b, builtin: true, enabled: !!byId.get(b.id)?.enabled, tools: byId.get(b.id)?.tools || {} })),
    ...saved.filter(s => !BUILTIN.some(b => b.id === s.id)).map(s => ({ ...s, auth: s.kind === "http" ? "bearer" : "none", builtin: false, tools: s.tools || {} })),
  ];
}

function saveServers(list) {
  const c = getConfig();
  c.mcpClients = { servers: list.map(s => s.builtin ? { id: s.id, enabled: !!s.enabled, tools: s.tools || {} } : { id: s.id, name: s.name, kind: s.kind, url: s.url || "", command: s.command || "", args: s.args || [], enabled: !!s.enabled, tools: s.tools || {} }) };
  saveConfig(c);
}

function token(s) {
  if (!vault.isUnlocked()) return null;
  if (s.auth === "key") return providerValue(s.keyProvider, "key");
  if (s.auth === "bearer") return vault.getKey(`mcp.${s.id}`);
  return null;
}

function checkUrl(v) {
  let u;
  try { u = new URL(String(v || "").trim()); } catch { throw err(400, "That address isn't a valid URL."); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw err(400, "Use an https:// address (or http://localhost for a server on this computer).");
  if (u.username || u.password) throw err(400, "Put the token in the token field, not in the address.");
  return u.toString().replace(/\/+$/, "");
}

// ── stdio transport ────────────────────────────────────────────────────────
class StdioClient {
  constructor({ command, args }) {
    this.command = command; this.args = args;
    this.pending = new Map(); this.nextId = 1; this.stderr = ""; this.proc = null; this.ready = null;
  }
  start() {
    const p = spawn(this.command, this.args, { stdio: ["pipe", "pipe", "pipe"], env: process.env, windowsHide: true });
    this.proc = p;
    let buf = "";
    p.stdout.setEncoding("utf-8");
    p.stdout.on("data", (d) => {
      buf += d;
      if (buf.length > 8 * 1024 * 1024) { p.kill(); return; }
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        const w = m && m.id !== undefined ? this.pending.get(m.id) : null;
        if (w) { this.pending.delete(m.id); clearTimeout(w.timer); m.error ? w.reject(err(502, m.error.message || "MCP error")) : w.resolve(m.result); }
      }
    });
    p.stderr.setEncoding("utf-8");
    p.stderr.on("data", (d) => { this.stderr = (this.stderr + d).slice(-2000); });
    const fail = (e) => { for (const [, w] of this.pending) { clearTimeout(w.timer); w.reject(e); } this.pending.clear(); };
    p.on("error", (e) => fail(err(502, `Couldn't start ${this.command}: ${e.message}`)));
    p.on("exit", (code) => { this.proc = null; fail(err(502, `${this.command} stopped (exit ${code}).${this.stderr ? " " + this.stderr.trim().split("\n").pop() : ""}`)); });
  }
  rpc(method, params, timeoutMs = 30_000) {
    if (!this.proc) this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(err(504, `MCP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }) + "\n"); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  connect() {
    this.ready ??= (async () => {
      await this.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claudia-local", version: appVersion } });
      this.proc?.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    })().catch((e) => { this.ready = null; throw e; });
    return this.ready;
  }
  async listTools() {
    await this.connect();
    const out = []; let cursor;
    do { const r = await this.rpc("tools/list", cursor ? { cursor } : {}); out.push(...(r?.tools || [])); cursor = r?.nextCursor; } while (cursor && out.length < 500);
    return out;
  }
  async callTool(name, args) { await this.connect(); return this.rpc("tools/call", { name, arguments: args }, 120_000); }
  async close() { try { this.proc?.kill("SIGTERM"); } catch { /* */ } this.proc = null; this.ready = null; }
}

// ── connections ────────────────────────────────────────────────────────────
const conns = new Map(); // id -> { client, status, error, tools, names: Map(agentName -> toolName) }

const safe = (s) => String(s).replace(/[^A-Za-z0-9_-]/g, "_");
function agentName(serverId, tool) {
  const n = `mcp__${safe(serverId)}__${safe(tool)}`;
  return n.length <= 64 ? n : n.slice(0, 55) + "_" + createHash("sha1").update(n).digest("hex").slice(0, 8);
}

function makeClient(s) {
  if (s.kind === "stdio") return new StdioClient({ command: s.command, args: s.args || [] });
  return new McpHttpClient({ url: s.url, token: () => token(s), clientName: "claudia-local", timeoutMs: 60_000 });
}

/** (Re)connects a server and loads its tool list. */
export async function refresh(id) {
  const s = servers().find(x => x.id === id);
  if (!s) throw err(404, "Unknown MCP server.");
  await disconnect(id);
  if (!s.enabled) return info(id);
  if (!vault.isUnlocked()) throw err(423, "Claudia Local is locked.");
  if (s.auth === "key" && !token(s)) { conns.set(id, { status: "error", error: "Add your Claudia Trade key (cmk_…) under Settings → Keys → Claudia first.", tools: [], names: new Map() }); return info(id); }
  const c = { client: makeClient(s), status: "connecting", error: "", tools: [], names: new Map() };
  conns.set(id, c);
  try {
    const tools = await c.client.listTools();
    c.tools = tools.slice(0, 200).map(t => ({ name: String(t.name), title: t.title || t.annotations?.title || "", description: String(t.description || "").slice(0, 1000), inputSchema: t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object", properties: {} } }));
    for (const t of c.tools) c.names.set(agentName(id, t.name), t.name);
    c.status = "ready";
  } catch (e) {
    c.status = "error";
    c.error = e.message;
    log(`[mcp-client] ${s.name}: ${e.message}`);
  }
  return info(id);
}

async function disconnect(id) {
  const c = conns.get(id);
  conns.delete(id);
  try { await c?.client?.close(); } catch { /* */ }
}

/** Connects every enabled server (after unlocking). */
export async function warm() {
  await Promise.all(servers().filter(s => s.enabled).map(s => refresh(s.id).catch(() => {})));
}

/** Closes everything (locking, quitting). */
export async function closeAll() {
  await Promise.all([...conns.keys()].map(disconnect));
}

// ── what the agent sees ────────────────────────────────────────────────────
export const isMcpTool = (name) => String(name).startsWith("mcp__");

function lookup(name) {
  const cfg = getConfig();
  for (const s of servers(cfg)) {
    const c = conns.get(s.id);
    const tool = c?.names.get(name);
    if (tool) return { s, c, tool };
  }
  return null;
}

export function toolEnabled(name) {
  const x = lookup(name);
  return !!x && x.s.enabled && x.c.status === "ready" && x.s.tools[x.tool] !== false;
}

/** OpenAI-shaped specs for every enabled, connected tool. */
export function toolSpecs() {
  const out = [];
  for (const s of servers()) {
    const c = conns.get(s.id);
    if (!s.enabled || c?.status !== "ready") continue;
    for (const t of c.tools) {
      if (s.tools[t.name] === false) continue;
      const params = { ...t.inputSchema, type: "object" };
      if (!params.properties) params.properties = {};
      out.push({ type: "function", function: { name: agentName(s.id, t.name), description: `[${s.name}] ${t.description || t.title || t.name}`.slice(0, 1024), parameters: params } });
    }
  }
  return out;
}

export async function callTool(name, args) {
  const x = lookup(name);
  if (!x || !toolEnabled(name)) return `The MCP tool ${name} isn't available (switched off or not connected).`;
  const r = await x.c.client.callTool(x.tool, args && typeof args === "object" ? args : {});
  const text = mcpResultText(r) || "(no content)";
  return (r?.isError ? "Error: " : "") + wrap("mcp", text, { from: `${x.s.name} · ${x.tool}` });
}

// ── settings ───────────────────────────────────────────────────────────────
export function info(id) {
  const s = servers().find(x => x.id === id);
  if (!s) return null;
  const c = conns.get(id);
  return {
    id: s.id, name: s.name, kind: s.kind, url: s.url || "", command: s.command || "", args: s.args || [], builtin: !!s.builtin, about: s.about || "",
    auth: s.auth, tokenSet: s.auth === "none" ? null : !!token(s), enabled: !!s.enabled,
    status: !s.enabled ? "off" : c?.status || "idle", error: c?.error || "",
    tools: (c?.tools || []).map(t => ({ name: t.name, title: t.title, description: t.description, agentName: agentName(s.id, t.name), enabled: s.tools[t.name] !== false })),
  };
}

export const list = () => servers().map(s => info(s.id));

export async function add(d) {
  const kind = d.kind === "stdio" ? "stdio" : "http";
  const name = String(d.name || "").trim().slice(0, 60);
  if (!name) throw err(400, "Give the server a name.");
  let id = String(d.id || name).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "server";
  const all = servers();
  if (BUILTIN.some(b => b.id === id) || all.some(s => s.id === id)) id = `${id.slice(0, 26)}-${Date.now().toString(36).slice(-4)}`;
  if (!ID.test(id)) throw err(400, "Bad server id.");
  const s = { id, name, kind, enabled: false, tools: {}, url: "", command: "", args: [] };
  if (kind === "http") s.url = checkUrl(d.url);
  else {
    s.command = String(d.command || "").trim();
    if (!s.command || /[\r\n\0]/.test(s.command) || s.command.length > 300) throw err(400, "Enter the command to run.");
    s.args = (Array.isArray(d.args) ? d.args : String(d.args || "").split(/\s+/)).map(String).filter(Boolean).slice(0, 40);
    if (s.args.some(a => a.length > 500 || /[\r\n\0]/.test(a))) throw err(400, "One of the arguments looks wrong.");
  }
  saveServers([...all, s]);
  if (kind === "http" && d.token) vault.setKeys({ [`mcp.${id}`]: String(d.token).trim() });
  trackActivity("settings", `MCP server added: ${name} (${kind === "stdio" ? "runs " + s.command : s.url})`);
  return info(id);
}

export async function update(id, d) {
  const all = servers();
  const s = all.find(x => x.id === id);
  if (!s) throw err(404, "Unknown MCP server.");
  if ("enabled" in d) s.enabled = !!d.enabled;
  if (d.tools && typeof d.tools === "object") for (const [k, v] of Object.entries(d.tools)) if (k.length <= 128) s.tools[k] = !!v;
  if (!s.builtin && "url" in d && s.kind === "http") s.url = checkUrl(d.url);
  if (!s.builtin && "name" in d && String(d.name).trim()) s.name = String(d.name).trim().slice(0, 60);
  saveServers(all);
  if ("token" in d && s.auth === "bearer") vault.setKeys({ [`mcp.${id}`]: d.token ? String(d.token).trim() : null });
  if ("enabled" in d || "url" in d || "token" in d) return refresh(id);
  return info(id);
}

export async function remove(id) {
  if (BUILTIN.some(b => b.id === id)) throw err(400, "Built-in servers can be switched off, not removed.");
  await disconnect(id);
  saveServers(servers().filter(s => s.id !== id));
  if (vault.isUnlocked()) vault.setKeys({ [`mcp.${id}`]: null });
  return true;
}

