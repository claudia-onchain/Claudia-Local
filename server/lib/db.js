/**
 * db.js — one SQLite file (~/.claudia-local/claudia.db) through node:sqlite, built into Node ≥ 22.13.
 *
 *   chats        one row per chat (no more rewriting a whole JSON file on every turn)
 *   memory_fts   FTS5 index over the Markdown memory files, rebuilt when the files change
 *
 * node:sqlite still prints an ExperimentalWarning on some Node versions; that one warning is
 * filtered out so it doesn't look like an error. If node:sqlite can't load (older Node, a build
 * without SQLite), `db` is null and store.js falls back to JSON files and word-overlap search.
 */
import { chmodSync, existsSync } from "node:fs";
import { P, ensureHome } from "./paths.js";

// Swallow only the SQLite ExperimentalWarning; every other warning still prints.
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const msg = typeof warning === "string" ? warning : warning?.message || "";
  const type = typeof rest[0] === "string" ? rest[0] : rest[0]?.type || warning?.name;
  if (type === "ExperimentalWarning" && /sqlite/i.test(msg)) return;
  return emit.call(process, warning, ...rest);
};

let sqlite = null;
try { sqlite = await import("node:sqlite"); } catch { sqlite = null; }

/** @type {import("node:sqlite").DatabaseSync | null} */
export let db = null;
export let fts = false;
export let error = "";

function open() {
  if (!sqlite?.DatabaseSync) { error = "node:sqlite isn't available in this Node.js"; return; }
  try {
    ensureHome();
    const fresh = !existsSync(P.db);
    db = new sqlite.DatabaseSync(P.db);
    if (fresh) { try { chmodSync(P.db, 0o600); } catch { /* not ours to fix */ } }
    db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 3000;");
    db.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
      CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 0, messages TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS chats_updated ON chats(updated_at DESC);`);
    try {
      db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, content, tags, tokenize = 'unicode61')");
      fts = true;
    } catch { fts = false; }
  } catch (e) {
    error = e.message;
    db = null;
  }
}
open();

export function getMeta(k) {
  if (!db) return null;
  return db.prepare("SELECT v FROM meta WHERE k = ?").get(k)?.v ?? null;
}
export function setMeta(k, v) {
  db?.prepare("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, String(v));
}

/** Runs `fn` in a transaction. */
export function tx(fn) {
  if (!db) return fn();
  db.exec("BEGIN");
  try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { try { db.exec("ROLLBACK"); } catch { /* */ } throw e; }
}

export function close() {
  try { db?.close(); } catch { /* */ }
  db = null;
}
