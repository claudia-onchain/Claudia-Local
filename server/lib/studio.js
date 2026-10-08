/**
 * studio.js — the creator studio's glue: what Claudia Local adds on top of @useclaudia/media and
 * @useclaudia/social, shared by the dashboard routes, the chat agent and the local MCP server.
 *
 *   brand kit        Claudia's portraits, voice, tone guide and banned phrases (brand.json)
 *   media requests   media the agent, MCP or a campaign asked for; nothing is generated (or paid
 *                    for) until you approve it in Socials → Approvals (media-requests.json)
 *   posts            drafting, previews with your banned phrases and caps, approve, publish
 *   kill switch      "Stop all posting" (and, if you choose, no new drafts from the agent or MCP)
 *   action log       studio-log.jsonl, exported together with the social package's audit log
 *   files            uploads (refs, portraits) and the only folders media may come from
 *
 * Publishing is only reachable from the dashboard (session cookie). The agent and MCP can draft,
 * preview and read; their drafts land in Approvals.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync, chmodSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { P, ensurePrivateDir } from "./paths.js";
import { getConfig, updateConfig, readJsonFile, writeJsonFile, newId, trackActivity } from "./store.js";
import * as wsp from "./workspace.js";
import * as vault from "./vault.js";
import * as M from "./studio-media.js";
import * as S from "./studio-social.js";

const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const clip = (s, n = 120) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

// ── wiring ─────────────────────────────────────────────────────────────────
let broadcast = () => {};
let log = () => {};
const emit = (topic, data) => { try { broadcast({ type: "studio", topic, data }); } catch { /* */ } };

export function init(opts) {
  broadcast = opts.broadcast || broadcast;
  log = opts.log || log;
  S.setPort(opts.port);
  M.onJob(onJob);
  S.on("post", (p) => emit("post", p));
  S.on("account", (a) => emit("account", a));
  // Scheduled posts: the social package publishes what's due (approved + scheduled) when we tick.
  setInterval(tick, 30_000).unref();
}

/** Load both packages after unlock so scheduled posts and running jobs carry on. */
export async function warm() {
  await M.media().then(syncBrand).catch(() => {});
  await S.social().catch(() => {});
}

async function tick() {
  if (!vault.isUnlocked() || kill().posting) return;
  const s = S.loaded();
  if (!s?.tick) return;
  try { await s.tick(); } catch (e) { log(`[social] tick: ${e.message}`); }
}

export async function status() {
  const [media, social] = await Promise.all([M.status(), S.status()]);
  return { media, social, killSwitch: kill(), askBeforeAgentMedia: getConfig().studio.askBeforeAgentMedia, redirects: { loopback: S.loopbackRedirect(), relay: S.relayRedirect() } };
}

// ── action log ─────────────────────────────────────────────────────────────
/** One line per studio action. Never put a secret in `meta`. */
export function logAction(kind, text, meta = {}) {
  const e = { ts: new Date().toISOString(), kind, text: String(text).slice(0, 500), ...meta };
  try { appendFileSync(P.studioLog, JSON.stringify(e) + "\n", { mode: 0o600 }); } catch { /* */ }
  trackActivity("studio", e.text);
}

/** JSONL: our action log plus the social package's audit log, oldest first. */
export function exportLog() {
  const read = (file, source) => {
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8").split("\n").filter(Boolean).slice(-20_000).map((l) => {
      try { const o = JSON.parse(l); return { source, ...o }; } catch { return null; }
    }).filter(Boolean);
  };
  const all = [...read(P.studioLog, "local"), ...read(join(P.social, "audit.jsonl"), "social")];
  const t = (o) => (typeof o.ts === "number" ? o.ts : Date.parse(o.ts || o.at || 0) || 0);
  return all.sort((a, b) => t(a) - t(b)).map((o) => JSON.stringify(o)).join("\n") + (all.length ? "\n" : "");
}

