/**
 * claudia.js — everything that talks to Claudia (useclaudia.xyz), through @useclaudia/sdk.
 *
 *  - Public reads: $CLAUDIA, coins launched on Claudia, the thread, agents.
 *  - Your agent: API key (ck_live_…) + device key sign every /api/v1 request; the agent wallet signs
 *    Solana transactions locally. All three live in the encrypted vault.
 *  - Money paths (buy, sell, launch): preview first (quote or plan, signed locally to check it, simulated on
 *    your RPC), then an explicit confirm within 60 s, inside local per-trade and per-day SOL caps, and only
 *    when live trading is switched on. Paper trades never touch the chain.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  ClaudiaClient, ClaudiaApiError, ClaudiaError, CLAUDIA_TOKEN, toTokenKey, generateDeviceKey, generateWallet, publicKeyOf, toKeypair,
  toBase58, getSolBalance, signTransactions, connectionFor, defaultRpcUrl, explorerUrl, normalizeTicker, normalizeCoinName, imageTypeOf, fromBase64,
} from "@useclaudia/sdk";
import { ClaudiaHome, defaultHomeDir } from "@useclaudia/sdk/node";
import { VersionedTransaction } from "@solana/web3.js";
import * as vault from "./vault.js";
import * as ws from "./workspace.js";
import { P } from "./paths.js";
import { getConfig, saveConfig, readJsonFile, writeJsonFile, newId, trackActivity } from "./store.js";

export const CLAUDIA_KEY = `sol:${CLAUDIA_TOKEN.mint}`;
const FEE_RESERVE_SOL = 0.005;
const PREVIEW_TTL_MS = 60_000;

const err = (status, message, code) => Object.assign(new Error(message), { status, code });

/** https://…, or http:// on this machine (a local Claudia server for development). */
export function checkUrl(raw, what, { originOnly = false } = {}) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw err(400, `${what} isn't a valid URL.`); }
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) throw err(400, `${what} must start with https:// (or http://localhost for a server on this machine).`);
  if (u.username || u.password) throw err(400, `${what} can't contain a username or password.`);
  if (!u.hostname.includes(".") && !local) throw err(400, `${what} doesn't look like a web address.`);
  if (originOnly) {
    if (u.pathname !== "/" || u.search || u.hash) throw err(400, `${what} should be just the site, like https://useclaudia.xyz.`);
    return u.origin;
  }
  // RPC URLs often carry an API key in the path or query, so keep them whole.
  return u.href.replace(/\/+$/, "");
}

/** Readable message for SDK errors. */
export function explain(e) {
  if (e instanceof ClaudiaApiError) {
    const wait = e.retryAfter ? ` Try again in ${Math.ceil(e.retryAfter)} s.` : "";
    const map = {
      rate_limited: "Claudia's posting limit for your agent was hit." + wait,
      daily_limit: "Your agent reached today's post limit." + wait,
      duplicate: "Claudia refused this as a duplicate post.",
      near_duplicate: "Claudia refused this as too similar to a recent post.",
      content_rejected: "Claudia's filters refused this post.",
      tier_too_low: "Your agent's tier can't post in that room.",
      passport_required: "Your agent needs an on-chain passport for this (claudia passport).",
      bad_signature: "Claudia couldn't verify the request signature. Check that the device key matches the one registered for this API key.",
      stale_timestamp: "Your computer's clock is more than 5 minutes off. Fix the clock and try again.",
      invalid_key: "Claudia doesn't accept this API key (revoked or mistyped).",
      coming_soon: "This Claudia server isn't open yet (coming soon).",
      agent_quarantined: "Your agent is quarantined on Claudia, so it can't post right now.",
      room_frozen: "That room is frozen right now.",
      outside_posting_off: "Posting from outside agents is switched off on Claudia right now.",
    };
    return { status: e.status >= 400 && e.status < 600 ? e.status : 502, code: e.code, message: map[e.code] || e.message || `Claudia answered ${e.status}` };
  }
  if (e instanceof ClaudiaError) return { status: 400, code: e.code, message: e.message };
  return { status: e.status || 500, code: e.code, message: e.message || String(e) };
}

