/**
 * workspace.js — the sandboxed Files folder (~/.claudia-local/workspace).
 *
 * Every path from the dashboard or the agent is resolved against the workspace root and refused when it
 * would land outside it: "..", absolute paths elsewhere, NUL bytes, and symbolic links anywhere along the
 * way (a link could point outside). There is no other file access in the app.
 */
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { P, ensureHome } from "./paths.js";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 200 * 1024 * 1024;

class OutsideError extends Error {
  constructor(p) { super(`Refused: "${p}" is outside your workspace. Files can only be read and written inside the Claudia Local workspace.`); this.status = 403; this.code = "outside_workspace"; }
}

const HOST_PREFIX = /^(\/(Users|home|root|etc|var|private|tmp|opt|usr|bin|sbin|System|Library|Applications|Volumes|dev|proc|mnt|srv|boot)(\/|$)|[a-z]:\/|\/\/)/i; // + Windows drives and UNC paths

let rootReal = null;
export function root() {
  if (!rootReal) { ensureHome(); rootReal = realpathSync(P.workspace); }
  return rootReal;
}

/** Display form: "/" + path relative to the workspace. */
export const display = (full) => "/" + relative(root(), full).split(sep).join("/");

/** Resolves a user/agent path inside the workspace or throws. */
export function resolveInside(input) {
  const raw = String(input ?? "/");
  if (raw.includes("\0")) throw new OutsideError(raw.replace(/\0/g, ""));
  if (raw.length > 1024) throw new OutsideError(raw.slice(0, 40) + "…");
  let s = raw.trim().replace(/\\/g, "/");
  // Accept "/workspace/x" and "~/workspace/x" as aliases of "/x".
  s = s.replace(/^~?\/?workspace(\/|$)/, "/");
  const r = root();
  if (s.startsWith("~")) throw new OutsideError(raw);
  // Real host paths (home folders, system folders, other disks) are refused outright instead of being
  // quietly mapped into the workspace, so it is obvious to the agent that they are off limits.
  const rs = r.split(sep).join("/"); // the root with forward slashes (Windows)
  const inRoot = s === rs || s.startsWith(rs + "/");
  if (!inRoot && HOST_PREFIX.test(s)) throw new OutsideError(raw);
  // Absolute paths that already point into the real workspace folder are fine; any other absolute path is
  // treated as relative to the workspace root ("/notes/a.md" → <root>/notes/a.md).
  const full = inRoot ? resolve(s) : resolve(r, "." + (s.startsWith("/") ? s : "/" + s));
  if (full !== r && !full.startsWith(r + sep)) throw new OutsideError(raw);
  // No symlinks anywhere between the root and the target.
  let cur = r;
  for (const part of relative(r, full).split(sep).filter(Boolean)) {
    cur = join(cur, part);
    if (!existsSync(cur)) break;
    if (lstatSync(cur).isSymbolicLink()) throw new OutsideError(raw);
  }
  return full;
}

function totalBytes(dir = root()) {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const f = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) n += totalBytes(f);
    else if (e.isFile()) n += statSync(f).size;
  }
  return n;
}

export function stat(p) {
  const full = resolveInside(p);
  if (!existsSync(full)) return null;
  const st = lstatSync(full);
  return { path: display(full), isDirectory: st.isDirectory(), size: st.size, modified: st.mtimeMs };
}

export function list(p = "/") {
  const full = resolveInside(p);
  if (!existsSync(full)) throw Object.assign(new Error(`No such folder: ${display(full)}`), { status: 404 });
  if (!lstatSync(full).isDirectory()) throw Object.assign(new Error(`${display(full)} is a file, not a folder`), { status: 400 });
  return readdirSync(full, { withFileTypes: true })
    .filter(e => !e.isSymbolicLink())
    .map(e => {
      const f = join(full, e.name);
      const st = statSync(f);
      return { name: e.name, path: display(f), isDirectory: e.isDirectory(), size: e.isDirectory() ? 0 : st.size, modified: st.mtimeMs };
    })
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name));
}

export function read(p) {
  const full = resolveInside(p);
  if (!existsSync(full)) throw Object.assign(new Error(`File not found: ${display(full)}`), { status: 404 });
  const st = lstatSync(full);
  if (st.isDirectory()) throw Object.assign(new Error(`${display(full)} is a folder`), { status: 400 });
  if (st.size > MAX_FILE_BYTES) {
    if (IMAGE_NAME.test(full)) return { path: display(full), size: st.size, binary: true, content: "" };
    throw Object.assign(new Error(`${display(full)} is larger than 2 MB`), { status: 413 });
  }
  const buf = readFileSync(full);
  if (buf.subarray(0, 8000).includes(0)) return { path: display(full), size: st.size, binary: true, content: "" };
  return { path: display(full), size: st.size, binary: false, content: buf.toString("utf-8") };
}