// ── files: uploads and where media may come from ───────────────────────────
const ROOTS = () => [P.media, P.uploads, P.brandDir, P.workspace];
const real = (p) => { try { return realpathSync(p); } catch { return null; } };

/**
 * An existing file inside the studio library, your uploads, the brand kit or the workspace, as a real
 * absolute path. Workspace paths like /notes/pic.png work too. Anything else is refused, so a draft can't
 * attach a file from elsewhere on the computer.
 */
export function safeMediaPath(p) {
  const s = String(p ?? "").trim();
  if (!s || s.includes("\0")) throw err(400, "Missing file path.");
  const inRoots = (full) => {
    const r = real(full);
    if (!r) return null;
    return ROOTS().some((root) => { const rr = real(root); return rr && (r === rr || r.startsWith(rr + sep)); }) ? r : null;
  };
  const hit = inRoots(resolve(s));
  if (hit && statSync(hit).isFile()) return hit;
  try {
    const w = inRoots(wsp.resolveInside(s));
    if (w && statSync(w).isFile()) return w;
  } catch { /* not a workspace path */ }
  throw err(403, "Only files from the studio library, your uploads, the brand kit or the workspace can be used.");
}

const UPLOAD_TYPES = {
  "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif",
  "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm",
  "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/mp4": "m4a", "audio/ogg": "ogg",
};
export const SERVE_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", mp3: "audio/mpeg", wav: "audio/wav", m4a: "audio/mp4", ogg: "audio/ogg" };
export const MAX_UPLOAD = 100 * 1024 * 1024;

function sniff(buf, mime) {
  const h = buf.subarray(0, 12);
  if (mime === "image/png") return h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47;
  if (mime === "image/jpeg") return h[0] === 0xff && h[1] === 0xd8;
  if (mime === "image/gif") return h.subarray(0, 4).toString() === "GIF8";
  if (mime === "image/webp") return h.subarray(0, 4).toString() === "RIFF" && h.subarray(8, 12).toString() === "WEBP";
  return true;
}

/** Saves an upload to uploads/ (refs) or brand/ (portraits). Returns { path, mime, bytes }. */
export function saveUpload(buf, mime, { brand = false } = {}) {
  const m = String(mime || "").split(";")[0].trim().toLowerCase();
  const ext = UPLOAD_TYPES[m];
  if (!ext) throw err(415, "Upload a PNG, JPEG, WEBP, GIF, MP4, MOV, WEBM, MP3, WAV, M4A or OGG file.");
  if (brand && !m.startsWith("image/")) throw err(415, "Portraits must be images.");
  if (!buf.length) throw err(400, "The file is empty.");
  if (!sniff(buf, m)) throw err(415, "The file doesn't match its type.");
  const dir = brand ? P.brandDir : P.uploads;
  ensurePrivateDir(dir);
  const path = join(dir, `${newId(brand ? "b_" : "u_")}.${ext}`);
  writeFileSync(path, buf, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* */ }
  logAction("upload", `Uploaded ${brand ? "a brand portrait" : "a reference file"} (${Math.round(buf.length / 1024)} KB)`);
  return { path, mime: m, bytes: buf.length };
}

// ── brand kit ──────────────────────────────────────────────────────────────
export const BRAND_ID = "claudia";
const DEFAULT_BRAND = { id: BRAND_ID, name: "Claudia", refs: [], voice: { provider: "", voiceId: "" }, style: "", banned: [], useInChat: true, useInSocial: true };
export const VOICE_PROVIDERS = ["elevenlabs", "openai", "google"];

export function getBrand() {
  const b = readJsonFile(P.brand, {});
  return { ...DEFAULT_BRAND, ...b, voice: { ...DEFAULT_BRAND.voice, ...(b.voice || {}) }, refs: (b.refs || []).filter((r) => existsSync(r)) };
}

