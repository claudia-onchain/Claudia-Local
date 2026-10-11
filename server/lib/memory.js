/**
 * memory.js — your agent's long-term memory as plain Markdown you can read and edit.
 *
 *   ~/.claudia-local/memory/MEMORY.md         facts
 *   ~/.claudia-local/memory/USER.md           about you (preferences)
 *   ~/.claudia-local/memory/YYYY-MM-DD.md     daily notes (notes, tasks, conversation summaries)
 *   ~/.claudia-local/memory/quarantine.json   memory proposed from outside content, waiting for you
 *
 * One memory is one "- " bullet. The agent adds a small HTML comment after each one it writes:
 *   - Prefers paper trading this month <!-- m:m_x1 type:preference source:user tags:trading ts:2026-10-11T10:00:00.000Z -->
 * Lines you write yourself (bullets or paragraphs, no comment) count too; they get a stable id from their text.
 *
 * Every memory carries a source tag (untrusted.js SOURCES). Memory proposed because of outside content
 * (`needsQuarantine(source)`) is not written to the files: it waits in the quarantine list on the
 * Memory page until you approve it.
 *
 * Search uses SQLite FTS5 (db.js) when node:sqlite is there, and word overlap otherwise.
 * The 0.2 memory.json is moved into these files once, then renamed memory.json.migrated.
 */
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { P, ensurePrivateDir, replaceFile } from "./paths.js";
import * as D from "./db.js";
import { SOURCES, needsQuarantine } from "./untrusted.js";

export const MEMORY_TYPES = ["note", "fact", "preference", "conversation", "task"];
const MAX_TEXT = 8000;
const DAY = /^\d{4}-\d{2}-\d{2}\.md$/;
const HEAD = {
  "MEMORY.md": "# Memory\n\n<!-- Facts your agent keeps between chats. One per line, starting with \"- \". Edit freely. -->\n\n",
  "USER.md": "# About you\n\n<!-- What your agent knows about you: preferences, how you like to work. One per line, starting with \"- \". -->\n\n",
};

const newId = () => "m_" + Date.now().toString(36) + randomBytes(4).toString("hex");
const today = (ts = Date.now()) => new Date(ts).toISOString().slice(0, 10);

function ensureDir() { ensurePrivateDir(P.memoryDir); }

function writeFile(file, text) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString("hex")}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* */ }
  replaceFile(tmp, file);
  parsed = null;
}

/** Which file a memory of this type goes to. */
function fileFor(type, ts) {
  if (type === "fact") return "MEMORY.md";
  if (type === "preference") return "USER.md";
  return `${today(ts)}.md`;
}

/** Memory files: MEMORY.md, USER.md, then daily notes newest first. */
export function listFiles() {
  ensureDir();
  const names = readdirSync(P.memoryDir).filter(n => n === "MEMORY.md" || n === "USER.md" || DAY.test(n));
  const order = (n) => (n === "MEMORY.md" ? "0" : n === "USER.md" ? "1" : "2" + (99999999 - Number(n.slice(0, 10).replace(/-/g, ""))));
  return names.sort((a, b) => order(a).localeCompare(order(b))).map(name => {
    const st = statSync(join(P.memoryDir, name));
    return { name, size: st.size, updatedAt: st.mtimeMs, kind: name === "MEMORY.md" ? "facts" : name === "USER.md" ? "about you" : "daily note" };
  });
}

export function checkName(name) {
  const n = String(name || "");
  if (n !== "MEMORY.md" && n !== "USER.md" && !DAY.test(n)) throw Object.assign(new Error("Memory files are MEMORY.md, USER.md or YYYY-MM-DD.md."), { status: 400 });
  return n;
}

export function readFile(name) {
  const n = checkName(name);
  const f = join(P.memoryDir, n);
  return existsSync(f) ? readFileSync(f, "utf-8") : HEAD[n] || `# ${n.slice(0, 10)}\n\n`;
}

export function saveFile(name, content) {
  const n = checkName(name);
  const text = String(content ?? "");
  if (text.length > 512 * 1024) throw Object.assign(new Error("That memory file is too big (max 512 KB)."), { status: 413 });
  writeFile(join(P.memoryDir, n), text.endsWith("\n") ? text : text + "\n");
  return { name: n, size: Buffer.byteLength(text) };
}