// ── clients ────────────────────────────────────────────────────────────────
let pubCache = { url: "", client: null };
export function publicClient() {
  const { baseUrl } = getConfig().claudia;
  if (pubCache.url !== baseUrl) pubCache = { url: baseUrl, client: new ClaudiaClient({ baseUrl, timeoutMs: 15_000 }) };
  return pubCache.client;
}

export function isConnected() {
  return vault.has("claudiaApiKey") && vault.has("deviceKey");
}

export function agentClient() {
  if (!isConnected()) throw err(409, "Connect your Claudia agent first (Claudia → Your agent).", "not_connected");
  const c = getConfig().claudia;
  return new ClaudiaClient({ baseUrl: c.baseUrl, apiKey: vault.get("claudiaApiKey"), deviceKey: vault.get("deviceKey"), rpcUrl: c.rpcUrl || undefined, timeoutMs: 20_000 });
}

async function network() {
  try { return (await publicClient().platform()).network || "mainnet"; } catch { return "mainnet"; }
}

export async function rpcUrl() {
  const c = getConfig().claudia;
  return c.rpcUrl || defaultRpcUrl(await network());
}

export function walletAddress() {
  return vault.has("walletKey") ? publicKeyOf(vault.get("walletKey")) : null;
}

export function devicePublicKey() {
  return vault.has("deviceKey") ? publicKeyOf(vault.get("deviceKey")) : null;
}

// ── connection setup ───────────────────────────────────────────────────────
export function status() {
  const c = getConfig().claudia;
  return {
    baseUrl: c.baseUrl,
    rpcUrl: c.rpcUrl,
    source: c.source,
    connected: isConnected(),
    apiKey: vault.mask("claudiaApiKey"),
    devicePublicKey: devicePublicKey(),
    walletAddress: walletAddress(),
    agent: c.agent,
    caps: c.caps,
    liveTrading: c.liveTrading,
    spentToday: spentToday(),
    room: c.room,
  };
}

/** Manual setup: base URL, API key, device key and wallet (each optional; null removes). */
export async function connect({ baseUrl, rpcUrl: rpc, apiKey, deviceKey, walletKey }) {
  const cfg = getConfig();
  if (baseUrl !== undefined) cfg.claudia.baseUrl = checkUrl(baseUrl || "https://useclaudia.xyz", "The Claudia address", { originOnly: true });
  if (rpc !== undefined) cfg.claudia.rpcUrl = rpc ? checkUrl(rpc, "The Solana RPC address") : "";
  const patch = {};
  if (apiKey !== undefined) {
    const k = String(apiKey || "").trim();
    if (k && !/^ck_(live|test)_[A-Za-z0-9_-]{8,200}$/.test(k)) throw err(400, "That doesn't look like a Claudia API key (it starts with ck_live_).");
    patch.claudiaApiKey = k || null;
  }
  for (const [field, val] of [["deviceKey", deviceKey], ["walletKey", walletKey]]) {
    if (val === undefined) continue;
    const s = String(val || "").trim();
    if (!s) { patch[field] = null; continue; }
    try { patch[field] = toBase58(toKeypair(s).secretKey); } catch { throw err(400, `The ${field === "deviceKey" ? "device key" : "wallet key"} isn't a valid Solana secret key (base58 or a JSON byte array).`); }
  }
  vault.set(patch);
  cfg.claudia.source = "manual";
  cfg.claudia.agent = null;
  saveConfig(cfg);
  trackActivity("claudia", "Claudia connection updated");
  let meError = null;
  if (isConnected()) await refreshMe().catch(e => { meError = explain(e).message; });
  return { ...status(), meError };
}

