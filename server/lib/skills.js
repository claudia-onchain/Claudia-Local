/**
 * skills.js — Agent Skills (SKILL.md folders) you install for your agent.
 *
 * Where they come from:
 *   library   Claudia's skill library: GET <claudia>/api/skills (filters category, tag, q), the zip from
 *             /skills/<slug>.zip, checked against the listing's sha256 before anything is unpacked
 *   folder    a folder on this computer that holds a SKILL.md
 *   GitHub    only through a review: every file is listed and scripts are shown in full before you install
 *
 * Skills are instructions only in 0.3: nothing in a skill is ever run. A SKILL.md that tells anyone to pipe
 * curl or wget into a shell is refused. Unpacking is strict (unzip.js: no "..", no absolute paths, no
 * symlinks, size limits) and lands in ~/.claudia-local/skills/<slug>.
 *
 * Each install is pinned by a hash of its files (skills.json). If a skill changes on disk the app warns,
 * and load_skill refuses it until you review and re-pin it on the Skills page.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { P, ensurePrivateDir } from "./paths.js";
import { getConfig, saveConfig, readJsonFile, writeJsonFile, trackActivity } from "./store.js";
import { readZip, stripCommonFolder, safePath, LIMITS } from "./unzip.js";

export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SCRIPT_EXT = /\.(sh|bash|zsh|fish|py|js|mjs|cjs|ts|rb|pl|php|ps1|bat|cmd|exe|bin)$/i;
const err = (status, message) => Object.assign(new Error(message), { status });
const sha256 = (b) => createHash("sha256").update(b).digest("hex");

// ── state ──────────────────────────────────────────────────────────────────
const state = () => readJsonFile(P.skills, { skills: {} });
const saveState = (s) => writeJsonFile(P.skills, s);
const dirOf = (slug) => join(P.skillsDir, slug);

/** Hash over every file (path + content hash), sorted: the pin. */
function hashFiles(files) {
  const h = createHash("sha256");
  for (const f of [...files].sort((a, b) => a.path.localeCompare(b.path))) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest("hex");
}