// ── parsing ────────────────────────────────────────────────────────────────
const META = /\s*<!--\s*(m:[^>]*?)\s*-->\s*$/;
function parseMeta(s) {
  const out = {};
  for (const part of s.split(/\s+/)) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** Splits a file into entries: bullets (with indented continuation lines) and plain paragraphs. */
function parseFile(name, text, mtime) {
  const lines = text.split(/\r?\n/);
  const blocks = [];
  let cur = null;
  const push = () => { if (cur && cur.lines.join("").trim()) blocks.push(cur); cur = null; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*[-*]\s+/.test(l) && !/^\s{2,}/.test(l)) { push(); cur = { start: i, lines: [l.replace(/^\s*[-*]\s+/, "")], bullet: true }; continue; }
    if (cur?.bullet && /^\s{2,}\S/.test(l)) { cur.lines.push(l.replace(/^\s{2}/, "")); cur.end = i; continue; }
    if (!l.trim() || /^#{1,6}\s/.test(l) || /^\s*<!--.*-->\s*$/.test(l)) { push(); continue; }
    if (cur && !cur.bullet) { cur.lines.push(l); cur.end = i; continue; }
    push(); cur = { start: i, lines: [l], bullet: false };
  }
  push();
  const defType = name === "MEMORY.md" ? "fact" : name === "USER.md" ? "preference" : "note";
  const fileTs = DAY.test(name) ? Date.parse(name.slice(0, 10) + "T12:00:00Z") : mtime;
  return blocks.map(b => {
    let body = b.lines.join("\n");
    const m = META.exec(body);
    const meta = m ? parseMeta(m[1]) : {};
    if (m) body = body.slice(0, m.index);
    const content = body.trim();
    const id = meta.m || "h_" + createHash("sha1").update(name + "\n" + content).digest("hex").slice(0, 12);
    return {
      id, content, file: name,
      type: MEMORY_TYPES.includes(meta.type) ? meta.type : defType,
      source: SOURCES.includes(meta.source) ? meta.source : "user",
      tags: meta.tags ? meta.tags.split(",").filter(Boolean) : [],
      ts: meta.ts ? Date.parse(meta.ts) || fileTs : fileTs,
      start: b.start, end: b.end ?? b.start,
    };
  }).filter(e => e.content);
}

let parsed = null; // { sig, entries }
function signature(files) { return files.map(f => `${f.name}:${f.size}:${Math.round(f.updatedAt)}`).join("|"); }

/** Every memory in the files, newest first. */
export function entries() {
  migrate();
  const files = listFiles();
  const sig = signature(files);
  if (parsed?.sig === sig) return parsed.entries;
  const all = [];
  for (const f of files) all.push(...parseFile(f.name, readFileSync(join(P.memoryDir, f.name), "utf-8"), f.updatedAt));
  all.sort((a, b) => b.ts - a.ts);
  parsed = { sig, entries: all };
  indexFts(sig, all);
  return all;
}

// ── search ─────────────────────────────────────────────────────────────────
function indexFts(sig, all) {
  if (!D.db || !D.fts || D.getMeta("memory_sig") === sig) return;
  try {
    D.tx(() => {
      D.db.exec("DELETE FROM memory_fts");
      const ins = D.db.prepare("INSERT INTO memory_fts (id, content, tags) VALUES (?, ?, ?)");
      for (const e of all) ins.run(e.id, e.content, e.tags.join(" "));
      D.setMeta("memory_sig", sig);
    });
  } catch { /* search falls back to word overlap */ }
}

const words = (q) => (String(q || "").toLowerCase().match(/[\p{L}\p{N}$_]+/gu) || []).filter(w => w.length > 1).slice(0, 24);

function overlap(list, q, limit) {
  const ws = words(q);
  if (!ws.length) return list.slice(0, limit);
  return list
    .map(m => { const hay = (m.content + " " + m.tags.join(" ")).toLowerCase(); return { m, score: ws.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0) }; })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.ts - a.m.ts)
    .slice(0, limit)
    .map(x => x.m);
}

export function search(query, { type = "", limit = 50 } = {}) {
  const all = entries().filter(m => !type || m.type === type);
  const ws = words(query);
  if (!ws.length) return all.slice(0, limit);
  if (D.db && D.fts) {
    try {
      const match = ws.map(w => `"${w.replace(/"/g, '""')}"*`).join(" OR ");
      const rows = D.db.prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ? ORDER BY bm25(memory_fts) LIMIT ?").all(match, Math.max(limit * 3, 50));
      const byId = new Map(all.map(e => [e.id, e]));
      return rows.map(r => byId.get(r.id)).filter(Boolean).slice(0, limit);
    } catch { /* fall through */ }
  }
  return overlap(all, query, limit);
}

