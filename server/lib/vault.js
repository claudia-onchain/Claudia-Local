/**
 * vault.js — every secret Claudia Local holds, encrypted at rest with your passphrase.
 *
 *   key  = scrypt(passphrase, salt, N=2^15, r=8, p=1) → 32 bytes
 *   blob = AES-256-GCM(key, iv, JSON(secrets)), AAD "claudia-local/vault/v1"
 *
 * The passphrase is never stored. The derived key lives in memory only while the app is unlocked;
 * "Lock" (or quitting) forgets it. A wrong passphrase fails the GCM tag check.
 *
 * Secrets: openrouterKey · claudiaApiKey (ck_live_…) · deviceKey (signs API requests) · walletKey (signs Solana txs)
 *          keys: { "<name>": "…" }   your own provider keys (Google, fal, ElevenLabs, X app, …), see providers.js
 *          tokens: { "<name>": "…" } OAuth tokens a package asks us to keep (KeyProvider.set), never shown
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { P } from "./paths.js";
import { writeJsonFile } from "./store.js";

const scrypt = promisify(scryptCb);
const AAD = Buffer.from("claudia-local/vault/v1");
const KDF = { name: "scrypt", N: 1 << 15, r: 8, p: 1 };
export const SECRET_FIELDS = ["openrouterKey", "claudiaApiKey", "deviceKey", "walletKey"];

let key = null;      // Buffer while unlocked
let secrets = null;  // decrypted object while unlocked
let salt = null;

export const exists = () => existsSync(P.vault);
export const isUnlocked = () => !!key;

async function derive(passphrase, s, kdf = KDF) {
  return scrypt(String(passphrase).normalize("NFKC"), s, 32, { N: kdf.N, r: kdf.r, p: kdf.p, maxmem: 256 * 1024 * 1024 });
}

function encrypt(k, obj) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", k, iv);
  c.setAAD(AAD);
  const data = Buffer.concat([c.update(JSON.stringify(obj), "utf-8"), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") };
}

function decrypt(k, box) {
  const d = createDecipheriv("aes-256-gcm", k, Buffer.from(box.iv, "base64"));
  d.setAAD(AAD);
  d.setAuthTag(Buffer.from(box.tag, "base64"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(box.data, "base64")), d.final()]).toString("utf-8"));
}

function persist() {
  writeJsonFile(P.vault, { type: "claudia-local-vault", version: 1, kdf: { ...KDF, salt: salt.toString("base64") }, box: encrypt(key, secrets), updatedAt: new Date().toISOString() });
}

export function checkPassphrase(p) {
  const s = String(p ?? "");
  if (s.length < 8) throw Object.assign(new Error("Use a passphrase of at least 8 characters."), { status: 400 });
  if (s.length > 512) throw Object.assign(new Error("That passphrase is too long."), { status: 400 });
}

export async function create(passphrase, initial = {}) {
  if (exists()) throw Object.assign(new Error("This app is already set up. Unlock it instead."), { status: 409 });
  checkPassphrase(passphrase);
  salt = randomBytes(16);
  key = await derive(passphrase, salt);
  secrets = {};
  for (const f of SECRET_FIELDS) if (initial[f]) secrets[f] = String(initial[f]);
  persist();
}

export async function unlock(passphrase) {
  const v = JSON.parse(readFileSync(P.vault, "utf-8"));
  const s = Buffer.from(v.kdf.salt, "base64");
  const k = await derive(passphrase, s, v.kdf);
  let obj;
  try { obj = decrypt(k, v.box); } catch { throw Object.assign(new Error("Wrong passphrase."), { status: 401 }); }
  key = k; salt = s; secrets = obj;
}

export function lock() {
  if (key) key.fill(0);
  key = null; secrets = null; salt = null;
}

export async function changePassphrase(current, next) {
  checkPassphrase(next);
  const v = JSON.parse(readFileSync(P.vault, "utf-8"));
  const k = await derive(current, Buffer.from(v.kdf.salt, "base64"), v.kdf);
  if (!key || !timingSafeEqual(k, key)) throw Object.assign(new Error("The current passphrase is wrong."), { status: 401 });
  salt = randomBytes(16);
  key = await derive(next, salt);
  persist();
}

/** True when `passphrase` is the vault's passphrase (used before showing a secret). */
export async function verify(passphrase) {
  if (!key) return false;
  const v = JSON.parse(readFileSync(P.vault, "utf-8"));
  const k = await derive(passphrase, Buffer.from(v.kdf.salt, "base64"), v.kdf);
  return timingSafeEqual(k, key);
}

function need() {
  if (!key) throw Object.assign(new Error("Claudia Local is locked."), { status: 423 });
}

export function get(field) {
  need();
  return secrets[field] || "";
}

/** Patch secrets: a string sets a field, null removes it. */
export function set(patch) {
  need();
  for (const [f, v] of Object.entries(patch)) {
    if (!SECRET_FIELDS.includes(f)) continue;
    if (v === null || v === "") delete secrets[f];
    else if (typeof v === "string") secrets[f] = v;
  }
  persist();
}

// ── provider keys (Settings → Keys and providers) ───────────────────────────
// Names are free-form ("google", "x.clientId", "bluesky.appPassword"); providers.js decides which exist.
const KEY_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const bucket = (b) => { need(); if (!secrets[b] || typeof secrets[b] !== "object") secrets[b] = {}; return secrets[b]; };

export function getKey(name, b = "keys") {
  if (!key) return null;
  const v = secrets[b]?.[name];
  return typeof v === "string" && v ? v : null;
}

/** Patch provider keys: a string sets a name, null or "" removes it. */
export function setKeys(patch, b = "keys") {
  const box = bucket(b);
  for (const [n, v] of Object.entries(patch || {})) {
    if (!KEY_NAME.test(n)) continue;
    if (v === null || v === "") delete box[n];
    else if (typeof v === "string") box[n] = v.slice(0, 8192);
  }
  persist();
}

export function keyNames(b = "keys") {
  return key && secrets[b] && typeof secrets[b] === "object" ? Object.keys(secrets[b]) : [];
}

/** "set" + the last 4 characters (only for long values), never the value. */
export function maskKey(name, b = "keys") {
  const v = getKey(name, b);
  if (!v) return { set: false, hint: "" };
  return { set: true, hint: v.length > 16 ? "…" + v.slice(-4) : "" };
}

export function has(field) {
  return !!(key && secrets[field]);
}

/** "set" + last 4 characters, never the value. */
export function mask(field) {
  if (!has(field)) return { set: false, hint: "" };
  const v = secrets[field];
  return { set: true, hint: v.length > 12 ? "…" + v.slice(-4) : "" };
}