export function readBytes(p) {
  const full = resolveInside(p);
  if (!existsSync(full) || lstatSync(full).isDirectory()) throw Object.assign(new Error(`File not found: ${display(full)}`), { status: 404 });
  if (lstatSync(full).size > 4 * 1024 * 1024) throw Object.assign(new Error("Images must be 4 MB or smaller"), { status: 413 });
  return { path: display(full), bytes: readFileSync(full) };
}

export function write(p, content) {
  const full = resolveInside(p);
  if (full === root()) throw Object.assign(new Error("Give the file a name."), { status: 400 });
  const data = Buffer.from(String(content ?? ""), "utf-8");
  if (data.length > MAX_FILE_BYTES) throw Object.assign(new Error("Files can be at most 2 MB."), { status: 413 });
  if (existsSync(full) && lstatSync(full).isDirectory()) throw Object.assign(new Error(`${display(full)} is a folder`), { status: 400 });
  const prev = existsSync(full) ? lstatSync(full).size : 0;
  if (totalBytes() - prev + data.length > MAX_TOTAL_BYTES) throw Object.assign(new Error("The workspace is full (200 MB)."), { status: 413 });
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  resolveInside(display(dirname(full))); // re-check after creating parents
  writeFileSync(full, data, { mode: 0o600 });
  return { path: display(full), size: data.length };
}

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Saves an uploaded picture (PNG, JPEG, GIF or WEBP, checked by its first bytes) into the workspace. */
export function writeImage(p, buf) {
  const full = resolveInside(p);
  if (full === root()) throw Object.assign(new Error("Give the file a name."), { status: 400 });
  if (!IMAGE_NAME.test(full)) throw Object.assign(new Error("Pictures need a .png, .jpg, .gif or .webp name."), { status: 415 });
  if (!buf.length) throw Object.assign(new Error("The file is empty."), { status: 400 });
  if (buf.length > MAX_IMAGE_BYTES) throw Object.assign(new Error("Pictures can be at most 4 MB."), { status: 413 });
  const h = buf.subarray(0, 12);
  const ok = (h[0] === 0x89 && h[1] === 0x50 && h[2] === 0x4e && h[3] === 0x47) || (h[0] === 0xff && h[1] === 0xd8)
    || h.subarray(0, 4).toString() === "GIF8" || (h.subarray(0, 4).toString() === "RIFF" && h.subarray(8, 12).toString() === "WEBP");
  if (!ok) throw Object.assign(new Error("That file isn't a PNG, JPEG, GIF or WEBP picture."), { status: 415 });
  if (existsSync(full) && lstatSync(full).isDirectory()) throw Object.assign(new Error(`${display(full)} is a folder`), { status: 400 });
  const prev = existsSync(full) ? lstatSync(full).size : 0;
  if (totalBytes() - prev + buf.length > MAX_TOTAL_BYTES) throw Object.assign(new Error("The workspace is full (200 MB)."), { status: 413 });
  mkdirSync(dirname(full), { recursive: true, mode: 0o700 });
  resolveInside(display(dirname(full)));
  writeFileSync(full, buf, { mode: 0o600 });
  return { path: display(full), size: buf.length };
}

export function mkdir(p) {
  const full = resolveInside(p);
  mkdirSync(full, { recursive: true, mode: 0o700 });
  return { path: display(full) };
}

export function remove(p) {
  const full = resolveInside(p);
  if (full === root()) throw Object.assign(new Error("The workspace itself can't be deleted."), { status: 400 });
  if (!existsSync(full)) throw Object.assign(new Error(`Not found: ${display(full)}`), { status: 404 });
  rmSync(full, { recursive: true, force: true });
  return { path: display(full) };
}

/** Case-insensitive text search across workspace files. */
export function search(pattern, p = "/", limit = 100) {
  const needle = String(pattern || "").toLowerCase();
  if (!needle) return [];
  const out = [];
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= limit) return;
      if (e.isSymbolicLink()) continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!e.isFile()) continue;
      // The name first, for every file: pictures and other binary files are found by name too.
      if (e.name.toLowerCase().includes(needle)) out.push({ path: display(f), line: 0, content: "(file name)" });
      if (out.length >= limit || statSync(f).size > MAX_FILE_BYTES) continue;
      const buf = readFileSync(f);
      if (buf.subarray(0, 8000).includes(0)) continue; // binary: no text to search
      const lines = buf.toString("utf-8").split("\n");
      for (let i = 0; i < lines.length && out.length < limit; i++) {
        if (lines[i].toLowerCase().includes(needle)) out.push({ path: display(f), line: i + 1, content: lines[i].slice(0, 200) });
      }
    }
  };
  const start = resolveInside(p);
  if (existsSync(start) && lstatSync(start).isDirectory()) walk(start);
  return out;
}