// ── writing ────────────────────────────────────────────────────────────────
function clean(content) {
  const text = String(content ?? "").replace(/<!--|-->/g, "").trim().slice(0, MAX_TEXT);
  if (!text) throw Object.assign(new Error("A memory needs some text."), { status: 400 });
  return text;
}
const cleanTags = (tags) => (Array.isArray(tags) ? tags : []).map(t => String(t).replace(/[\s,<>:]+/g, "-").slice(0, 32)).filter(Boolean).slice(0, 8);

function appendEntry(e) {
  const name = fileFor(e.type, e.ts);
  const file = join(P.memoryDir, name);
  const prev = existsSync(file) ? readFileSync(file, "utf-8") : HEAD[name] || `# ${name.slice(0, 10)}\n\n`;
  const [first, ...rest] = e.content.split(/\r?\n/);
  const meta = `<!-- m:${e.id} type:${e.type} source:${e.source}${e.tags.length ? ` tags:${e.tags.join(",")}` : ""} ts:${new Date(e.ts).toISOString()} -->`;
  const block = [`- ${first}`, ...rest.map(l => `  ${l}`)].join("\n") + ` ${meta}`;
  writeFile(file, (prev.endsWith("\n") ? prev : prev + "\n") + block + "\n");
  return { ...e, file: name };
}

/**
 * Saves a memory. `source` says where it came from (untrusted.js); outside sources wait in
 * quarantine and the result has `quarantined: true`.
 */
export function add(content, type = "note", tags = [], { source = "user" } = {}) {
  const e = { id: newId(), content: clean(content), type: MEMORY_TYPES.includes(type) ? type : "note", tags: cleanTags(tags), source: SOURCES.includes(source) ? source : "web", ts: Date.now() };
  if (needsQuarantine(e.source)) {
    const q = quarantine();
    writeQuarantine([e, ...q].slice(0, 200));
    return { ...e, quarantined: true };
  }
  return appendEntry(e);
}

export function remove(id) {
  const e = entries().find(x => x.id === id);
  if (!e) return false;
  const file = join(P.memoryDir, e.file);
  const lines = readFileSync(file, "utf-8").split(/\r?\n/);
  lines.splice(e.start, e.end - e.start + 1);
  writeFile(file, lines.join("\n"));
  return true;
}

// ── quarantine ─────────────────────────────────────────────────────────────
const QFILE = () => join(P.memoryDir, "quarantine.json");
export function quarantine() {
  try { const v = JSON.parse(readFileSync(QFILE(), "utf-8")); return Array.isArray(v) ? v : []; } catch { return []; }
}
function writeQuarantine(list) { ensureDir(); writeFile(QFILE(), JSON.stringify(list, null, 2) + "\n"); }

/** Approving keeps the original source tag, so you can still see it came from outside. */
export function approve(id) {
  const q = quarantine();
  const e = q.find(x => x.id === id);
  if (!e) throw Object.assign(new Error("That memory isn't waiting any more."), { status: 404 });
  writeQuarantine(q.filter(x => x.id !== id));
  return appendEntry({ ...e, ts: Date.now() });
}
export function reject(id) {
  const q = quarantine();
  writeQuarantine(q.filter(x => x.id !== id));
  return q.length !== quarantine().length;
}

// ── 0.2 migration ──────────────────────────────────────────────────────────
let migrated = false;
function migrate() {
  if (migrated) return;
  migrated = true;
  ensureDir();
  if (!existsSync(P.memory)) return;
  let old = [];
  try { old = JSON.parse(readFileSync(P.memory, "utf-8")); } catch { old = []; }
  for (const m of (Array.isArray(old) ? old : []).slice().reverse()) {
    try {
      appendEntry({ id: /^m_[a-z0-9]+$/i.test(m.id) ? m.id : newId(), content: clean(m.content), type: MEMORY_TYPES.includes(m.type) ? m.type : "note", tags: cleanTags(m.tags), source: "user", ts: Number(m.ts) || Date.now() });
    } catch { /* skip empty */ }
  }
  renameSync(P.memory, P.memory + ".migrated");
}