export async function saveBrand(patch = {}) {
  const b = getBrand();
  if ("name" in patch) b.name = String(patch.name || "Claudia").trim().slice(0, 60) || "Claudia";
  if ("style" in patch) b.style = String(patch.style || "").slice(0, 4000);
  if ("banned" in patch) {
    const list = Array.isArray(patch.banned) ? patch.banned : String(patch.banned || "").split("\n");
    b.banned = [...new Set(list.map((x) => String(x).trim().slice(0, 80)).filter(Boolean))].slice(0, 100);
  }
  if ("refs" in patch) b.refs = (Array.isArray(patch.refs) ? patch.refs : []).slice(0, 8).map(safeMediaPath);
  if (patch.voice && typeof patch.voice === "object") {
    const provider = String(patch.voice.provider || "");
    if (provider && !VOICE_PROVIDERS.includes(provider)) throw err(400, "Pick ElevenLabs, OpenAI or Google for the voice.");
    const voiceId = String(patch.voice.voiceId || "").trim();
    if (voiceId && !/^[A-Za-z0-9_.:\- ]{1,120}$/.test(voiceId)) throw err(400, "That voice id doesn't look right.");
    b.voice = { provider, voiceId };
  }
  if ("useInChat" in patch) b.useInChat = !!patch.useInChat;
  if ("useInSocial" in patch) b.useInSocial = !!patch.useInSocial;
  writeJsonFile(P.brand, b);
  await syncBrand().catch(() => {});
  logAction("brand", "Brand kit saved");
  return b;
}

/** The media package keeps its own copy (used when a request says brand: "claudia"). */
async function syncBrand() {
  const m = await M.media().catch(() => null);
  if (!m?.brands?.save) return;
  const b = getBrand();
  m.brands.save({ id: b.id, name: b.name, refs: b.refs, voice: b.voice.provider ? b.voice : undefined, style: b.style || undefined, banned: b.banned });
}

/** Banned phrases found in a text (case-insensitive). */
export function bannedIn(text) {
  const t = String(text || "").toLowerCase();
  return getBrand().banned.filter((p) => t.includes(p.toLowerCase()));
}

/** A few lines for the chat agent's system prompt (empty when switched off). */
export function brandForChat() {
  const b = getBrand();
  if (!b.useInChat || (!b.style && !b.banned.length)) return "";
  return [b.style ? `Tone guide for anything written as ${b.name}:\n${clip(b.style, 2000)}` : "", b.banned.length ? `Never use these phrases: ${b.banned.map((x) => `"${x}"`).join(", ")}.` : ""].filter(Boolean).join("\n");
}

// ── media ──────────────────────────────────────────────────────────────────
export const KINDS = ["image", "video", "speech", "music", "sfx", "avatar"];
const ASPECTS = ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"];

