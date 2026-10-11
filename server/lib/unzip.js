/**
 * unzip.js — a small, strict zip reader for skill packages (no dependency).
 *
 * Reads the central directory, then each entry (stored or deflated). It refuses anything a skill
 * package has no reason to contain: paths with "..", absolute paths, drive letters or backslashes,
 * symlinks, encrypted entries, zip64, too many files, files that are too big, or archives that inflate
 * past the total limit. Nothing is written here; the caller gets { path, data } entries in memory.
 */
import { inflateRawSync } from "node:zlib";

export const LIMITS = { files: 400, fileBytes: 2 * 1024 * 1024, totalBytes: 20 * 1024 * 1024, zipBytes: 25 * 1024 * 1024 };

const bad = (msg) => Object.assign(new Error(`This package can't be installed: ${msg}`), { status: 400 });

/** A safe relative path ("a/b.md"), or throws. Directories end with "/". */
export function safePath(name) {
  const n = String(name);
  if (!n || n.length > 300) throw bad("a file name is empty or too long.");
  if (n.includes("\\") || n.includes("\0") || /^[A-Za-z]:/.test(n) || n.startsWith("/")) throw bad(`"${n.slice(0, 80)}" is not a plain relative path.`);
  const parts = n.split("/");
  if (parts.some((p, i) => p === ".." || p === "." || (p === "" && i !== parts.length - 1))) throw bad(`"${n.slice(0, 80)}" leaves the package folder.`);
  return n;
}

/** Entries of a zip buffer: [{ path, data: Buffer }] (directories are skipped). */
export function readZip(buf, limits = LIMITS) {
  if (buf.length > limits.zipBytes) throw bad("the download is too big.");
  // End of central directory: last 22..65557 bytes.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw bad("it isn't a zip file.");
  const count = buf.readUInt16LE(eocd + 10);
  const cdSize = buf.readUInt32LE(eocd + 12);
  const cdOff = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOff === 0xffffffff) throw bad("zip64 archives aren't supported.");
  if (count > limits.files) throw bad(`it has more than ${limits.files} files.`);
  if (cdOff + cdSize > buf.length) throw bad("the zip is damaged.");
  const out = [];
  let p = cdOff, total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw bad("the zip is damaged.");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const ext = buf.readUInt32LE(p + 38);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf-8");
    p += 46 + nlen + elen + clen;
    safePath(name);
    if (flags & 1) throw bad("encrypted files aren't allowed.");
    const mode = (ext >>> 16) & 0o170000;
    if (madeBy === 3 && mode === 0o120000) throw bad(`"${name}" is a symlink.`);
    if (name.endsWith("/")) continue;
    if (usize > limits.fileBytes) throw bad(`"${name}" is bigger than ${Math.round(limits.fileBytes / 1024 / 1024)} MB.`);
    total += usize;
    if (total > limits.totalBytes) throw bad(`it unpacks to more than ${Math.round(limits.totalBytes / 1024 / 1024)} MB.`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw bad("the zip is damaged.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) {
      try { data = inflateRawSync(raw, { maxOutputLength: limits.fileBytes + 1 }); } catch { throw bad(`"${name}" doesn't unpack cleanly.`); }
    } else throw bad(`"${name}" uses a compression method that isn't supported.`);
    if (data.length !== usize) throw bad(`"${name}" isn't the size the zip says.`);
    out.push({ path: name, data });
  }
  return out;
}

/** Drops a folder every entry shares ("coin-research/SKILL.md" → "SKILL.md"). */
export function stripCommonFolder(entries) {
  if (!entries.length) return entries;
  const first = entries[0].path.split("/")[0];
  if (entries.every(e => e.path.startsWith(first + "/"))) return entries.map(e => ({ ...e, path: e.path.slice(first.length + 1) })).filter(e => e.path);
  return entries;
}
