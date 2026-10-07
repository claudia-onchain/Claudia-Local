#!/usr/bin/env node
/**
 * Claudia Local — server.
 *
 * One Node process on 127.0.0.1 serves the dashboard, a JSON API and the agent WebSocket.
 * Nothing listens on other interfaces. Secrets stay in the encrypted vault; the app is locked until
 * you enter your passphrase, and unlocking sets a same-site, HttpOnly session cookie that every API
 * call and the WebSocket need.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync, statSync, appendFileSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { P, ensureHome, HOME } from "./lib/paths.js";
import { json, readJson, HttpError, createGuards, securityHeaders, createRateLimiter } from "./lib/http.js";
import * as vault from "./lib/vault.js";
import * as store from "./lib/store.js";
import * as wsp from "./lib/workspace.js";
import * as cl from "./lib/claudia.js";
import { listModels, modelLabel, DEFAULT_MODEL } from "./lib/model.js";
import { createAgent, toolList, HELPERS, TOOLS } from "./agent.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")).version;
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(__dirname, "..", "dashboard", "dist");
const PORT = Number(process.env.CLAUDIA_LOCAL_PORT || process.env.PORT || 3939);
const HOST = "127.0.0.1"; // never anything else

ensureHome();
const guards = createGuards(PORT);
const limit = createRateLimiter();

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { appendFileSync(P.log, line + "\n", { mode: 0o600 }); } catch { /* */ }
}

const agent = createAgent({ log });

// ── auto-lock ──────────────────────────────────────────────────────────────
let lastActive = Date.now();
function lockNow(reason) {
  vault.lock();
  agent.reset();
  guards.endAllSessions();
  for (const c of wss.clients) { try { c.close(4401, "Locked"); } catch { /* */ } }
  log(`Locked (${reason})`);
}
setInterval(() => {
  const m = store.getConfig().autoLockMinutes;
  if (m > 0 && vault.isUnlocked() && Date.now() - lastActive > m * 60_000) lockNow("idle");
}, 30_000).unref();

// ── public (no session) routes ─────────────────────────────────────────────
function state(req) {
  return { name: "Claudia Local", version: VERSION, setup: vault.exists(), unlocked: vault.isUnlocked() && guards.hasSession(req), dataDir: HOME.replace(process.env.HOME || "\u0000", "~") };
}

async function startSession(res) {
  const token = guards.newSession();
  res.setHeader("Set-Cookie", guards.sessionCookie(token));
}

async function publicRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/health" && m === "GET") return json(res, 200, { ok: true, name: "claudia-local", version: VERSION }), true;
  if (url === "/api/state" && m === "GET") return json(res, 200, state(req)), true;
  if (url === "/api/setup" && m === "POST") {
    const d = await readJson(req, 16 * 1024);
    if (vault.exists()) throw new HttpError(409, "Already set up. Unlock with your passphrase.");
    if (d.passphrase !== d.confirm) throw new HttpError(400, "The two passphrases don't match.");
    const key = String(d.openrouterKey || "").trim();
    if (key && !/^sk-or-[A-Za-z0-9_-]{10,200}$/.test(key) && !process.env.CLAUDIA_LOCAL_OPENROUTER_BASE) throw new HttpError(400, "That doesn't look like an OpenRouter key (it starts with sk-or-).");
    await vault.create(d.passphrase, { openrouterKey: key || undefined });
    store.saveConfig(store.getConfig());
    if (d.model !== undefined) store.updateConfig({ model: d.model });
    store.trackActivity("app", "Claudia Local set up");
    await startSession(res);
    log("Vault created");
    return json(res, 200, { ok: true, ...state(req), unlocked: true }), true;
  }
  if (url === "/api/unlock" && m === "POST") {
    const rl = limit("unlock", 8, 60_000);
    if (!rl.ok) throw new HttpError(429, `Too many tries. Wait ${rl.retryAfterSec} s.`);
    const d = await readJson(req, 8 * 1024);
    if (!vault.exists()) throw new HttpError(409, "Set up Claudia Local first.");
    await vault.unlock(String(d.passphrase || ""));
    await startSession(res);
    lastActive = Date.now();
    log("Unlocked");
    return json(res, 200, { ok: true, ...state(req), unlocked: true }), true;
  }
  return false;
}