/** Validates a GenerateRequest from the dashboard, the agent or MCP. */
export function normalizeRequest(x = {}) {
  const kind = String(x.kind || "");
  if (!KINDS.includes(kind)) throw err(400, `kind must be one of ${KINDS.join(", ")}.`);
  const r = { kind };
  if (x.model) { const m = String(x.model).trim(); if (!/^[A-Za-z0-9._\-/:@]{1,120}$/.test(m)) throw err(400, "That model id doesn't look right."); r.model = m; }
  if (x.prompt) r.prompt = String(x.prompt).slice(0, 4000);
  if (x.negativePrompt) r.negativePrompt = String(x.negativePrompt).slice(0, 2000);
  if (x.text) r.text = String(x.text).slice(0, 5000);
  if (x.voice) r.voice = String(x.voice).slice(0, 120);
  if (x.aspect) { if (!ASPECTS.includes(x.aspect)) throw err(400, `aspect must be one of ${ASPECTS.join(", ")}.`); r.aspect = x.aspect; }
  if (x.resolution) r.resolution = String(x.resolution).slice(0, 20);
  if (x.durationSec !== undefined && x.durationSec !== null && x.durationSec !== "") { const d = Number(x.durationSec); if (!(d > 0 && d <= 600)) throw err(400, "durationSec must be between 1 and 600."); r.durationSec = d; }
  if (x.n !== undefined) r.n = Math.max(1, Math.min(4, Math.round(Number(x.n)) || 1));
  if (x.seed !== undefined && x.seed !== null && x.seed !== "") r.seed = Math.round(Number(x.seed)) || 0;
  if (Array.isArray(x.refs) && x.refs.length) r.refs = x.refs.slice(0, 8).map((ref) => (/^https:\/\//i.test(String(ref)) ? String(ref).slice(0, 2000) : safeMediaPath(ref)));
  if (x.brand) {
    r.brand = BRAND_ID;
    const b = getBrand();
    if ((kind === "speech" || kind === "avatar") && !r.voice && b.voice.voiceId) r.voice = b.voice.voiceId;
  }
  if (!r.prompt && !r.text) throw err(400, kind === "speech" ? "Write the text to speak." : "Write a prompt.");
  if (x.meta && typeof x.meta === "object") r.meta = JSON.parse(JSON.stringify(x.meta).slice(0, 4000));
  return r;
}

/** Generate from the dashboard (or the agent/MCP when you switched off "ask first"). */
export async function generate(input, { approve = false, dryRun = false, source = "you" } = {}) {
  const m = await M.media();
  const req = normalizeRequest(input);
  const out = await m.generate(req, { dryRun, approve });
  if (!M.isDryRun(out)) {
    logAction("generate", `${source === "you" ? "You" : source === "mcp" ? "MCP" : "The agent"} started ${req.kind} with ${out.model} (estimate $${out.estimate?.usd ?? "?"}): ${clip(req.prompt || req.text, 80)}`, { jobId: out.id, status: out.status, model: out.model, usd: out.estimate?.usd });
    emit("job", out);
  }
  return out;
}

export const listRequests = () => readJsonFile(P.requests, []);
const saveRequests = (all) => writeJsonFile(P.requests, all.slice(0, 500));

/** Media someone other than you asked for: waits for your approval, costs nothing until then. */
export async function addRequest({ source, request, note = "", campaignId, postId }) {
  const m = await M.media();
  const req = normalizeRequest(request);
  let estimate = null;
  try { estimate = m.estimate(req); } catch (e) { estimate = { usd: null, basis: e.message, confidence: "estimate" }; }
  const r = { id: newId("mr_"), source, request: req, estimate, note: clip(note, 300), campaignId, postId, status: "pending", createdAt: Date.now(), updatedAt: Date.now() };
  saveRequests([r, ...listRequests()]);
  emit("request", r);
  logAction("media_request", `${source === "campaign" ? "A campaign" : source === "mcp" ? "MCP" : "The agent"} asked for ${req.kind}: ${clip(req.prompt || req.text, 80)}`, { requestId: r.id, usd: estimate?.usd });
  return r;
}

export async function approveRequest(id) {
  const all = listRequests();
  const r = all.find((x) => x.id === id);
  if (!r) throw err(404, "That request is gone.");
  if (r.status !== "pending") throw err(409, `Already ${r.status}.`);
  const m = await M.media();
  const job = await m.generate(r.request, { approve: true });
  Object.assign(r, { status: "approved", jobId: job.id, updatedAt: Date.now() });
  saveRequests(all);
  emit("request", r);
  logAction("media_request_approved", `You approved a ${r.request.kind} request (estimate $${r.estimate?.usd ?? "?"})`, { requestId: id, jobId: job.id });
  return { request: r, job };
}

export function rejectRequest(id, why = "") {
  const all = listRequests();
  const r = all.find((x) => x.id === id);
  if (!r) throw err(404, "That request is gone.");
  Object.assign(r, { status: "rejected", why: clip(why, 300), updatedAt: Date.now() });
  saveRequests(all);
  emit("request", r);
  logAction("media_request_rejected", `You rejected a ${r.request.kind} request`, { requestId: id });
  return r;
}

/** Job events: tell the dashboard, and attach finished campaign media to its draft. */
async function onJob(j) {
  emit("job", j);
  if (["succeeded", "failed", "blocked", "expired", "canceled"].includes(j.status)) {
    logAction(`job_${j.status}`, `Media job ${j.status}: ${j.model}${j.provenance?.costUsd !== undefined ? ` ($${j.provenance.costUsd})` : ""}`, { jobId: j.id });
  }
  if (j.status !== "succeeded") return;
  const all = listRequests();
  const r = all.find((x) => x.jobId === j.id && x.postId && !x.attached);
  if (!r) return;
  try {
    const s = await S.social();
    const post = findPost(s, r.postId);
    if (post) {
      const media = [...(post.input.media || []), ...j.outputs.map((o) => ({ path: o.path, mime: o.mime, alt: clip(r.request.prompt, 200) }))];
      s.update(r.postId, { media });
      r.attached = true;
      saveRequests(all);
    }
  } catch (e) { log(`[studio] attaching media to ${r.postId}: ${e.message}`); }
}

// ── posts ──────────────────────────────────────────────────────────────────
export const kill = () => getConfig().studio.killSwitch;

export async function setKill(patch) {
  updateConfig({ studio: { killSwitch: patch } });
  const k = kill();
  const s = S.loaded();
  if (s?.killSwitch) s.killSwitch(!!k.posting);
  logAction("kill_switch", k.posting ? `Kill switch ON: nothing publishes${k.drafts ? ", and the agent can't draft" : ""}` : "Kill switch off: approved posts can publish again");
  emit("kill", k);
  return k;
}

export const findPost = (s, id) => (s.getPost ? s.getPost(id) : s.posts({ limit: 5000 }).find((p) => p.id === id)) || null;

/** Validates a PostInput. `partial` for updates. */
export function normalizePostInput(x = {}, s, { partial = false } = {}) {
  const out = {};
  if (!partial || "text" in x) out.text = String(x.text ?? "").slice(0, 10_000);
  if ("media" in x) out.media = (Array.isArray(x.media) ? x.media : []).slice(0, 10).map((m) => ({ path: safeMediaPath(typeof m === "string" ? m : m?.path), ...(m?.mime ? { mime: String(m.mime).slice(0, 60) } : {}), ...(m?.alt ? { alt: String(m.alt).slice(0, 1000) } : {}) }));
  if ("link" in x) {
    if (x.link && !/^https?:\/\/[^\s]{3,2000}$/i.test(String(x.link))) throw err(400, "The link must start with https://");
    out.link = x.link ? String(x.link) : undefined;
  }
  if ("thread" in x) out.thread = (Array.isArray(x.thread) ? x.thread : []).map((t) => String(t).slice(0, 10_000)).filter(Boolean).slice(0, 25);
  if (x.replyTo && typeof x.replyTo === "object") out.replyTo = { network: String(x.replyTo.network).slice(0, 20), id: String(x.replyTo.id).slice(0, 200) };
  if ("targets" in x || !partial) {
    const known = new Set(s.accounts().map((a) => a.id));
    out.targets = (Array.isArray(x.targets) ? x.targets : []).slice(0, 30).map((t) => {
      const account = String(typeof t === "string" ? t : t?.account || "");
      if (!known.has(account)) throw err(400, `Unknown account: ${account || "(empty)"}. Connect it under Socials → Connections.`);
      return { account, ...(t?.text ? { text: String(t.text).slice(0, 10_000) } : {}) };
    });
    if (!out.targets.length && !partial) throw err(400, "Pick at least one account to post to.");
  }
  if ("scheduleAt" in x) {
    const at = x.scheduleAt ? (typeof x.scheduleAt === "number" ? x.scheduleAt : Date.parse(x.scheduleAt)) : undefined;
    if (at !== undefined && !(at > Date.now() - 60_000 && at < Date.now() + 366 * 86400_000)) throw err(400, "Schedule it between now and a year from now.");
    out.scheduleAt = at;
  }
  // Per-network settings the social package understands (YouTube title, TikTok privacy, Pinterest board…).
  if (x.options && typeof x.options === "object") {
    out.options = {};
    for (const [net, o] of Object.entries(x.options).slice(0, 20)) {
      if (!/^[a-z-]{1,20}$/.test(net) || !o || typeof o !== "object") continue;
      out.options[net] = Object.fromEntries(Object.entries(o).slice(0, 20).filter(([k, v]) => /^[A-Za-z0-9_]{1,40}$/.test(k) && ["string", "number", "boolean"].includes(typeof v)).map(([k, v]) => [k, typeof v === "string" ? v.slice(0, 5000) : v]));
    }
  }
  // Only send nfa/ad when switched on: the package adds "not financial advice" by itself when a post talks about a coin.
  if (x.labels && typeof x.labels === "object") out.labels = { ai: x.labels.ai !== false, ...(x.labels.ad ? { ad: true } : {}), ...(x.labels.nfa ? { nfa: true } : {}) };
  else if (!partial) out.labels = { ai: true };
  return out;
}

/** Previews from the package, plus your banned phrases and your own daily caps. */
export async function previewPost(id) {
  const s = await S.social();
  const pv = await s.preview(id);
  const b = getBrand();
  const caps = getConfig().studio.postCaps || {};
  const today = publishedToday(s);
  return pv.map((p) => {
    const extra = { ...p, warnings: [...(p.warnings || [])] };
    const hits = b.useInSocial ? bannedIn(p.text) : [];
    if (hits.length && !extra.blocked) extra.blocked = `Uses a banned phrase from the brand kit: ${hits.map((h) => `"${h}"`).join(", ")}.`;
    const cap = caps[p.network];
    if (cap > 0 && (today[p.network] || 0) >= cap && !extra.blocked) extra.blocked = `Your daily cap for ${p.network} (${cap}) is reached.`;
    return extra;
  });
}

/** Posts published today per network. */
export function publishedToday(s) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const out = {};
  for (const p of s.posts({ limit: 5000 })) for (const r of p.results || []) if (r.status === "published" && (r.at || p.updatedAt) >= start.getTime()) out[r.network] = (out[r.network] || 0) + 1;
  return out;
}

export async function approvePost(id, { publishNow = false, at } = {}) {
  const s = await S.social();
  const post = findPost(s, id);
  if (!post) throw err(404, "That post is gone.");
  if (post.status === "draft") s.submit(id);
  const pv = await previewPost(id);
  const blocked = pv.filter((p) => p.blocked);
  if (blocked.length) throw err(409, blocked.map((p) => `${p.network}: ${p.blocked}`).join(" "), "blocked");
  let out = s.approve(id);
  logAction("approve", `You approved post ${id}`, { postId: id });
  const when = at || post.input.scheduleAt;
  if (when && when > Date.now() + 30_000) {
    out = s.schedule(id, when);
    logAction("schedule", `Scheduled post ${id} for ${new Date(when).toISOString()}`, { postId: id, at: when });
  } else if (publishNow) {
    out = await publishPost(id, {});
  }
  return out;
}

export async function publishPost(id, { dryRun = false } = {}) {
  const s = await S.social();
  const post = findPost(s, id);
  if (!post) throw err(404, "That post is gone.");
  if (!dryRun) {
    if (kill().posting) throw err(423, "The kill switch is on. Switch it off on the Socials page to publish.", "killed");
    if (!["approved", "scheduled"].includes(post.status)) throw err(409, "Approve it first.", "needs_approval");
    const blocked = (await previewPost(id)).filter((p) => p.blocked);
    if (blocked.length) throw err(409, blocked.map((p) => `${p.network}: ${p.blocked}`).join(" "), "blocked");
  }
  const out = await s.publish(id, { dryRun });
  logAction(dryRun ? "publish_dry_run" : "publish", dryRun ? `Dry run of post ${id}` : `Published post ${id}: ${out.status}`, { postId: id });
  return out;
}

/** Resolve "x", "bluesky" or account ids to account ids; empty = every connected account. */
export function resolveAccounts(s, list) {
  const accounts = s.accounts();
  if (!accounts.length) throw err(409, "No social accounts are connected yet. Connect one under Socials → Connections.");
  const want = (Array.isArray(list) ? list : list ? [list] : []).map((x) => String(x).trim().toLowerCase()).filter(Boolean);
  if (!want.length) return accounts.map((a) => a.id);
  const ids = new Set();
  for (const w of want) {
    const hits = accounts.filter((a) => a.id.toLowerCase() === w || a.network === w || a.handle?.toLowerCase() === w.replace(/^@/, ""));
    if (!hits.length) throw err(400, `No connected account matches "${w}". Connected: ${accounts.map((a) => `${a.network} ${a.handle}`).join(", ")}.`);
    hits.forEach((a) => ids.add(a.id));
  }
  return [...ids];
}

/** A draft from the agent, MCP or a campaign: straight into Approvals. */
export async function draftForApproval(args, source) {
  const k = kill();
  if (k.posting && k.drafts && source !== "you") throw err(423, "The kill switch is on and drafts are paused too. Nothing was drafted.", "killed");
  const s = await S.social();
  const targets = resolveAccounts(s, args.accounts).map((account) => {
    const net = s.accounts().find((a) => a.id === account)?.network;
    const text = args.perNetwork && net && args.perNetwork[net] ? String(args.perNetwork[net]) : undefined;
    return text ? { account, text } : { account };
  });
  const input = normalizePostInput({ ...args, targets, labels: { ai: true, nfa: /\$[A-Za-z]{2,12}\b/.test(String(args.text || "")), ...(args.labels || {}) } }, s);
  const hits = getBrand().useInSocial ? bannedIn([input.text, ...input.targets.map((t) => t.text || "")].join("\n")) : [];
  if (hits.length) throw err(400, `The draft uses banned phrases from the brand kit: ${hits.map((h) => `"${h}"`).join(", ")}. Rewrite it without them.`, "blocked");
  const d = s.draft(input);
  const post = s.submit(d.id);
  logAction("draft", `${source === "campaign" ? "A campaign" : source === "mcp" ? "MCP" : source === "you" ? "You" : "The agent"} drafted post ${d.id} for ${targets.length} account(s): ${clip(input.text, 80)}`, { postId: d.id, source });
  emit("post", post);
  return post;
}

/** Published posts per network, with links (Socials → Analytics). */
export async function analytics() {
  const s = await S.social();
  const posts = s.posts({ limit: 5000 });
  const by = {};
  const recent = [];
  for (const p of posts) for (const r of p.results || []) {
    if (r.status !== "published") continue;
    const b = (by[r.network] ||= { network: r.network, published: 0, last7: 0 });
    b.published++;
    if ((r.at || p.updatedAt) > Date.now() - 7 * 86400_000) b.last7++;
    recent.push({ postId: p.id, network: r.network, account: r.account, url: r.url, at: r.at || p.updatedAt, text: clip(p.input.targets.find((t) => t.account === r.account)?.text || p.input.text, 140) });
  }
  const counts = {};
  for (const p of posts) counts[p.status] = (counts[p.status] || 0) + 1;
  return { networks: Object.values(by).sort((a, b) => b.published - a.published), recent: recent.sort((a, b) => b.at - a.at).slice(0, 100), counts, today: publishedToday(s) };
}