/** Same as `claudia init`: a new device key and/or agent wallet, kept in the vault. Prints only public keys. */
export function generateKeys({ device = false, wallet = false, force = false } = {}) {
  const patch = {};
  if (device) {
    if (vault.has("deviceKey") && !force) throw err(409, "You already have a device key. Replacing it means registering the new one on Claudia.");
    patch.deviceKey = generateDeviceKey().secretKey;
  }
  if (wallet) {
    if (vault.has("walletKey") && !force) throw err(409, "You already have an agent wallet. Replacing it loses access to whatever is in the old one unless you exported it.");
    patch.walletKey = generateWallet().secretKey;
  }
  vault.set(patch);
  trackActivity("claudia", `Created ${[device && "a device key", wallet && "an agent wallet"].filter(Boolean).join(" and ")}`);
  return { devicePublicKey: devicePublicKey(), walletAddress: walletAddress() };
}

/** What `@useclaudia/cli` left in ~/.claudia (public parts only). */
export function homeInfo() {
  const dir = defaultHomeDir();
  const h = new ClaudiaHome({ dir, env: {} });
  if (!h.exists() && !existsSync(join(dir, "device.json"))) return { dir, found: false };
  let cfg = null;
  try { cfg = h.config(); } catch { /* */ }
  return {
    dir, found: true, encrypted: h.isEncrypted(),
    devicePublicKey: h.devicePublicKey() || null, walletAddress: h.walletAddress() || null, hasApiKey: h.hasApiKey(),
    baseUrl: cfg?.baseUrl || null, agent: cfg?.agent || null, caps: cfg?.caps || null,
  };
}

/** Copies the CLI's keys into this app's vault (encrypted with your Claudia Local passphrase). */
export async function importHome({ passphrase } = {}) {
  const dir = defaultHomeDir();
  const h = new ClaudiaHome({ dir, env: {}, passphrase: passphrase || undefined });
  if (!h.exists()) throw err(404, `No Claudia setup found in ${dir.replace(homedir(), "~")}. Run "npx @useclaudia/cli init" first, or enter your keys by hand.`);
  let apiKey, device, wallet;
  try {
    apiKey = await h.apiKey();
    device = await h.deviceSecret();
    const kp = await h.walletKeypair();
    wallet = kp ? toBase58(kp.secretKey) : undefined;
  } catch (e) {
    if (e?.code === "passphrase_required") throw err(401, "Your ~/.claudia keys are encrypted. Enter the passphrase you used with claudia init --encrypt.", "passphrase_required");
    if (/passphrase/i.test(e?.message || "") || e?.name === "WrongPassphraseError") throw err(401, "That isn't the passphrase for ~/.claudia.", "wrong_passphrase");
    throw e;
  }
  const c = h.config();
  const cfg = getConfig();
  cfg.claudia.baseUrl = checkUrl(c.baseUrl || "https://useclaudia.xyz", "The Claudia address", { originOnly: true });
  if (c.rpcUrl) cfg.claudia.rpcUrl = checkUrl(c.rpcUrl, "The Solana RPC address");
  if (c.caps) cfg.claudia.caps = { maxSolPerTrade: Number(c.caps.maxSolPerTrade) || 0.05, maxSolPerDay: Number(c.caps.maxSolPerDay) || 0.2 };
  cfg.claudia.source = "claudia-home";
  cfg.claudia.agent = c.agent || null;
  saveConfig(cfg);
  vault.set({ claudiaApiKey: apiKey || null, deviceKey: device || null, walletKey: wallet || null });
  trackActivity("claudia", `Imported the Claudia setup from ${dir.replace(homedir(), "~")}`);
  if (isConnected()) await refreshMe().catch(() => {});
  return status();
}

export function disconnect({ keepWallet = true } = {}) {
  vault.set({ claudiaApiKey: null, deviceKey: null, ...(keepWallet ? {} : { walletKey: null }) });
  const cfg = getConfig();
  cfg.claudia.agent = null;
  cfg.claudia.source = "";
  saveConfig(cfg);
  trackActivity("claudia", "Disconnected the Claudia agent");
  return status();
}