// ── private routes ─────────────────────────────────────────────────────────
const qs = (req) => new URL(req.url, "http://x").searchParams;

function publicConfig() {
  const c = store.getConfig();
  return {
    model: c.model, modelLabel: modelLabel(c.model || DEFAULT_MODEL), usingDefaultModel: !c.model, roleModels: c.roleModels,
    temperature: c.temperature, maxTokens: c.maxTokens, tone: c.tone, askBeforePost: c.askBeforePost, autoLockMinutes: c.autoLockMinutes,
    showImages: c.showImages, openrouterKey: vault.mask("openrouterKey"), dataDir: HOME, workspaceDir: wsp.root(),
  };
}

async function claudiaRoutes(req, res, url) {
  const m = req.method;
  const sub = url.slice("/api/claudia".length);
  const body = () => readJson(req, 64 * 1024);
  if (sub === "/status" && m === "GET") return json(res, 200, cl.status());
  if (sub === "/connect" && m === "POST") return json(res, 200, await cl.connect(await body()));
  if (sub === "/generate-keys" && m === "POST") { const d = await body(); return json(res, 200, cl.generateKeys({ device: !!d.device, wallet: !!d.wallet, force: !!d.force })); }
  if (sub === "/home" && m === "GET") return json(res, 200, cl.homeInfo());
  if (sub === "/import" && m === "POST") { const d = await body(); return json(res, 200, await cl.importHome({ passphrase: d.passphrase })); }
  if (sub === "/disconnect" && m === "POST") { const d = await body(); return json(res, 200, cl.disconnect({ keepWallet: d.keepWallet !== false })); }
  if (sub === "/me" && m === "GET") return json(res, 200, await cl.refreshMe());
  if (sub === "/wallet" && m === "GET") return json(res, 200, await cl.walletInfo());
  if (sub === "/wallet/export" && m === "POST") {
    const d = await body();
    if (!(await vault.verify(String(d.passphrase || "")))) throw new HttpError(401, "Wrong passphrase.");
    if (!vault.has("walletKey")) throw new HttpError(404, "There's no agent wallet.");
    store.trackActivity("claudia", "Agent wallet key shown for backup");
    return json(res, 200, { address: cl.walletAddress(), secretKey: vault.get("walletKey") });
  }
  if (sub === "/platform" && m === "GET") return json(res, 200, await cl.publicClient().platform());
  if (sub === "/overview" && m === "GET") return json(res, 200, await cl.overview());
  if (sub === "/coins" && m === "GET") return json(res, 200, { coins: await cl.coins(qs(req).get("q") || "") });
  if (sub.startsWith("/coin/") && m === "GET") return json(res, 200, await cl.coin(decodeURIComponent(sub.slice(6))));
  if (sub === "/rooms" && m === "GET") return json(res, 200, { rooms: await cl.rooms() });
  if (sub.startsWith("/thread/") && m === "GET") {
    const room = decodeURIComponent(sub.slice(8));
    if (!/^[a-z0-9-]{1,64}$/.test(room)) throw new HttpError(400, "Bad room name");
    return json(res, 200, { messages: await cl.thread(room, { limit: Number(qs(req).get("limit")) || 40, after: qs(req).get("after") || undefined }) });
  }
  if (sub === "/post" && m === "POST") { const d = await body(); return json(res, 200, await cl.post(String(d.room || "general"), d.content)); }
  if (sub === "/agents" && m === "GET") return json(res, 200, { agents: await cl.agents(qs(req).get("q") || "") });
  if (sub.startsWith("/agent/") && m === "GET") return json(res, 200, await cl.agentProfile(decodeURIComponent(sub.slice(7))));
  if (sub === "/quote" && m === "POST") return json(res, 200, await cl.quote(await body()));
  if (sub === "/trade/preview" && m === "POST") return json(res, 200, await cl.previewTrade(await body()));
  if (sub === "/trade/confirm" && m === "POST") return json(res, 200, await cl.confirmTrade(await body()));
  if (sub === "/launch/preview" && m === "POST") return json(res, 200, await cl.previewLaunch(await body()));
  if (sub === "/launch/confirm" && m === "POST") return json(res, 200, await cl.confirmLaunch(await body()));
  if (sub === "/proposals" && m === "GET") return json(res, 200, { proposals: cl.listProposals() });
  if (sub.startsWith("/proposals/") && m === "DELETE") { cl.dismissProposal(decodeURIComponent(sub.slice(11))); return json(res, 200, { ok: true }); }
  if (sub === "/paper" && m === "GET") return json(res, 200, await cl.paperPortfolio());
  if (sub === "/paper/trade" && m === "POST") return json(res, 200, await cl.paperTrade(await body()));
  if (sub === "/paper/reset" && m === "POST") { cl.paperReset(); return json(res, 200, { ok: true }); }
  throw new HttpError(404, "Unknown Claudia route");
}