// ── SKILL.md ───────────────────────────────────────────────────────────────
/** Front matter (name, description, metadata.*) and the body. A small YAML subset, enough for SKILL.md. */
export function parseSkillMd(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(String(text));
  const meta = {};
  if (m) {
    let parent = null, block = null;
    for (const line of m[1].split(/\r?\n/)) {
      if (block) { if (/^\s+\S/.test(line) || !line.trim()) { block.obj[block.key] += (block.obj[block.key] ? " " : "") + line.trim(); continue; } block = null; }
      const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      const sub = /^\s{2,}([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
      const val = (v) => v.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
      if (top) {
        if (!top[2].trim()) { meta[top[1]] = {}; parent = top[1]; continue; }
        parent = null;
        if (/^[>|][-+]?$/.test(top[2].trim())) { meta[top[1]] = ""; block = { obj: meta, key: top[1] }; continue; }
        meta[top[1]] = val(top[2]);
      } else if (sub && parent && typeof meta[parent] === "object") {
        meta[parent][sub[1]] = val(sub[2]);
      }
    }
  }
  return { meta, body: m ? String(text).slice(m[0].length) : String(text) };
}

/** Instructions that tell someone to pipe a download into a shell. */
export function dangers(text) {
  const t = String(text);
  const out = [];
  const pats = [
    [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(env\s+\S*\s*)?(ba|z|da|k|c|fi)?sh\b/i, "pipes curl or wget into a shell"],
    [/\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(python3?|node|perl|ruby)\b/i, "pipes curl or wget into an interpreter"],
    [/\b(ba|z)?sh\s+-c\s+["']?\$\(\s*(curl|wget)\b/i, "runs a download through sh -c"],
    [/\b(ba|z)?sh\s+<\(\s*(curl|wget)\b/i, "runs a download through process substitution"],
    [/\b(iwr|Invoke-WebRequest|irm|Invoke-RestMethod)\b[^\n]*\|\s*(iex|Invoke-Expression)\b/i, "pipes a download into PowerShell"],
  ];
  for (const [re, why] of pats) { const m = re.exec(t); if (m) out.push(`SKILL.md ${why}: "${m[0].slice(0, 120)}"`); }
  return out;
}

const isText = (b) => !b.subarray(0, 8000).includes(0);
const kindOf = (path, data) => (SCRIPT_EXT.test(path) || (isText(data) && data.subarray(0, 2).toString() === "#!") ? "script" : isText(data) ? "text" : "binary");

/** Checks a set of files ([{ path, data }]) as a skill and describes it. */
function inspect(entries, slugHint) {
  const files = entries.map(e => ({ path: safePath(e.path), data: e.data }));
  if (files.length > LIMITS.files) throw err(400, "This skill has too many files.");
  const skillMd = files.find(f => f.path === "SKILL.md");
  if (!skillMd) throw err(400, "There's no SKILL.md at the top of this skill.");
  const text = skillMd.data.toString("utf-8");
  const { meta } = parseSkillMd(text);
  const slug = String(meta.name || slugHint || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  if (!SLUG.test(slug)) throw err(400, "The skill needs a name made of lowercase letters, numbers and dashes.");
  const description = String(meta.description || "").slice(0, 1024);
  if (!description) throw err(400, "SKILL.md needs a description in its front matter.");
  return {
    slug, name: String(meta.name || slug), title: String(meta.metadata?.title || meta.title || meta.name || slug), description,
    version: String(meta.metadata?.version || meta.version || ""), blocked: dangers(text),
    files: files.map(f => ({ path: f.path, size: f.data.length, sha256: sha256(f.data), kind: kindOf(f.path, f.data), data: f.data })),
  };
}

function write(info, source) {
  if (info.blocked.length) throw err(400, `Not installed. ${info.blocked.join(" ")}`);
  ensurePrivateDir(P.skillsDir);
  const tmp = join(P.skillsDir, `.${info.slug}.${randomBytes(4).toString("hex")}.tmp`);
  mkdirSync(tmp, { mode: 0o700 });
  try {
    for (const f of info.files) {
      const dest = resolve(tmp, f.path);
      if (!dest.startsWith(resolve(tmp) + sep)) throw err(400, "A file path leaves the skill folder.");
      mkdirSync(resolve(dest, ".."), { recursive: true, mode: 0o700 });
      writeFileSync(dest, f.data, { mode: 0o600 });
      try { chmodSync(dest, 0o600); } catch { /* */ }
    }
    const dir = dirOf(info.slug);
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    renameSync(tmp, dir);
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true });
    throw e;
  }
  const files = info.files.map(({ path, size, sha256: h, kind }) => ({ path, size, sha256: h, kind }));
  const s = state();
  const prev = s.skills[info.slug];
  s.skills[info.slug] = { slug: info.slug, name: info.name, title: info.title, description: info.description, version: info.version, source, files, hash: hashFiles(files), enabled: prev ? prev.enabled : true, installedAt: Date.now() };
  saveState(s);
  trackActivity("skills", `Installed skill ${info.slug} (${source.type})`);
  return publicSkill(s.skills[info.slug]);
}

// ── reading what's installed ───────────────────────────────────────────────
function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = lstatSync(full);
    if (st.isSymbolicLink()) throw err(400, `"${full.slice(base.length + 1)}" is a symlink.`);
    if (st.isDirectory()) walk(full, base, out);
    else if (st.isFile()) {
      if (st.size > LIMITS.fileBytes) throw err(400, `"${full.slice(base.length + 1)}" is too big.`);
      out.push({ path: full.slice(base.length + 1).split("\\").join("/"), data: readFileSync(full) });
      if (out.length > LIMITS.files) throw err(400, "That folder has too many files.");
    }
  }
  return out;
}

/** Does the skill on disk still match its pin? */
export function verify(slug) {
  const s = state().skills[slug];
  if (!s) return { ok: false, missing: true };
  const dir = dirOf(slug);
  if (!existsSync(dir)) return { ok: false, missing: true };
  try {
    const files = walk(dir).map(f => ({ path: f.path, sha256: sha256(f.data) }));
    const hash = hashFiles(files);
    return { ok: hash === s.hash, changed: hash !== s.hash, hash };
  } catch (e) {
    return { ok: false, changed: true, error: e.message };
  }
}

function publicSkill(s, check = false) {
  const v = check ? verify(s.slug) : null;
  return { slug: s.slug, name: s.name, title: s.title, description: s.description, version: s.version, source: s.source, enabled: !!s.enabled, installedAt: s.installedAt,
    hash: s.hash, files: s.files.length, scripts: s.files.filter(f => f.kind === "script").length, ...(v ? { changed: !v.ok, missing: !!v.missing } : {}) };
}

export function list({ check = true } = {}) {
  return Object.values(state().skills).sort((a, b) => a.slug.localeCompare(b.slug)).map(s => publicSkill(s, check));
}

export const enabledSkills = () => Object.values(state().skills).filter(s => s.enabled);

export function get(slug) {
  const s = state().skills[slug];
  if (!s) throw err(404, "That skill isn't installed.");
  const dir = dirOf(slug);
  const md = existsSync(join(dir, "SKILL.md")) ? readFileSync(join(dir, "SKILL.md"), "utf-8") : "";
  return { ...publicSkill(s, true), skillMd: md, fileList: s.files };
}

/** Text of one file of an installed skill (only files in its pin). */
export function readSkillFile(slug, path) {
  const s = state().skills[slug];
  if (!s) throw err(404, "That skill isn't installed.");
  const p = safePath(String(path || "").replace(/^\.?\/+/, ""));
  const f = s.files.find(x => x.path === p);
  if (!f) throw err(404, `${slug} has no file ${p}.`);
  if (f.kind === "binary") throw err(400, `${p} isn't a text file.`);
  const data = readFileSync(join(dirOf(slug), p));
  if (sha256(data) !== f.sha256) throw err(409, `${p} changed on disk since ${slug} was installed. Review the skill on the Skills page.`);
  return data.toString("utf-8").slice(0, 200_000);
}

export function setEnabled(slug, on) {
  const s = state();
  if (!s.skills[slug]) throw err(404, "That skill isn't installed.");
  s.skills[slug].enabled = !!on;
  saveState(s);
  return publicSkill(s.skills[slug], true);
}

/** Accept what's on disk now as the new pin (after you've looked at the change). */
export function repin(slug) {
  const s = state();
  const sk = s.skills[slug];
  if (!sk) throw err(404, "That skill isn't installed.");
  const info = inspect(walk(dirOf(slug)), slug);
  if (info.blocked.length) throw err(400, `Not re-pinned. ${info.blocked.join(" ")}`);
  sk.files = info.files.map(({ path, size, sha256: h, kind }) => ({ path, size, sha256: h, kind }));
  sk.hash = hashFiles(sk.files);
  sk.description = info.description;
  saveState(s);
  trackActivity("skills", `Re-pinned skill ${slug}`);
  return publicSkill(sk, true);
}

export function remove(slug) {
  if (!SLUG.test(slug)) throw err(400, "Bad skill name.");
  const s = state();
  delete s.skills[slug];
  saveState(s);
  rmSync(dirOf(slug), { recursive: true, force: true });
  trackActivity("skills", `Removed skill ${slug}`);
  return true;
}

// ── the Claudia library ────────────────────────────────────────────────────
const libBase = () => (getConfig().claudia?.baseUrl || "https://useclaudia.xyz").replace(/\/+$/, "");
let libCache = new Map();

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error", headers: { accept: "application/json" } });
  if (!r.ok) throw err(502, `The skill library answered ${r.status}.`);
  return r.json();
}

/** The library listing (filters: category, tag, q), with `installed` marked. */
export async function library({ category = "", tag = "", q = "" } = {}) {
  const qs = new URLSearchParams();
  if (category) qs.set("category", String(category).slice(0, 40));
  if (tag) qs.set("tag", String(tag).slice(0, 60));
  if (q) qs.set("q", String(q).slice(0, 120));
  const url = `${libBase()}/api/skills${qs.size ? "?" + qs : ""}`;
  const hit = libCache.get(url);
  let j = hit && Date.now() - hit.ts < 10 * 60_000 ? hit.data : null;
  if (!j) { j = await fetchJson(url); libCache.set(url, { ts: Date.now(), data: j }); if (libCache.size > 50) libCache = new Map([...libCache].slice(-20)); }
  const installed = state().skills;
  return {
    categories: j.categories || [], total: j.total ?? (j.skills || []).length,
    skills: (j.skills || []).filter(s => s && SLUG.test(String(s.slug))).map(s => ({
      slug: s.slug, title: s.title || s.name || s.slug, category: s.category || "", summary: s.summary || "", description: s.description || "", level: s.level || "",
      tags: Array.isArray(s.tags) ? s.tags : [], version: s.version || "", updated: s.updated || "", bytes: s.bytes || 0, fileCount: s.fileCount || 0,
      installed: !!installed[s.slug], installedVersion: installed[s.slug]?.version || "",
    })),
  };
}

export async function installFromLibrary(slug) {
  if (!SLUG.test(String(slug || ""))) throw err(400, "Bad skill name.");
  const j = await fetchJson(`${libBase()}/api/skills?q=${encodeURIComponent(slug)}`);
  let s = (j.skills || []).find(x => x.slug === slug);
  if (!s) s = ((await fetchJson(`${libBase()}/api/skills`)).skills || []).find(x => x.slug === slug);
  if (!s) throw err(404, `The library has no skill called ${slug}.`);
  if (!/^\/skills\/[a-z0-9-]+\.zip$/.test(String(s.zip || ""))) throw err(502, "The library listing has an unexpected download path.");
  if (!/^[a-f0-9]{64}$/.test(String(s.sha256 || ""))) throw err(502, "The library listing has no checksum for this skill.");
  const r = await fetch(`${libBase()}${s.zip}`, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!r.ok) throw err(502, `The download answered ${r.status}.`);
  const len = Number(r.headers.get("content-length") || 0);
  if (len > LIMITS.zipBytes) throw err(400, "The download is too big.");
  const buf = Buffer.from(await r.arrayBuffer());
  if (sha256(buf) !== s.sha256) throw err(400, "The download doesn't match the library's checksum, so it wasn't installed.");
  const info = inspect(stripCommonFolder(readZip(buf)), slug);
  if (info.slug !== slug) info.slug = slug;
  return write(info, { type: "library", ref: slug, sha256: s.sha256, version: s.version || "" });
}

export function installFromFolder(path) {
  const dir = resolve(String(path || "").replace(/^~(?=[\\/]|$)/, homedir()));
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) throw err(400, "That folder doesn't exist.");
  if (!existsSync(join(dir, "SKILL.md"))) throw err(400, "That folder has no SKILL.md.");
  const info = inspect(walk(dir), basename(dir));
  return write(info, { type: "folder", ref: dir });
}