export async function refreshMe() {
  const me = await agentClient().me();
  const cfg = getConfig();
  cfg.claudia.agent = { id: me.id, slug: me.slug, name: me.name, tier: me.tier, status: me.status, wallet: me.wallet || null, passport: !!me.passport, limits: me.limits, avatarUrl: me.avatarUrl || null };
  saveConfig(cfg);
  return me;
}

export async function walletInfo() {
  const address = walletAddress();
  if (!address) return { address: null, balanceSol: null };
  let balanceSol = null, error = null;
  try { balanceSol = await getSolBalance(await rpcUrl(), address); } catch (e) { error = String(e.message || e).split("\n")[0]; }
  const registered = getConfig().claudia.agent?.wallet || null;
  return { address, balanceSol, error, registered, matches: registered ? registered === address : null, network: await network() };
}

// ── reads ──────────────────────────────────────────────────────────────────
export const isClaudiaCoin = (t) => !!t && (t.key === CLAUDIA_KEY || t.launchedHere === true);

/** Full detail, refused for coins that weren't launched on Claudia. */
export async function coin(input) {
  let key;
  try { key = toTokenKey(input); } catch { throw err(400, "Give a coin mint, sol:<mint>, or $CLAUDIA."); }
  if (!key.startsWith("sol:")) throw err(400, "Only Solana coins for now. EVM chains are coming soon.");
  const c = publicClient();
  const [detail, agentInfo] = await Promise.all([c.token(key), c.tokenAgent(key).catch(() => null)]);
  if (!isClaudiaCoin(detail)) throw err(403, "That coin wasn't launched on Claudia. Claudia Local only covers $CLAUDIA and coins launched on Claudia.", "not_claudia_coin");
  return { ...detail, agentInfo };
}

export async function overview() {
  const c = publicClient();
  const home = await c.home();
  return home;
}

/** Coins launched on Claudia, newest first; with a query, a search narrowed to Claudia coins. */
export async function coins(q = "") {
  const c = publicClient();
  if (q.trim()) {
    const hits = await c.search(q.trim(), 50);
    return hits.filter(isClaudiaCoin).map(t => ({ key: t.key, name: t.name, symbol: t.symbol, imageUri: t.image || null, mcapUsd: t.mcapUsd, bondingPct: t.bondingPct, phase: t.phase, createdAt: new Date(t.createdAt).toISOString(), change1hPct: t.change1hPct }));
  }
  const home = await c.home();
  const out = [];
  const seen = new Set();
  const f = home.featured;
  if (f) { out.push({ key: f.key, name: f.name, symbol: f.symbol, imageUri: f.imageUri || null, mcapUsd: f.mcapUsd, change1hPct: f.change1hPct, featured: true }); seen.add(f.key); }
  for (const t of home.launched || []) if (!seen.has(t.key)) { seen.add(t.key); out.push(t); }
  return out;
}

export async function rooms() { return publicClient().rooms(); }
export async function thread(room = "general", { limit = 40, after } = {}) {
  const page = await publicClient().messages(room, { limit: Math.min(100, Math.max(1, limit)), after });
  return page.data;
}
export async function agents(q = "") { return (await publicClient().agents({ q: q || undefined, limit: 30 })).data; }
export async function agentProfile(slug) {
  const c = publicClient();
  const [p, trust] = await Promise.all([c.agent(slug), c.agentTrust(slug).catch(() => null)]);
  return { ...p, trustInfo: trust ? { trust: trust.trust } : null };
}

export async function post(room, content) {
  const text = String(content || "").trim();
  if (!text) throw err(400, "Write something first.");
  if (text.length > 2000) throw err(400, "Posts can be at most 2000 characters.");
  const r = await agentClient().post(room, text);
  trackActivity("claudia", r.held ? `Post held for review in #${room}: ${r.reason}` : `Posted in #${room}`);
  refreshMe().catch(() => {});
  return r;
}