async function privateRoutes(req, res, url) {
  const m = req.method;
  if (url.startsWith("/api/claudia/")) return claudiaRoutes(req, res, url);

  if (url === "/api/lock" && m === "POST") { lockNow("you locked it"); res.setHeader("Set-Cookie", guards.sessionCookie("", 0)); return json(res, 200, { ok: true }); }
  if (url === "/api/passphrase" && m === "POST") {
    const d = await readJson(req, 8 * 1024);
    if (d.next !== d.confirm) throw new HttpError(400, "The new passphrases don't match.");
    await vault.changePassphrase(String(d.current || ""), String(d.next || ""));
    store.trackActivity("app", "Passphrase changed");
    return json(res, 200, { ok: true });
  }

  if (url === "/api/config" && m === "GET") return json(res, 200, publicConfig());
  if (url === "/api/config" && m === "POST") { store.updateConfig(await readJson(req, 64 * 1024)); return json(res, 200, publicConfig()); }
  if (url === "/api/secrets/openrouter" && m === "POST") {
    const k = String((await readJson(req, 8 * 1024)).key || "").trim();
    if (k && !/^sk-or-[A-Za-z0-9_-]{10,200}$/.test(k) && !process.env.CLAUDIA_LOCAL_OPENROUTER_BASE) throw new HttpError(400, "That doesn't look like an OpenRouter key (it starts with sk-or-).");
    vault.set({ openrouterKey: k || null });
    store.trackActivity("settings", k ? "OpenRouter key saved" : "OpenRouter key removed");
    return json(res, 200, publicConfig());
  }
  if (url === "/api/models" && m === "GET") {
    try { return json(res, 200, { models: await listModels() }); } catch (e) { return json(res, 200, { models: [], error: "Couldn't load the model list: " + e.message }); }
  }

  if (url === "/api/tools" && m === "GET") return json(res, 200, { tools: toolList(), askBeforePost: store.getConfig().askBeforePost });
  if (url === "/api/tools" && m === "POST") {
    const d = await readJson(req, 16 * 1024);
    const patch = {};
    for (const t of TOOLS) if (!t.locked && t.name in (d.tools || {})) patch[t.name] = !!d.tools[t.name];
    store.updateConfig({ tools: patch, ...("askBeforePost" in d ? { askBeforePost: d.askBeforePost } : {}) });
    return json(res, 200, { tools: toolList(), askBeforePost: store.getConfig().askBeforePost });
  }
  if (url === "/api/helpers" && m === "GET") {
    const c = store.getConfig();
    return json(res, 200, { helpers: Object.entries(HELPERS).map(([role, h]) => ({ role, label: h.label, about: h.about, tools: h.tools, model: c.roleModels[role] || "", modelLabel: c.roleModels[role] ? modelLabel(c.roleModels[role]) : "Same as chat" })) });
  }

  if (url === "/api/memory" && m === "GET") { const q = qs(req); return json(res, 200, { memories: store.searchMemories(q.get("q") || "", { type: q.get("type") || "", limit: 200 }), total: store.listMemories().length }); }
  if (url === "/api/memory" && m === "POST") { const d = await readJson(req, 64 * 1024); return json(res, 200, { entry: store.addMemory(d.content, d.type, d.tags) }); }
  if (url.startsWith("/api/memory/") && m === "DELETE") return json(res, 200, { ok: store.deleteMemory(decodeURIComponent(url.slice(12))) });

  if (url === "/api/files") {
    const q = qs(req);
    const path = q.get("path") || "/";
    if (m === "GET" && q.get("search")) return json(res, 200, { results: wsp.search(q.get("search"), path) });
    if (m === "GET") {
      const st = wsp.stat(path);
      if (!st) return json(res, 404, { error: `Not found: ${path}` });
      if (st.isDirectory) return json(res, 200, { path: st.path, isDirectory: true, items: wsp.list(path) });
      return json(res, 200, { isDirectory: false, ...wsp.read(path) });
    }
    if (m === "POST") {
      const d = await readJson(req, wsp.MAX_FILE_BYTES + 64 * 1024);
      if (d.type === "folder") return json(res, 200, wsp.mkdir(d.path));
      const r = wsp.write(d.path, d.content ?? "");
      store.trackActivity("files", `Saved ${r.path}`);
      return json(res, 200, r);
    }
    if (m === "DELETE") { const r = wsp.remove(path); store.trackActivity("files", `Deleted ${r.path}`); return json(res, 200, r); }
  }

  if (url === "/api/sessions" && m === "GET") return json(res, 200, { sessions: store.listChats().map(c => ({ id: c.id, title: c.title, updatedAt: c.updatedAt, count: c.messages.length })) });
  if (url.startsWith("/api/sessions/") && m === "GET") { const c = store.getChat(decodeURIComponent(url.slice(14))); return c ? json(res, 200, c) : json(res, 404, { error: "Chat not found" }); }
  if (url.startsWith("/api/sessions/") && m === "DELETE") { store.deleteChat(decodeURIComponent(url.slice(14))); return json(res, 200, { ok: true }); }

  if (url === "/api/activity" && m === "GET") return json(res, 200, { activity: store.listActivity(Number(qs(req).get("limit")) || 100) });
  if (url === "/api/analytics" && m === "GET") {
    const u = store.readUsage();
    const days = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
      const x = u.days[d] || { calls: 0, prompt: 0, completion: 0, models: {} };
      days.push({ date: d, calls: x.calls, tokens: x.prompt + x.completion });
    }
    const models = {};
    let calls = 0, prompt = 0, completion = 0;
    for (const x of Object.values(u.days)) {
      calls += x.calls; prompt += x.prompt; completion += x.completion;
      for (const [k, v] of Object.entries(x.models || {})) { const l = modelLabel(k); models[l] = (models[l] || 0) + v; }
    }
    return json(res, 200, { days, totals: { calls, prompt, completion }, models: Object.entries(models).map(([model, n]) => ({ model, calls: n })).sort((a, b) => b.calls - a.calls) });
  }
  if (url === "/api/history" && m === "DELETE") { store.clearHistory(); agent.reset(); return json(res, 200, { ok: true }); }

  throw new HttpError(404, "Unknown API route");
}

