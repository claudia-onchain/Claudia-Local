/**
 * routes-core.js — HTTP API for models, memory, skills, MCP servers, the setup wizard and health
 * (all behind the session cookie, see index.js).
 *
 *   GET  /api/chat/presets                 chat providers, with local servers detected (Ollama, LM Studio)
 *   GET  /api/chat/local                   which local model servers are running
 *   GET  /api/models?provider=             a provider's models (live list or the built-in one)
 *   GET  /api/chat/spend                   this month's estimated spend per provider, and the caps
 *   POST /api/keys/import-env              { text, apply?, only? } preview or save keys from a .env file
 *   GET  /api/memory  ?q&type              search · POST { content, type, tags } · DELETE /api/memory/:id
 *   GET  /api/memory/files                 MEMORY.md, USER.md, daily notes
 *   GET  /api/memory/file?name=            one file · POST { name, content } saves it
 *   GET  /api/memory/quarantine            memory proposed from outside content
 *   POST /api/memory/quarantine/:id/approve · DELETE /api/memory/quarantine/:id
 *   GET  /api/skills                       installed (with "changed on disk")
 *   GET  /api/skills/library ?category&tag&q   Claudia's skill library
 *   POST /api/skills/install { slug }      from the library (the contract other code relies on)
 *   POST /api/skills/install-folder { path }
 *   POST /api/skills/review { url }        GitHub: every file listed before install
 *   POST /api/skills/install-reviewed { token }
 *   GET  /api/skills/:slug · POST /api/skills/:slug { enabled } · POST /api/skills/:slug/repin · DELETE
 *   GET  /api/mcp-clients · POST /api/mcp-clients (add) · POST /api/mcp-clients/:id (patch)
 *   POST /api/mcp-clients/:id/refresh · DELETE /api/mcp-clients/:id
 *   POST /api/wizard/done · POST /api/wizard/restart
 *   GET  /api/health/report · POST /api/health/fix { id }
 */
import { json, readJson, HttpError } from "./http.js";
import * as store from "./store.js";
import * as mem from "./memory.js";
import * as skills from "./skills.js";
import * as mcpc from "./mcp-client.js";
import * as health from "./health.js";
import * as providers from "./providers.js";
import { listModels, spendSummary } from "./model.js";

const qs = (req) => new URL(req.url, "http://x").searchParams;
const seg = (url, prefix) => url.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);