// ── caps + spend ledger ────────────────────────────────────────────────────
const today = () => new Date().toISOString().slice(0, 10);
export function spentToday() {
  const f = readJsonFile(P.spend, { days: {} });
  return Number(f.days?.[today()]?.sol || 0);
}
function recordSpend(entry) {
  const f = readJsonFile(P.spend, { days: {} });
  const d = today();
  const day = f.days[d] || { sol: 0, entries: [] };
  day.sol = Math.round((day.sol + Math.max(0, entry.sol)) * 1e9) / 1e9;
  day.entries.push({ at: new Date().toISOString(), ...entry });
  f.days[d] = day;
  for (const k of Object.keys(f.days).sort().slice(0, -30)) delete f.days[k];
  writeJsonFile(P.spend, f);
}
export function checkCaps(sol) {
  const { caps } = getConfig().claudia;
  if (!Number.isFinite(sol) || sol < 0) throw err(400, "The amount must be a positive number of SOL.");
  if (sol > caps.maxSolPerTrade + 1e-12) throw err(403, `${sol} SOL is over your per-trade cap of ${caps.maxSolPerTrade} SOL. Change it under Claudia → Your agent → Limits.`, "cap_exceeded");
  const left = Math.max(0, caps.maxSolPerDay - spentToday());
  if (sol > left + 1e-12) throw err(403, `${sol} SOL would go over your daily cap of ${caps.maxSolPerDay} SOL (${round(left)} SOL left today).`, "cap_exceeded");
  return { left };
}
const round = (n) => Math.round(n * 1e6) / 1e6;

// ── previews (dry run) and confirmed execution ─────────────────────────────
const previews = new Map(); // id -> { kind, data, expires }
setInterval(() => { const now = Date.now(); for (const [k, v] of previews) if (v.expires < now) previews.delete(k); }, 30_000).unref();

async function guards(spendSol, what) {
  const client = agentClient();
  const me = await client.me();
  if (me.status !== "active") throw err(409, `Your agent is ${me.status} on Claudia, so it can't ${what}.`);
  const address = walletAddress();
  if (!address) throw err(409, "There's no agent wallet in this app yet. Create one or import it under Claudia → Your agent.");
  if (!me.wallet) throw err(409, `No wallet is registered for your agent on Claudia yet. Register ${address} as the agent wallet (claudia passport).`);
  if (me.wallet !== address) throw err(409, `Your agent's registered wallet is ${me.wallet}, but the wallet in this app is ${address}.`, "wallet_mismatch");
  if (spendSol > 0) checkCaps(spendSol);
  const rpc = await rpcUrl();
  const net = await network();
  let balance = null;
  try { balance = await getSolBalance(rpc, address); } catch { /* reported in the preview */ }
  return { client, me, rpc, net, balance, wallet: toKeypair(vault.get("walletKey")) };
}

async function simulate(signed, rpc) {
  try {
    const conn = connectionFor(rpc);
    for (const s of signed) {
      const tx = VersionedTransaction.deserialize(fromBase64(s.base64));
      const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed" });
      if (r.value.err) return { ok: false, error: `"${s.description}" would fail: ${JSON.stringify(r.value.err)}`, logs: (r.value.logs || []).slice(-6) };
    }
    return { ok: true };
  } catch (e) {
    return { ok: null, error: `Couldn't simulate on ${new URL(rpc).host}: ${String(e.message || e).split("\n")[0]}` };
  }
}

export async function quote({ token, side, amount, slippageBps }) {
  const key = toTokenKey(token);
  await coin(key); // Claudia coins only
  return agentClient().tradeQuote({ token: key, side, amount: Number(amount), slippageBps: slippageBps ? Number(slippageBps) : undefined });
}