// ── static dashboard ───────────────────────────────────────────────────────
const MIME = { html: "text/html; charset=utf-8", js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", ico: "image/x-icon", json: "application/json", woff2: "font/woff2", woff: "font/woff", webp: "image/webp", txt: "text/plain; charset=utf-8", webmanifest: "application/manifest+json" };
function serveStatic(req, res, url) {
  let rel;
  try { rel = decodeURIComponent(url === "/" ? "/index.html" : url); } catch { rel = "/index.html"; }
  const full = normalize(join(DIST, rel));
  if (full.startsWith(DIST + sep) && existsSync(full) && statSync(full).isFile()) {
    const ext = extname(full).slice(1);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": ext === "html" ? "no-cache" : rel.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=3600" });
    return res.end(req.method === "HEAD" ? undefined : readFileSync(full));
  }
  const index = join(DIST, "index.html");
  if (existsSync(index)) { res.writeHead(200, { "Content-Type": MIME.html, "Cache-Control": "no-cache" }); return res.end(readFileSync(index)); }
  res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("The dashboard isn't built yet. Run: npm run build");
}

// ── HTTP ───────────────────────────────────────────────────────────────────
async function handle(req, res) {
  securityHeaders(res, PORT);
  if (!guards.hostAllowed(req)) throw new HttpError(421, "Claudia Local only answers on 127.0.0.1 or localhost.");
  const url = (req.url || "/").split("?")[0];
  if (!url.startsWith("/api/")) {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
    return serveStatic(req, res, url);
  }
  if (req.method !== "GET" && req.method !== "HEAD" && !guards.originAllowed(req)) throw new HttpError(403, "Cross-origin request refused.");
  const rl = limit("api", 1200, 60_000);
  if (!rl.ok) throw new HttpError(429, "Too many requests.");
  if (await publicRoutes(req, res, url)) return;
  if (!vault.isUnlocked() || !guards.hasSession(req)) throw new HttpError(401, vault.exists() ? "Locked. Enter your passphrase." : "Set up Claudia Local first.", { locked: true });
  lastActive = Date.now();
  await privateRoutes(req, res, url);
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    const x = e instanceof HttpError ? { status: e.status, message: e.message, extra: e.extra } : cl.explain(e);
    if (x.status >= 500 && !(e.code)) log(`[http] ${req.method} ${(req.url || "").split("?")[0]} failed: ${e.stack || e.message}`);
    json(res, x.status || 500, { ok: false, error: x.message, code: x.code || e.code, ...(x.extra || {}) });
  });
});
server.requestTimeout = 180_000;
server.headersTimeout = 30_000;