// ── GitHub, through a review ───────────────────────────────────────────────
const reviews = new Map(); // token -> { info, source, expires }

function parseGithub(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { throw err(400, "That isn't a link."); }
  if (u.protocol !== "https:" || u.hostname !== "github.com") throw err(400, "Paste a https://github.com/… link.");
  const [owner, repo, kind, ref, ...rest] = u.pathname.replace(/\/+$/, "").split("/").filter(Boolean);
  const okName = /^[A-Za-z0-9_.-]{1,100}$/;
  if (!okName.test(owner || "") || !okName.test((repo || "").replace(/\.git$/, ""))) throw err(400, "That doesn't look like a GitHub repository link.");
  if (kind && kind !== "tree" && kind !== "blob") throw err(400, "Link to the repository or to a folder in it (…/tree/<branch>/<folder>).");
  if (ref && !/^[A-Za-z0-9_./-]{1,100}$/.test(ref)) throw err(400, "That branch name looks wrong.");
  let sub = rest.join("/");
  if (kind === "blob" && /(^|\/)SKILL\.md$/.test(sub)) sub = sub.replace(/\/?SKILL\.md$/, "");
  return { owner, repo: repo.replace(/\.git$/, ""), ref: ref || "HEAD", sub };
}

/** Downloads a GitHub folder and describes every file. Nothing is installed until installReviewed(token). */
export async function review(url) {
  const g = parseGithub(url);
  const r = await fetch(`https://codeload.github.com/${g.owner}/${g.repo}/zip/${g.ref}`, { signal: AbortSignal.timeout(30_000), redirect: "follow" });
  if (!r.ok) throw err(r.status === 404 ? 404 : 502, r.status === 404 ? "GitHub has no such repository or branch (private repositories can't be used)." : `GitHub answered ${r.status}.`);
  const buf = Buffer.from(await r.arrayBuffer());
  let entries = stripCommonFolder(readZip(buf, { ...LIMITS, files: 2000, totalBytes: 60 * 1024 * 1024 }));
  if (g.sub) entries = entries.filter(e => e.path.startsWith(g.sub + "/")).map(e => ({ ...e, path: e.path.slice(g.sub.length + 1) }));
  if (!entries.length) throw err(404, "That folder is empty or doesn't exist.");
  if (!entries.some(e => e.path === "SKILL.md")) {
    const found = entries.filter(e => /(^|\/)SKILL\.md$/.test(e.path)).map(e => e.path.replace(/\/?SKILL\.md$/, ""));
    if (found.length === 1) entries = entries.filter(e => e.path.startsWith(found[0] + "/")).map(e => ({ ...e, path: e.path.slice(found[0].length + 1) }));
    else throw err(400, found.length ? `This repository has ${found.length} skills. Paste the link to one folder, e.g. …/tree/${g.ref === "HEAD" ? "main" : g.ref}/${found[0]}` : "There's no SKILL.md in that repository.");
  }
  const info = inspect(entries, g.sub.split("/").pop() || g.repo);
  const token = randomBytes(16).toString("hex");
  for (const [k, v] of reviews) if (v.expires < Date.now()) reviews.delete(k);
  reviews.set(token, { info, source: { type: "github", ref: `https://github.com/${g.owner}/${g.repo}${g.sub ? `/tree/${g.ref}/${g.sub}` : ""}` }, expires: Date.now() + 15 * 60_000 });
  return {
    token, slug: info.slug, title: info.title, description: info.description, blocked: info.blocked, installed: !!state().skills[info.slug],
    files: info.files.map(f => ({ path: f.path, size: f.size, kind: f.kind,
      // Scripts and SKILL.md in full; other text files shortened; binary files by size only.
      content: f.kind === "binary" ? null : f.kind === "script" || f.path === "SKILL.md" ? f.data.toString("utf-8") : f.data.toString("utf-8").slice(0, 4000),
      truncated: f.kind === "text" && f.path !== "SKILL.md" && f.size > 4000 })),
  };
}

export function installReviewed(token) {
  const r = reviews.get(String(token || ""));
  if (!r || r.expires < Date.now()) throw err(410, "That review expired. Review the link again.");
  reviews.delete(String(token));
  return write(r.info, r.source);
}

/** Installs the skills a template asked for while the library route wasn't available (config.pendingSkills). */
export async function installPending(log = () => {}) {
  const pending = getConfig().pendingSkills;
  if (!Array.isArray(pending) || !pending.length) return [];
  const done = [];
  for (const slug of pending) {
    if (!SLUG.test(String(slug))) { done.push(slug); continue; }
    if (state().skills[slug]) { done.push(slug); continue; }
    try { await installFromLibrary(slug); done.push(slug); } catch (e) { log(`[skills] ${slug}: ${e.message}`); if (e.status === 404 || e.status === 400) done.push(slug); }
  }
  const c = getConfig();
  c.pendingSkills = (c.pendingSkills || []).filter(s => !done.includes(s));
  saveConfig(c);
  return done;
}