/** Step 1 of a live trade: quote → sign locally → simulate. Nothing is sent. */
export async function previewTrade({ token, side, amount, slippageBps }) {
  if (!["buy", "sell"].includes(side)) throw err(400, "Side must be buy or sell.");
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || (side === "sell" && n > 100)) throw err(400, side === "buy" ? "Give the amount in SOL, e.g. 0.01." : "Sell a percent between 0 and 100.");
  const key = toTokenKey(token);
  const detail = await coin(key);
  const g = await guards(side === "buy" ? n : 0, side);
  const q = await g.client.tradeQuote({ token: key, side, amount: n, slippageBps: slippageBps ? Number(slippageBps) : undefined });
  if (q.signer !== g.wallet.publicKey.toBase58()) throw err(409, `The quote is for ${q.signer}, not this wallet.`, "wallet_mismatch");
  const signed = signTransactions(q, g.wallet); // proves the transactions are for this wallet and complete
  const sim = await simulate(signed, g.rpc);
  const warnings = []; // the quote's own notes are shown with the quote
  if (side === "buy" && g.balance !== null && g.balance < n + FEE_RESERVE_SOL) warnings.push(`The wallet has ${round(g.balance)} SOL; this needs about ${round(n + FEE_RESERVE_SOL)} SOL.`);
  if (g.balance === null) warnings.push("Couldn't read the wallet balance from your RPC.");
  const id = newId("pv_");
  const summary = {
    id, kind: "trade", side, token: key, symbol: detail.symbol, name: detail.name, amount: n, network: g.net,
    quote: q.quote, txCount: q.txs.length, signer: q.signer, balanceSol: g.balance, simulation: sim, warnings,
    caps: getConfig().claudia.caps, spentToday: spentToday(), liveTrading: getConfig().claudia.liveTrading, expiresAt: Date.now() + PREVIEW_TTL_MS,
  };
  previews.set(id, { kind: "trade", q, summary, expires: Date.now() + PREVIEW_TTL_MS });
  trackActivity("claudia", `Dry run: ${side} ${side === "buy" ? n + " SOL of" : n + "% of"} $${detail.symbol}`);
  return summary;
}

/** Step 2: the person confirmed this exact preview. */
export async function confirmTrade({ previewId, confirm }) {
  if (confirm !== true) throw err(400, "Not confirmed.");
  if (!getConfig().claudia.liveTrading) throw err(403, "Live trading is off. Switch it on under Claudia → Your agent → Limits first.", "live_off");
  const p = previews.get(previewId);
  if (!p || p.kind !== "trade") throw err(410, "This preview expired. Run the dry run again.", "preview_expired");
  previews.delete(previewId);
  const { summary: s, q } = p;
  if (s.simulation.ok === false) throw err(409, "The simulation failed, so this wasn't sent. " + (s.simulation.error || ""), "simulation_failed");
  if (s.side === "buy") checkCaps(s.amount);
  const c = agentClient();
  const signatures = await c.executeQuote(q, toKeypair(vault.get("walletKey")), { rpcUrl: await rpcUrl() });
  if (s.side === "buy") recordSpend({ kind: "buy", sol: s.amount, token: s.token, signatures });
  trackActivity("trade", `${s.side === "buy" ? "Bought" : "Sold"} ${s.side === "buy" ? s.amount + " SOL of" : s.amount + "% of"} $${s.symbol} (live)`);
  return { ok: true, signatures, explorer: signatures.map(x => explorerUrl("tx", x, s.network)) };
}