/** `ctx`: { version, boundHost(), onConfigChange() } from index.js. */
export function createCoreRoutes(ctx) {
  return async function handleCore(req, res, url) {
    const m = req.method;
    const body = (limit = 64 * 1024) => readJson(req, limit);

    // ── models ─────────────────────────────────────────────────────────────
    if (url === "/api/chat/presets" && m === "GET") {
      const local = await providers.detectLocal();
      return json(res, 200, { presets: providers.CHAT_PRESETS.map(c => ({ ...providers.publicPreset(c), ...(c.kind === "local" ? { running: !!local[c.id]?.running, localModels: local[c.id]?.models || [] } : {}) })) }), true;
    }
    if (url === "/api/chat/local" && m === "GET") return json(res, 200, await providers.detectLocal({ fresh: true })), true;
    if (url === "/api/models" && m === "GET") {
      const prov = qs(req).get("provider") || store.getConfig().chat.provider;
      if (!prov) return json(res, 200, { models: [], error: "Pick a provider first." }), true;
      return json(res, 200, await listModels(prov, store.getConfig())), true;
    }
    if (url === "/api/chat/spend" && m === "GET") return json(res, 200, spendSummary(store.getConfig())), true;
    if (url === "/api/keys/import-env" && m === "POST") {
      const d = await body(256 * 1024);
      const r = providers.importEnv(String(d.text || ""), { apply: !!d.apply, only: Array.isArray(d.only) ? d.only : null });
      if (d.apply) store.trackActivity("settings", `Imported ${r.saved.length} key${r.saved.length === 1 ? "" : "s"} from a .env file`);
      return json(res, 200, r), true;
    }

    // ── memory ─────────────────────────────────────────────────────────────
    if (url === "/api/memory" && m === "GET") { const q = qs(req); return json(res, 200, { memories: store.searchMemories(q.get("q") || "", { type: q.get("type") || "", limit: 200 }).map(({ start, end, ...e }) => e), total: store.listMemories().length, quarantined: mem.quarantine().length }), true; }
    if (url === "/api/memory" && m === "POST") { const d = await body(); return json(res, 200, { entry: store.addMemory(d.content, d.type, d.tags, { source: "user" }) }), true; }
    if (url === "/api/memory/files" && m === "GET") return json(res, 200, { files: mem.listFiles(), today: new Date().toISOString().slice(0, 10) + ".md" }), true;
    if (url === "/api/memory/file" && m === "GET") { const name = qs(req).get("name"); return json(res, 200, { name, content: mem.readFile(name) }), true; }
    if (url === "/api/memory/file" && m === "POST") { const d = await body(600 * 1024); const r = mem.saveFile(d.name, d.content); store.trackActivity("memory", `Edited ${r.name}`); return json(res, 200, r), true; }
    if (url === "/api/memory/quarantine" && m === "GET") return json(res, 200, { items: mem.quarantine() }), true;
    if (url.startsWith("/api/memory/quarantine/")) {
      const [id, action] = seg(url, "/api/memory/quarantine/");
      if (m === "POST" && action === "approve") { const e = mem.approve(id); store.trackActivity("memory", `Approved a memory from ${e.source}`); return json(res, 200, { entry: e }), true; }
      if (m === "DELETE" && !action) return json(res, 200, { ok: mem.reject(id) }), true;
    }
    if (url.startsWith("/api/memory/") && m === "DELETE") return json(res, 200, { ok: store.deleteMemory(decodeURIComponent(url.slice(12))) }), true;

    // ── skills ─────────────────────────────────────────────────────────────
    if (url === "/api/skills" && m === "GET") return json(res, 200, { skills: skills.list() }), true;
    if (url === "/api/skills/library" && m === "GET") { const q = qs(req); return json(res, 200, await skills.library({ category: q.get("category") || "", tag: q.get("tag") || "", q: q.get("q") || "" })), true; }
    if (url === "/api/skills/install" && m === "POST") {
      const slug = String((await body()).slug || "");
      try { return json(res, 200, { ok: true, skill: await skills.installFromLibrary(slug) }), true; } catch (e) {
        // The library is down or unreachable: keep the slug and try again on the next unlock.
        if (e.status && e.status !== 502) throw e;
        const c = store.getConfig();
        c.pendingSkills = [...new Set([...(Array.isArray(c.pendingSkills) ? c.pendingSkills : []), slug])].slice(0, 100);
        store.saveConfig(c);
        return json(res, 202, { ok: true, pending: true, message: `The skill library isn't reachable right now (${e.message}). ${slug} installs the next time you unlock.` }), true;
      }
    }
    if (url === "/api/skills/install-folder" && m === "POST") { const d = await body(); return json(res, 200, { ok: true, skill: skills.installFromFolder(d.path) }), true; }
    if (url === "/api/skills/review" && m === "POST") { const d = await body(); return json(res, 200, await skills.review(d.url)), true; }
    if (url === "/api/skills/install-reviewed" && m === "POST") { const d = await body(); return json(res, 200, { ok: true, skill: skills.installReviewed(d.token) }), true; }
    if (url.startsWith("/api/skills/")) {
      const [slug, action] = seg(url, "/api/skills/");
      if (!skills.SLUG.test(slug || "")) throw new HttpError(400, "Bad skill name.");
      if (m === "GET" && !action) return json(res, 200, skills.get(slug)), true;
      if (m === "GET" && action === "file") return json(res, 200, { path: qs(req).get("path"), content: skills.readSkillFile(slug, qs(req).get("path")) }), true;
      if (m === "POST" && !action) { const d = await body(); return json(res, 200, skills.setEnabled(slug, !!d.enabled)), true; }
      if (m === "POST" && action === "repin") return json(res, 200, skills.repin(slug)), true;
      if (m === "DELETE" && !action) return json(res, 200, { ok: skills.remove(slug) }), true;
    }

    // ── MCP servers for the agent ──────────────────────────────────────────
    if (url === "/api/mcp-clients" && m === "GET") return json(res, 200, { servers: mcpc.list() }), true;
    if (url === "/api/mcp-clients" && m === "POST") { const d = await body(); return json(res, 200, await mcpc.add(d)), true; }
    if (url.startsWith("/api/mcp-clients/")) {
      const [id, action] = seg(url, "/api/mcp-clients/");
      if (m === "POST" && action === "refresh") return json(res, 200, await mcpc.refresh(id)), true;
      if (m === "POST" && !action) { const d = await body(); return json(res, 200, await mcpc.update(id, d)), true; }
      if (m === "DELETE" && !action) return json(res, 200, { ok: await mcpc.remove(id) }), true;
    }

    // ── wizard ─────────────────────────────────────────────────────────────
    if (url === "/api/wizard/done" && m === "POST") { store.updateConfig({ wizardPending: false }); store.trackActivity("app", "Setup finished"); return json(res, 200, { ok: true }), true; }
    if (url === "/api/wizard/restart" && m === "POST") { store.updateConfig({ wizardPending: true }); return json(res, 200, { ok: true }), true; }

    // ── health ─────────────────────────────────────────────────────────────
    if (url === "/api/health/report" && m === "GET") return json(res, 200, await health.runChecks({ boundHost: ctx.boundHost(), version: ctx.version, online: qs(req).get("online") !== "0" })), true;
    if (url === "/api/health/fix" && m === "POST") {
      const d = await body();
      const f = health.applyFix(String(d.id || ""));
      store.trackActivity("settings", `Health fix: ${f.label}`);
      await ctx.onConfigChange?.();
      return json(res, 200, await health.runChecks({ boundHost: ctx.boundHost(), version: ctx.version, online: false })), true;
    }
    return false;
  };
}
