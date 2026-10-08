/**
 * routes-studio.js — HTTP API for the creator studio (all behind the session cookie, see index.js),
 * plus the public OAuth callback page.
 *
 *   /api/keys…        Settings → Keys and providers (masked; values never come back)
 *   /api/chat/presets Settings → Chat model
 *   /api/studio/…     Generate: models, estimates, jobs, approvals, spend and caps, uploads, files, log
 *   /api/brand…       Claudia → Brand kit
 *   /api/social/…     Socials: networks, connections, posts, approvals, publishing, inbox, kill switch
 *   /api/campaigns…   Socials → Campaigns
 *   /api/mcp…         Settings → Local MCP
 *   GET /oauth/callback  where OAuth comes back (directly or via https://useclaudia.xyz/relay/oauth/callback)
 */
import { createReadStream, statSync } from "node:fs";
import { extname } from "node:path";
import { json, readJson, HttpError } from "./http.js";
import { getConfig, updateConfig } from "./store.js";
import * as vault from "./vault.js";
import * as providers from "./providers.js";
import * as M from "./studio-media.js";
import * as S from "./studio-social.js";
import * as studio from "./studio.js";
import * as campaigns from "./campaigns.js";
import * as mcp from "./mcp.js";

const qs = (req) => new URL(req.url, "http://x").searchParams;
const seg = (url, prefix) => url.slice(prefix.length).split("/").filter(Boolean).map(decodeURIComponent);

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `That's too big (max ${Math.round(limit / 1024 / 1024)} MB).`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Serve a library / upload / brand file, with Range support for video and audio. */
function serveFile(req, res, p) {
  const full = studio.safeMediaPath(p);
  const ext = extname(full).slice(1).toLowerCase();
  const type = studio.SERVE_TYPES[ext];
  const size = statSync(full).size;
  const headers = { "Content-Type": type || "application/octet-stream", "Cache-Control": "private, max-age=3600", "Accept-Ranges": "bytes" };
  if (!type) headers["Content-Disposition"] = "attachment";
  const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ""));
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2]);
    let end = range[1] && range[2] ? Number(range[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(size - 1, end);
    if (start > end) { res.writeHead(416, { "Content-Range": `bytes */${size}` }); return res.end(); }
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
    return createReadStream(full, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": size });
  if (req.method === "HEAD") return res.end();
  createReadStream(full).pipe(res);
}

const KEY_GROUP_FOR_ACTIVITY = (p) => p.name;

// ── /api/keys, /api/chat ───────────────────────────────────────────────────
async function keyRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/keys" && m === "GET") return json(res, 200, { groups: providers.GROUPS, providers: providers.listProviders() }), true;
  if (url === "/api/chat/presets" && m === "GET") return json(res, 200, { presets: providers.CHAT_PRESETS.map((c) => ({ ...c, keySet: providers.publicProvider(providers.BY_ID.get(c.key)).configured })) }), true;
  if (!url.startsWith("/api/keys/")) return false;
  const [id, action] = seg(url, "/api/keys/");
  const p = providers.BY_ID.get(id);
  if (!p) throw new HttpError(404, "Unknown provider.");
  if (!action && m === "POST") {
    const d = await readJson(req, 32 * 1024);
    const row = providers.saveProvider(id, d.fields || {});
    studio.logAction("keys", `${KEY_GROUP_FOR_ACTIVITY(p)} key saved (encrypted)`);
    return json(res, 200, row), true;
  }
  if (!action && m === "DELETE") {
    const row = providers.removeProvider(id);
    studio.logAction("keys", `${KEY_GROUP_FOR_ACTIVITY(p)} key removed`);
    return json(res, 200, row), true;
  }
  if (action === "test" && m === "POST") {
    const d = await readJson(req, 4 * 1024);
    const out = await providers.testProvider(id, { live: !!d.live });
    // For media providers, also show the request a generation would send (the package's own dry run).
    if (p.group === "media" && !d.live) {
      try {
        const md = await M.media();
        const model = md.models({ provider: id }).find((x) => !x.retired && x.kind === "image") || md.models({ provider: id }).find((x) => !x.retired);
        if (model) {
          const dr = await md.generate({ kind: model.kind, model: model.id, prompt: "A test image of a rose", text: "Testing", durationSec: model.kind === "video" ? 4 : undefined }, { dryRun: true });
          if (M.isDryRun(dr)) out.generateDryRun = { model: model.id, request: dr.request, estimate: dr.estimate };
        }
      } catch (e) { out.generateDryRunError = e.message; }
    }
    if (d.live) studio.logAction("keys", `${p.name} key checked with the provider: ${out.live?.message || "no check"}`);
    return json(res, 200, out), true;
  }
  throw new HttpError(404, "Unknown keys route");
}

// ── /api/studio ────────────────────────────────────────────────────────────
async function studioRoutes(req, res, url) {
  const m = req.method;
  const sub = url.slice("/api/studio".length);
  const body = (n = 256 * 1024) => readJson(req, n);
  if (sub === "/status" && m === "GET") return json(res, 200, await studio.status());
  if (sub === "/file" && (m === "GET" || m === "HEAD")) return serveFile(req, res, qs(req).get("path") || "");
  if (sub === "/log.jsonl" && m === "GET") {
    res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Content-Disposition": `attachment; filename="claudia-local-log-${new Date().toISOString().slice(0, 10)}.jsonl"`, "Cache-Control": "no-store" });
    return res.end(studio.exportLog());
  }
  if (sub === "/uploads" && m === "POST") {
    const buf = await readRaw(req, studio.MAX_UPLOAD);
    return json(res, 200, studio.saveUpload(buf, req.headers["content-type"], { brand: qs(req).get("to") === "brand" }));
  }
  if (sub === "/settings" && m === "POST") {
    const d = await body();
    const patch = {};
    if ("askBeforeAgentMedia" in d) patch.askBeforeAgentMedia = !!d.askBeforeAgentMedia;
    if (d.limits) patch.limits = d.limits;
    updateConfig({ studio: patch });
    if (d.limits) { await M.reconfigure().catch(() => {}); studio.logAction("caps", `Spending caps changed: ${JSON.stringify(getConfig().studio.limits)}`); }
    return json(res, 200, { limits: getConfig().studio.limits, askBeforeAgentMedia: getConfig().studio.askBeforeAgentMedia });
  }

  // Everything below needs @useclaudia/media.
  const md = await M.media();
  if (sub === "/models" && m === "GET") { const q = qs(req); return json(res, 200, { models: md.models({ kind: q.get("kind") || undefined, provider: q.get("provider") || undefined }) }); }
  if (sub === "/providers" && m === "GET") return json(res, 200, { providers: await md.providers() });
  if (sub === "/estimate" && m === "POST") { const d = await body(); return json(res, 200, md.estimate(studio.normalizeRequest(d.request || d))); }
  if (sub === "/generate" && m === "POST") {
    const d = await body();
    return json(res, 200, await studio.generate(d.request || {}, { approve: !!d.approve, dryRun: !!d.dryRun, source: "you" }));
  }
  if (sub === "/jobs" && m === "GET") { const q = qs(req); return json(res, 200, { jobs: md.listJobs({ status: q.get("status") || undefined, limit: Math.min(500, Number(q.get("limit")) || 100) }) }); }
  if (sub.startsWith("/jobs/")) {
    const [id, action] = seg(sub, "/jobs/");
    if (!action && m === "GET") { const j = md.getJob(id); return j ? json(res, 200, j) : json(res, 404, { error: "No such job" }); }
    if (action === "approve" && m === "POST") { const j = await md.approve(id); studio.logAction("job_approved", `You approved media job ${id} (estimate $${j.estimate?.usd ?? "?"})`, { jobId: id }); return json(res, 200, j); }
    if (action === "cancel" && m === "POST") { const j = await md.cancel(id); studio.logAction("job_canceled", `You canceled media job ${id}`, { jobId: id }); return json(res, 200, j); }
  }
  if (sub === "/spend" && m === "GET") return json(res, 200, { spend: md.spend(), limits: getConfig().studio.limits });
  if (sub === "/requests" && m === "GET") return json(res, 200, { requests: studio.listRequests() });
  if (sub.startsWith("/requests/")) {
    const [id, action] = seg(sub, "/requests/");
    if (action === "approve" && m === "POST") return json(res, 200, await studio.approveRequest(id));
    if (action === "reject" && m === "POST") { const d = await body(); return json(res, 200, studio.rejectRequest(id, d.why)); }
  }
  throw new HttpError(404, "Unknown studio route");
}

// ── /api/brand ─────────────────────────────────────────────────────────────
async function brandRoutes(req, res, url) {
  if (url === "/api/brand" && req.method === "GET") return json(res, 200, { brand: studio.getBrand(), voiceProviders: studio.VOICE_PROVIDERS });
  if (url === "/api/brand" && req.method === "POST") return json(res, 200, { brand: await studio.saveBrand(await readJson(req, 64 * 1024)) });
  throw new HttpError(404, "Unknown brand route");
}

// ── /api/social ────────────────────────────────────────────────────────────
async function socialRoutes(req, res, url) {
  const m = req.method;
  const sub = url.slice("/api/social".length);
  const body = (n = 256 * 1024) => readJson(req, n);
  if (sub === "/kill" && m === "GET") return json(res, 200, studio.kill());
  if (sub === "/kill" && m === "POST") { const d = await body(); return json(res, 200, await studio.setKill({ ...("posting" in d ? { posting: !!d.posting } : {}), ...("drafts" in d ? { drafts: !!d.drafts } : {}) })); }
  if (sub === "/caps" && m === "POST") { const d = await body(); updateConfig({ studio: { postCaps: d.postCaps || {} } }); studio.logAction("caps", "Daily post caps changed"); return json(res, 200, { postCaps: getConfig().studio.postCaps }); }

  const s = await S.social();
  if (sub === "/networks" && m === "GET") {
    return json(res, 200, { networks: s.networks(), accounts: s.accounts(), redirects: { loopback: S.loopbackRedirect(), relay: S.relayRedirect() }, today: studio.publishedToday(s), postCaps: getConfig().studio.postCaps, killSwitch: studio.kill() });
  }
  if (sub === "/connect" && m === "POST") {
    const d = await body(32 * 1024);
    const network = String(d.network || "");
    if (!s.networks().some((n) => n.id === network)) throw new HttpError(400, "Unknown network.");
    const params = Object.fromEntries(Object.entries(d.params || {}).filter(([k]) => /^[A-Za-z0-9_.-]{1,40}$/.test(k)).map(([k, v]) => [k, String(v).slice(0, 2000)]));
    const out = await s.connect(network, { ...providers.connectDefaults(network), ...params }, d.dryRun ? { dryRun: true } : undefined);
    if (S.isDryRun(out)) return json(res, 200, out);
    studio.logAction("connect", out.authorizeUrl ? `Started connecting ${network} (sign-in opened)` : `Connected ${network} as ${out.handle}`);
    return json(res, 200, out);
  }
  if (sub.startsWith("/accounts/") && m === "DELETE") {
    const [id] = seg(sub, "/accounts/");
    await s.disconnect(id);
    studio.logAction("disconnect", `Disconnected account ${id}`);
    return json(res, 200, { ok: true });
  }
  if (sub === "/posts" && m === "GET") { const q = qs(req); return json(res, 200, { posts: s.posts({ status: q.get("status") || undefined, limit: Math.min(1000, Number(q.get("limit")) || 300) }), accounts: s.accounts() }); }
  if (sub === "/posts" && m === "POST") {
    const d = await body();
    const input = studio.normalizePostInput(d.input || {}, s);
    let post = s.draft(input);
    if (d.submit) { post = s.submit(post.id); studio.logAction("draft", `You sent post ${post.id} to Approvals`, { postId: post.id }); }
    return json(res, 200, post);
  }
  if (sub.startsWith("/posts/")) {
    const [id, action] = seg(sub, "/posts/");
    if (!action && m === "POST") {
      const d = await body();
      const post = studio.findPost(s, id);
      if (!post) throw new HttpError(404, "That post is gone.");
      if (["published", "publishing", "partial"].includes(post.status)) throw new HttpError(409, "Published posts can't be edited.");
      let out = s.update(id, studio.normalizePostInput(d.input || {}, s, { partial: true }));
      if (post.status === "pending_approval" && out.status === "draft") out = s.submit(id); // stays in Approvals after an edit
      return json(res, 200, out);
    }
    if (!action && m === "GET") { const p = studio.findPost(s, id); return p ? json(res, 200, p) : json(res, 404, { error: "That post is gone." }); }
    if (action === "preview" && m === "GET") return json(res, 200, { previews: await studio.previewPost(id) });
    if (action === "submit" && m === "POST") { const p = s.submit(id); studio.logAction("draft", `You sent post ${id} to Approvals`, { postId: id }); return json(res, 200, p); }
    if (action === "approve" && m === "POST") { const d = await body(); return json(res, 200, await studio.approvePost(id, { publishNow: !!d.publishNow, at: Number(d.at) || undefined })); }
    if (action === "reject" && m === "POST") { const d = await body(); const p = s.reject(id, String(d.why || "").slice(0, 300)); studio.logAction("reject", `You rejected post ${id}`, { postId: id }); return json(res, 200, p); }
    if (action === "schedule" && m === "POST") { const d = await body(); const p = s.schedule(id, Number(d.at)); studio.logAction("schedule", `Scheduled post ${id} for ${new Date(Number(d.at)).toISOString()}`, { postId: id }); return json(res, 200, p); }
    if (action === "publish" && m === "POST") { const d = await body(); return json(res, 200, await studio.publishPost(id, { dryRun: !!d.dryRun })); }
  }
  if (sub === "/inbox" && m === "GET") {
    const since = Number(qs(req).get("since")) || Date.now() - 3 * 86400_000;
    return json(res, 200, { items: await s.inbox({ since }) });
  }
  if (sub === "/reply" && m === "POST") {
    const d = await body(32 * 1024);
    const text = String(d.text || "").trim().slice(0, 5000);
    if (!text) throw new HttpError(400, "Write a reply first.");
    if (!d.dryRun && studio.kill().posting) throw new HttpError(423, "The kill switch is on. Switch it off to reply.");
    const hits = studio.getBrand().useInSocial ? studio.bannedIn(text) : [];
    if (hits.length) throw new HttpError(400, `The reply uses banned phrases from the brand kit: ${hits.join(", ")}.`);
    const out = await s.reply(String(d.account || ""), String(d.to || ""), text, { dryRun: !!d.dryRun });
    studio.logAction(d.dryRun ? "reply_dry_run" : "reply", `${d.dryRun ? "Dry run of a reply" : "You replied"} on ${d.account} to ${d.to}`);
    return json(res, 200, out ?? { ok: true });
  }
  if (sub === "/analytics" && m === "GET") return json(res, 200, await studio.analytics());
  throw new HttpError(404, "Unknown social route");
}

// ── /api/campaigns ─────────────────────────────────────────────────────────
async function campaignRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/campaigns" && m === "GET") return json(res, 200, { campaigns: campaigns.list(), templates: Object.entries(campaigns.TEMPLATES).map(([id, t]) => ({ id, label: t.label, posts: t.posts.length })) });
  if (url === "/api/campaigns" && m === "POST") return json(res, 200, await campaigns.plan(await readJson(req, 32 * 1024)));
  const [id] = seg(url, "/api/campaigns/");
  if (id && m === "GET") { const c = campaigns.get(id); return c ? json(res, 200, c) : json(res, 404, { error: "No such campaign" }); }
  if (id && m === "DELETE") return json(res, 200, campaigns.remove(id));
  throw new HttpError(404, "Unknown campaign route");
}