/** Step 1 of a launch: upload the picture, plan with Claudia, sign locally, check the caps. */
export async function previewLaunch({ name, symbol, description, image, devBuy = 0, twitter, telegram, website }) {
  const nm = normalizeCoinName(String(name || ""));
  if (!nm.ok) throw err(400, nm.error);
  const sym = normalizeTicker(String(symbol || ""));
  if (!sym.ok) throw err(400, sym.error);
  const dev = Number(devBuy) || 0;
  if (dev < 0) throw err(400, "The first buy can't be negative.");
  const g = await guards(dev, "launch");
  if (!g.me.passport) throw err(409, "Agents need an on-chain passport before launching (claudia passport).", "passport_required");
  let imageUri = String(image || "").trim();
  if (!imageUri) throw err(400, "Pick a picture for the coin (a file in your workspace or an https:// link).");
  if (!/^(https:\/\/|ipfs:\/\/)/i.test(imageUri)) {
    const { bytes, path } = ws.readBytes(imageUri);
    const type = imageTypeOf(new Uint8Array(bytes.subarray(0, 16)));
    if (!type) throw err(400, `${path} isn't a PNG, JPEG, GIF or WEBP picture.`);
    imageUri = (await g.client.uploadImage(new Uint8Array(bytes), path.split("/").pop(), type)).uri;
  }
  const planned = await g.client.launchPlan({
    name: nm.value, symbol: sym.value, imageUri, description: description ? String(description).slice(0, 500) : undefined,
    socials: { twitter: twitter || undefined, telegram: telegram || undefined, website: website || undefined }, devBuyNative: dev,
  });
  const p = planned.plan;
  const total = p.fees.totalNative;
  const left = Math.max(0, getConfig().claudia.caps.maxSolPerDay - spentToday());
  const warnings = [...(p.split.warnings || [])];
  if (total > left + 1e-12) warnings.push(`This costs about ${round(total)} SOL, more than what's left of your daily cap (${round(left)} SOL).`);
  if (g.balance !== null && g.balance < total + FEE_RESERVE_SOL) warnings.push(`The wallet has ${round(g.balance)} SOL; this needs about ${round(total + FEE_RESERVE_SOL)} SOL.`);
  if (!p.txs.length) throw err(502, "Claudia couldn't build the launch transactions. " + warnings.join(" "));
  signTransactions(planned, g.wallet);
  const id = newId("pv_");
  const summary = {
    id, kind: "launch", name: nm.value, symbol: sym.value, imageUri, network: g.net, mint: p.predicted.token || null, devBuy: dev,
    fees: p.fees, split: { creatorPct: p.split.creatorBps / 100, platformPct: p.split.platformBps / 100, creator: p.split.creator },
    devBuyPreview: p.devBuyPreview, simulation: p.simulation || null, warnings, balanceSol: g.balance, overCap: total > left + 1e-12,
    liveTrading: getConfig().claudia.liveTrading, expiresAt: Date.now() + PREVIEW_TTL_MS,
  };
  previews.set(id, { kind: "launch", planned, summary, expires: Date.now() + PREVIEW_TTL_MS });
  trackActivity("claudia", `Dry run: launch $${sym.value}`);
  return summary;
}

export async function confirmLaunch({ previewId, confirm }) {
  if (confirm !== true) throw err(400, "Not confirmed.");
  if (!getConfig().claudia.liveTrading) throw err(403, "Live trading is off. Switch it on under Claudia → Your agent → Limits first.", "live_off");
  const p = previews.get(previewId);
  if (!p || p.kind !== "launch") throw err(410, "This preview expired. Run the dry run again.", "preview_expired");
  previews.delete(previewId);
  const s = p.summary;
  if (s.overCap) throw err(403, "This launch is over your daily cap.", "cap_exceeded");
  if (s.simulation && s.simulation.ok === false) throw err(409, "The simulation failed, so this wasn't sent.", "simulation_failed");
  if (s.devBuy) checkCaps(s.devBuy);
  const r = await agentClient().executeLaunch(p.planned, toKeypair(vault.get("walletKey")), { rpcUrl: await rpcUrl() });
  recordSpend({ kind: "launch", sol: s.fees.totalNative, token: r.mint ? `sol:${r.mint}` : undefined, signatures: r.signatures });
  trackActivity("trade", `Launched $${s.symbol} (live)`);
  return { ok: true, mint: r.mint || s.mint, signatures: r.signatures, explorer: r.signatures.map(x => explorerUrl("tx", x, s.network)) };
}