// ── WebSocket ──────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const deny = (code, text) => { socket.write(`HTTP/1.1 ${code} ${text}\r\n\r\n`); socket.destroy(); };
  if ((req.url || "").split("?")[0] !== "/ws") return deny(404, "Not Found");
  if (!guards.hostAllowed(req) || !guards.wsOriginAllowed(req)) return deny(403, "Forbidden");
  if (!vault.isUnlocked() || !guards.hasSession(req)) return deny(401, "Unauthorized");
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  ws.isAlive = true;
  ws.on("pong", () => { ws.isAlive = true; });
  ws.on("message", (data) => {
    if (!vault.isUnlocked() || !guards.hasSession(req)) { try { ws.close(4401, "Locked"); } catch { /* */ } return; }
    lastActive = Date.now();
    let msg; try { msg = JSON.parse(data.toString()); } catch { return; }
    agent.onMessage(ws, msg).catch((e) => log("[ws] " + e.message));
  });
  ws.send(JSON.stringify({ type: "status", ready: true }));
});
const beat = setInterval(() => {
  for (const c of wss.clients) { if (!c.isAlive) { c.terminate(); continue; } c.isAlive = false; try { c.ping(); } catch { /* */ } }
}, 30_000);

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") { console.error(`Port ${PORT} is in use. Start with CLAUDIA_LOCAL_PORT=<another port> npm start`); process.exit(1); }
  throw e;
});
server.listen(PORT, HOST, () => {
  log(`Claudia Local ${VERSION} on http://${HOST}:${PORT} (data: ${HOME})`);
  if (!existsSync(join(DIST, "index.html"))) log("The dashboard isn't built yet. Run: npm run build");
});

function shutdown(sig) {
  log(`${sig}: shutting down`);
  clearInterval(beat);
  vault.lock();
  for (const c of wss.clients) { try { c.close(1001, "Closing"); } catch { /* */ } }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("unhandledRejection", (e) => log("unhandledRejection: " + (e?.stack || e)));