// ── /api/mcp ───────────────────────────────────────────────────────────────
async function mcpRoutes(req, res, url) {
  const m = req.method;
  if (url === "/api/mcp" && m === "GET") return json(res, 200, mcp.info());
  if (url === "/api/mcp" && m === "POST") {
    const d = await readJson(req, 4 * 1024);
    const patch = {};
    if ("enabled" in d) patch.enabled = !!d.enabled;
    if ("port" in d) patch.port = Number(d.port);
    const out = await mcp.configure(patch);
    studio.logAction("mcp", `Local MCP ${out.enabled ? `on (port ${out.port})` : "off"}`);
    return json(res, 200, out);
  }
  if (url === "/api/mcp/token" && m === "POST") {
    const token = mcp.newToken();
    studio.logAction("mcp", "New local MCP token made (the old one stops working)");
    return json(res, 200, { token, ...mcp.info() });
  }
  throw new HttpError(404, "Unknown MCP route");
}

/** HTTP status for the packages' errors (ClaudiaMediaError / ClaudiaSocialError codes). */
const PKG_STATUS = { no_key: 409, rate_limited: 429, over_budget: 402, needs_approval: 409, provider_error: 502, unsupported: 400, expired: 410, blocked: 409, invalid: 400, not_installed: 503 };
export function explainPackageError(e) {
  if (!e || !(e.code in PKG_STATUS) || e instanceof HttpError) return null;
  return { status: e.status && e.status >= 400 && e.status < 600 ? e.status : PKG_STATUS[e.code], code: e.code, message: e.hint ? `${e.message} ${e.hint}` : e.message, extra: e.retryAfterMs ? { retryAfterMs: e.retryAfterMs } : {} };
}