// ── agent proposals (the agent can suggest; only you can act) ──────────────
export const listProposals = () => readJsonFile(P.proposals, []);
export function addProposal(p) {
  const entry = { id: newId("pr_"), ts: Date.now(), status: "open", ...p };
  writeJsonFile(P.proposals, [entry, ...listProposals()].slice(0, 100));
  trackActivity("claudia", `Your agent suggested: ${p.side} $${p.symbol} (${p.side === "buy" ? p.amount + " SOL" : p.amount + "%"})`);
  return entry;
}
export function dismissProposal(id) {
  writeJsonFile(P.proposals, listProposals().map(x => (x.id === id ? { ...x, status: "dismissed" } : x)));
}

// ── paper trading (simulated, never on-chain) ──────────────────────────────
const PAPER_START = 10;
export const paper = () => readJsonFile(P.paper, { startSol: PAPER_START, cashSol: PAPER_START, positions: {}, trades: [] });

export async function paperTrade({ token, side, amount }) {
  const d = await coin(token);
  const price = Number(d.priceNative);
  if (!(price > 0)) throw err(409, `There's no price for $${d.symbol} yet.`);
  const book = paper();
  const n = Number(amount);
  const pos = book.positions[d.key] || { symbol: d.symbol, name: d.name, tokens: 0, costSol: 0 };
  let trade;
  if (side === "buy") {
    if (!(n > 0)) throw err(400, "Give the amount in SOL, e.g. 0.5.");
    if (n > book.cashSol + 1e-12) throw err(400, `Your paper balance is ${round(book.cashSol)} SOL.`);
    const tokens = n / price;
    pos.tokens += tokens; pos.costSol += n; book.cashSol = round(book.cashSol - n);
    trade = { side, sol: n, tokens, price };
  } else if (side === "sell") {
    if (!(n > 0 && n <= 100)) throw err(400, "Sell a percent between 0 and 100.");
    if (!(pos.tokens > 0)) throw err(400, `You don't hold any paper $${d.symbol}.`);
    const tokens = pos.tokens * (n / 100);
    const sol = tokens * price;
    pos.costSol = pos.costSol * (1 - n / 100); pos.tokens -= tokens; book.cashSol = round(book.cashSol + sol);
    trade = { side, sol: round(sol), tokens, price, pct: n };
  } else throw err(400, "Side must be buy or sell.");
  if (pos.tokens <= 1e-9) delete book.positions[d.key]; else book.positions[d.key] = pos;
  book.trades = [{ id: newId("pt_"), ts: Date.now(), key: d.key, symbol: d.symbol, ...trade }, ...book.trades].slice(0, 300);
  writeJsonFile(P.paper, book);
  trackActivity("paper", `Paper ${side} $${d.symbol}: ${side === "buy" ? n + " SOL" : n + "%"}`);
  return { trade: book.trades[0], cashSol: book.cashSol };
}

export async function paperPortfolio() {
  const book = paper();
  const rows = [];
  for (const [key, p] of Object.entries(book.positions)) {
    let price = null;
    try { price = Number((await publicClient().token(key)).priceNative) || null; } catch { /* offline */ }
    const value = price ? p.tokens * price : null;
    rows.push({ key, symbol: p.symbol, name: p.name, tokens: p.tokens, costSol: round(p.costSol), valueSol: value === null ? null : round(value), pnlSol: value === null ? null : round(value - p.costSol) });
  }
  const valued = rows.reduce((s, r) => s + (r.valueSol ?? r.costSol), 0);
  return { startSol: book.startSol, cashSol: book.cashSol, positions: rows, totalSol: round(book.cashSol + valued), trades: book.trades.slice(0, 50) };
}

export function paperReset() {
  writeJsonFile(P.paper, { startSol: PAPER_START, cashSol: PAPER_START, positions: {}, trades: [] });
  trackActivity("paper", "Paper account reset to 10 SOL");
}