/** Private routes for the studio. Returns true when it handled the request. */
export async function handleStudio(req, res, url) {
  if (url === "/api/keys" || url.startsWith("/api/keys/") || url === "/api/chat/presets") return keyRoutes(req, res, url);
  if (url.startsWith("/api/studio/")) { await studioRoutes(req, res, url); return true; }
  if (url === "/api/brand") { await brandRoutes(req, res, url); return true; }
  if (url.startsWith("/api/social/")) { await socialRoutes(req, res, url); return true; }
  if (url === "/api/campaigns" || url.startsWith("/api/campaigns/")) { await campaignRoutes(req, res, url); return true; }
  if (url === "/api/mcp" || url === "/api/mcp/token") { await mcpRoutes(req, res, url); return true; }
  return false;
}

// ── GET /oauth/callback (public) ───────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function page(res, code, title, text, ok) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · Claudia Local</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#120b10;color:#f8ece8;font:15px/1.5 system-ui,-apple-system,sans-serif;padding:24px;box-sizing:border-box}
.box{max-width:440px;width:100%;background:#1b1118;border:1px solid #34222e;border-left:3px solid ${ok ? "#3ddc97" : "#ff5a52"};border-radius:10px;padding:20px}
h1{font:400 28px/1.1 Georgia,serif;margin:0 0 8px}p{margin:0 0 14px;color:#d6bfc7}a{color:#ff6fa5}img{width:44px;height:44px;border-radius:50%;margin-bottom:10px}</style></head>
<body><div class="box"><img src="/claudia/avatar-96.webp" alt=""><h1>${esc(title)}</h1><p>${esc(text)}</p><a href="/socials/connections">Back to Socials</a></div></body></html>`);
}

/**
 * OAuth comes back here, either straight from the network (loopback redirect URI) or bounced by
 * https://useclaudia.xyz/relay/oauth/callback, which only ever redirects to 127.0.0.1. The session
 * cookie isn't sent on this cross-site navigation, so the `state` (random, made when you clicked
 * Connect, checked by the social package together with the PKCE verifier) is what ties it to you.
 */
export async function oauthCallback(req, res) {
  const q = qs(req);
  const state = q.get("state") || "", code = q.get("code") || "", error = q.get("error") || "";
  if (error) return page(res, 400, "Not connected", `The network said: ${(q.get("error_description") || error).slice(0, 300)}`, false);
  if (!/^[A-Za-z0-9_~-]{8,256}(\.\d{2,5})?$/.test(state) || !code || code.length > 4096) return page(res, 400, "Not connected", "This link is missing its sign-in code or it's malformed. Start again from Socials → Connections.", false);
  if (!vault.isUnlocked()) return page(res, 423, "Unlock first", "Claudia Local is locked, so it can't finish connecting. Unlock it, then click Connect again.", false);
  try {
    const s = await S.social();
    const acct = await s.completeOAuth(state, code);
    studio.logAction("connect", `Connected ${acct.network} as ${acct.handle}`);
    const name = s.networks().find((n) => n.id === acct.network)?.name || acct.network;
    return page(res, 200, "Connected", `Your ${name} account ${acct.handle} is connected${acct.expiresAt ? ` until ${new Date(acct.expiresAt).toISOString().slice(0, 10)}` : ""}. You can close this tab.`, true);
  } catch (e) {
    return page(res, e.status === 503 ? 503 : 400, "Not connected", `${e.message}${e.hint ? ` ${e.hint}` : ""}`.slice(0, 400), false);
  }
}
