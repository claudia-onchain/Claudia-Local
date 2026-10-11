/**
 * claudia.js — everything that talks to Claudia (useclaudia.xyz), through @useclaudia/sdk.
 *
 *  - Public reads: chains, $CLAUDIA, coins launched on Claudia (Solana and Robinhood Chain), the thread, agents.
 *  - Your agent: API key (ck_live_…) + device key sign every /api/v1 request; the agent wallet signs
 *    Solana transactions locally. Robinhood Chain (beta) uses your own 0x wallet (evm.js). All in the vault.
 *  - Money paths (buy, sell, launch, sweep): a dry run first (quote or plan, amounts and decimals checked,
 *    signed locally to check it, simulated on your RPC), then an explicit confirm within 60 s from the
 *    dashboard, inside per-chain caps (policy.js), and only when live trading is switched on. Paper trades
 *    never touch the chain.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import {
  ClaudiaClient, ClaudiaApiError, ClaudiaError, CLAUDIA_TOKEN, CHAINS, CHAIN_ORDER, assertChainOpen, chainOfKey, isEvmAddress, isPublicKey,
  toTokenKey, generateDeviceKey, generateWallet, publicKeyOf, toKeypair, toBase58, getSolBalance, signTransactions, sendAndConfirm,
  connectionFor, defaultRpcUrl, explorerUrl, normalizeTicker, normalizeCoinName, imageTypeOf,
} from "@useclaudia/sdk";
import { ClaudiaHome, defaultHomeDir } from "@useclaudia/sdk/node";
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as vault from "./vault.js";
import * as ws from "./workspace.js";
import * as wallets from "./wallets.js";
import * as policy from "./policy.js";
import * as solCheck from "./sol-check.js";
import * as evm from "./evm.js";
import { safeMediaPath } from "./studio.js";
import { P } from "./paths.js";
import { getConfig, saveConfig, readJsonFile, writeJsonFile, newId, trackActivity } from "./store.js";

export const CLAUDIA_KEY = `sol:${CLAUDIA_TOKEN.mint}`;
const FEE_RESERVE_SOL = 0.005;

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

/** The device key's public half, creating the key first if this app doesn't have one (one-click connect). */
export function ensureDeviceKey() {
  if (!vault.has("deviceKey")) { vault.set({ deviceKey: generateDeviceKey().secretKey }); trackActivity("claudia", "Created a device key"); }
  return devicePublicKey();
}

// ── connection setup ───────────────────────────────────────────────────────
export function status() {
  const c = getConfig().claudia;
  return {
    baseUrl: c.baseUrl,
    rpcUrl: c.rpcUrl,
    hoodRpcUrl: c.hoodRpcUrl,
    source: c.source,
    connected: isConnected(),
    apiKey: vault.mask("claudiaApiKey"),
    devicePublicKey: devicePublicKey(),
    walletAddress: walletAddress(),
    evmAddress: wallets.evmAddress(),
    hot: { sol: { address: wallets.hotAddress("sol"), use: !!c.hot.sol && wallets.hasHot("sol") }, hood: { address: wallets.hotAddress("hood"), use: !!c.hot.hood && wallets.hasHot("hood") } },
    agent: c.agent,
    caps: c.caps,
    capsLeft: { sol: policy.capsLeft("sol"), hood: policy.capsLeft("hood") },
    chain: c.chain,
    liveTrading: c.liveTrading,
    spentToday: spentToday(),
    room: c.room,
  };
}

/** Manual setup: base URL, API key, device key and wallet (each optional; null removes). */
export async function connect({ baseUrl, rpcUrl: rpc, hoodRpcUrl, apiKey, deviceKey, walletKey }) {
  const cfg = getConfig();
  if (baseUrl !== undefined) cfg.claudia.baseUrl = checkUrl(baseUrl || "https://useclaudia.xyz", "The Claudia address", { originOnly: true });
  if (rpc !== undefined) cfg.claudia.rpcUrl = rpc ? checkUrl(rpc, "The Solana RPC address") : "";
  if (hoodRpcUrl !== undefined) cfg.claudia.hoodRpcUrl = hoodRpcUrl ? checkUrl(hoodRpcUrl, "The Robinhood Chain RPC address") : "";
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
  if (c.caps) cfg.claudia.caps = { ...cfg.claudia.caps, maxSolPerTrade: Number(c.caps.maxSolPerTrade) || 0.05, maxSolPerDay: Number(c.caps.maxSolPerDay) || 0.2, ...(c.caps.maxEthPerTrade ? { maxEthPerTrade: Number(c.caps.maxEthPerTrade), maxEthPerDay: Number(c.caps.maxEthPerDay) || 0.04 } : {}) };
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
/** $CLAUDIA on Solana, or a coin launched on Claudia, checked on the coin's own chain. */
export const isClaudiaCoin = (t) => !!t && (t.key === CLAUDIA_KEY || (t.launchedHere === true && (!t.chain || !t.key || chainOfKey(t.key) === t.chain)));

/**
 * "sol:<mint>" or "hood:0x…" from a mint, a 0x address, a key or $CLAUDIA. `chain` (optional, default from the
 * input, else Solana) only applies to bare addresses. BNB Chain is refused as coming soon.
 */
export function tokenKey(input, chain) {
  let key;
  const c = chain === "hood" || chain === "bsc" ? chain : undefined;
  try { key = toTokenKey(String(input ?? "").trim(), c); } catch { throw err(400, "Give a Solana mint, a Robinhood Chain 0x address, sol:<mint>, hood:0x…, or $CLAUDIA."); }
  if (key === "claudia") key = CLAUDIA_KEY;
  const on = chainOfKey(key);
  if (on === "bsc") throw err(403, "BNB Chain is coming soon on Claudia.", "chain_coming_soon");
  if (on !== "sol" && on !== "hood") throw err(400, "Claudia Local covers Solana and Robinhood Chain (beta).");
  return key;
}

/** Full detail, refused for coins that weren't launched on Claudia. */
export async function coin(input) {
  const key = tokenKey(input);
  const c = publicClient();
  const [detail, agentInfo] = await Promise.all([c.token(key), c.tokenAgent(key).catch(() => null)]);
  if (!isClaudiaCoin(detail)) throw err(403, "That coin wasn't launched on Claudia. Claudia Local only covers $CLAUDIA and coins launched on Claudia.", "not_claudia_coin");
  const chain = chainOfKey(detail.key || key);
  return { ...detail, chain, unit: CHAINS[chain].nativeSymbol, agentInfo };
}

export async function overview() {
  const c = publicClient();
  const home = await c.home();
  return home;
}

const card = (t) => ({ key: t.key, chain: t.chain, name: t.name, symbol: t.symbol, imageUri: t.image || null, mcapUsd: t.mcapUsd, bondingPct: t.bondingPct, phase: t.phase, createdAt: new Date(t.createdAt).toISOString(), change1hPct: t.change1hPct, launchpad: t.launchpad });

/** Coins launched on Claudia, newest first; with a query, a search narrowed to Claudia coins. Per chain. */
export async function coins(q = "", chain = "sol") {
  const c = publicClient();
  if (chain === "bsc") return [];
  const onChain = (t) => chainOfKey(t.key) === chain;
  if (q.trim()) {
    const hits = await c.search(q.trim(), 50);
    return hits.filter(t => isClaudiaCoin(t) && onChain(t)).map(card);
  }
  if (chain === "hood") {
    const board = await c.board("hood", undefined, 200);
    return board.filter(isClaudiaCoin).sort((a, b) => b.createdAt - a.createdAt).map(card);
  }
  const home = await c.home();
  const out = [];
  const seen = new Set();
  const f = home.featured;
  if (f) { out.push({ key: f.key, name: f.name, symbol: f.symbol, imageUri: f.imageUri || null, mcapUsd: f.mcapUsd, change1hPct: f.change1hPct, featured: true }); seen.add(f.key); }
  for (const t of home.launched || []) if (!seen.has(t.key) && onChain(t)) { seen.add(t.key); out.push(t); }
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

// ── chains ─────────────────────────────────────────────────────────────────
let chainCache = { at: 0, url: "", list: null };
/** Solana, Robinhood Chain (beta), BNB Chain (coming soon), with the site's live switches when reachable. */
export async function chainList() {
  const url = getConfig().claudia.baseUrl;
  if (chainCache.list && chainCache.url === url && Date.now() - chainCache.at < 60_000) return chainCache.list;
  try {
    const list = await publicClient().chainStatus(true);
    chainCache = { at: Date.now(), url, list };
    return list;
  } catch {
    // Claudia didn't answer: what the SDK knows. Solana stays open; Robinhood Chain can be viewed but not
    // traded or launched on until the site says it's open; BSC stays closed.
    return CHAIN_ORDER.map(id => {
      const status = id === "sol" ? "live" : id === "hood" ? "view_only" : "coming_soon";
      return { ...CHAINS[id], status, state: status === "live" ? "open" : status, note: id === "hood" ? "Claudia didn't say Robinhood Chain is open, so it's view only for now." : null, launchpads: [] };
    });
  }
}

export async function chainsView() {
  const list = await chainList();
  return list.map(c => ({ id: c.id, name: c.name, unit: c.nativeSymbol, status: c.status, note: c.note, open: c.status === "live" || c.status === "beta", explorer: c.explorerName }));
}

/** Throws a plain message unless trades and launches are open on `chain`. */
export async function assertOpen(chain) {
  try { return assertChainOpen(await chainList(), chain); } catch (e) {
    const name = CHAINS[chain]?.name || chain;
    if (e?.code === "chain_view_only") throw err(403, `${name} is view-only on Claudia right now: no trades or launches.`, e.code);
    throw err(403, `${name} is coming soon on Claudia.`, e?.code || "chain_coming_soon");
  }
}

/**
 * If a Claudia agent is connected, it must be active for any money action on any chain. Checked at the dry
 * run and again at confirm time (an agent can be quarantined in between).
 */
export async function agentGate(what) {
  if (!isConnected()) return null;
  const me = await agentClient().me();
  if (me.status !== "active") throw err(409, `Your agent is ${me.status} on Claudia, so it can't ${what}.`, "agent_inactive");
  return me;
}

evm.init({ publicClient, coin: (k) => coin(k), assertOpen, agentGate, chainList });

// ── caps (per chain, see policy.js) ────────────────────────────────────────
export const spentToday = () => policy.spentToday("sol", "buy");
export const checkCaps = (sol) => policy.checkCaps("sol", sol, "buy");
const round = (n) => Math.round(n * 1e6) / 1e6;

// ── Solana: dry run first, then a person confirms ──────────────────────────
function solSigner() {
  const hot = getConfig().claudia.hot.sol && wallets.hasHot("sol");
  if (hot) return { hot: true, address: wallets.hotAddress("sol"), keypair: toKeypair(wallets.hotKey("sol")) };
  const address = walletAddress();
  if (!address) throw err(409, "There's no agent wallet in this app yet. Create one or import it under Claudia → Your agent.");
  return { hot: false, address, keypair: toKeypair(vault.get("walletKey")) };
}

/** Agent status, the signing wallet, and (for the agent wallet) that it's the one registered on Claudia. */
async function guards(what) {
  const s = solSigner();
  let me = null;
  if (!s.hot) {
    if (!isConnected()) throw err(409, "Connect your Claudia agent first (Claudia → Your agent).", "not_connected");
    me = await agentGate(what);
    if (!me.wallet) throw err(409, `No wallet is registered for your agent on Claudia yet. Register ${s.address} as the agent wallet (claudia passport).`);
    if (me.wallet !== s.address) throw err(409, `Your agent's registered wallet is ${me.wallet}, but the wallet in this app is ${s.address}.`, "wallet_mismatch");
  } else me = await agentGate(what);
  const rpc = await rpcUrl();
  let balance = null;
  try { balance = await getSolBalance(rpc, s.address); } catch { /* reported in the preview */ }
  return { ...s, me, rpc, net: await network(), balance };
}

/** A quote for the agent wallet (or the hot wallet) on Solana; Robinhood coins go to evm.js. */
export async function quote({ token, side, amount, slippageBps, chain }) {
  const key = tokenKey(token, chain);
  if (chainOfKey(key) === "hood") return evm.quote({ token: key, side, amount, slippageBps });
  await coin(key); // Claudia coins only
  const s = solSigner();
  if (s.hot) return { chain: "sol", unit: "SOL", quote: await publicClient().quote({ token: key, side, amount: Number(amount), trader: s.address, slippageBps: slippageBps ? Number(slippageBps) : undefined }) };
  const q = await agentClient().tradeQuote({ token: key, side, amount: Number(amount), slippageBps: slippageBps ? Number(slippageBps) : undefined });
  return { chain: "sol", unit: "SOL", ...q };
}

/** Step 1 of a live trade: quote → check amounts and decimals → sign locally → simulate. Nothing is sent. */
export async function previewTrade({ token, side, amount, slippageBps, source = "user", chain }) {
  const key = tokenKey(token, chain);
  if (chainOfKey(key) === "hood") return evm.previewTrade({ token: key, side, amount, slippageBps, source });
  if (!["buy", "sell"].includes(side)) throw err(400, "Side must be buy or sell.");
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || (side === "sell" && n > 100)) throw err(400, side === "buy" ? "Give the amount in SOL, e.g. 0.01." : "Sell a percent between 0 and 100.");
  await assertOpen("sol");
  const detail = await coin(key);
  const mint = detail.address || key.slice(4);
  const g = await guards(side);
  if (side === "buy") policy.checkCaps("sol", n, "buy");
  const slip = slippageBps ? Number(slippageBps) : undefined;
  const q = g.hot
    ? { ...(await publicClient().tradePrepare({ token: key, side, ...(side === "buy" ? { amountNative: n } : { pct: n }), trader: g.address, slippageBps: slip })), signer: g.address, note: "" }
    : await agentClient().tradeQuote({ token: key, side, amount: n, slippageBps: slip });
  if (q.signer !== g.address) throw err(409, `The quote is for ${q.signer}, not this wallet.`, "wallet_mismatch");
  if (!q.txs.length) throw err(502, "Claudia returned no transactions for this trade.");
  if (q.txs.some(t => t.kind !== "svm")) throw err(409, "Claudia returned a transaction for another chain.", "wrong_chain");

  // Decimals from the chain (and the SDK for $CLAUDIA): they must agree.
  const conn = connectionFor(g.rpc);
  let mi;
  try { mi = await solCheck.mintInfo(conn, mint); } catch (e) { throw err(e.status || 502, `Couldn't read $${detail.symbol} on Solana: ${e.message}`); }
  if (key === CLAUDIA_KEY && mi.decimals !== CLAUDIA_TOKEN.decimals) throw err(409, `$CLAUDIA should have ${CLAUDIA_TOKEN.decimals} decimals, but the chain says ${mi.decimals}. Nothing was signed.`, "decimals_mismatch");
  const unit = 10 ** mi.decimals;
  let valueSol, balanceRaw = 0n;
  if (side === "buy") {
    policy.checkSpend("sol", n, Number(q.quote.amountIn), "The quote");
    valueSol = n;
  } else {
    balanceRaw = await solCheck.tokenBalanceRaw(conn, g.address, mint);
    if (balanceRaw === 0n) throw err(409, `This wallet holds no $${detail.symbol}.`);
    if (q.quote.balanceTokens !== undefined) policy.checkDecimals({ what: "Your balance", ui: q.quote.balanceTokens, raw: balanceRaw, decimals: mi.decimals, symbol: detail.symbol });
    valueSol = Number(q.quote.expectedOut);
    policy.checkCaps("sol", valueSol, "sell");
  }

  signTransactions(q, g.keypair); // proves the transactions are for this wallet and complete
  const sim = await solCheck.inspect(conn, q.txs, { wallet: g.address, mint });
  const tokens = Number(sim.tokenDeltaRaw) / unit;
  if (sim.ok === true) {
    if (side === "buy") {
      policy.checkSpend("sol", n, solCheck.lamportsToSol(sim.spendLamports), "These transactions");
      policy.checkTokenAmount({ what: "Tokens you receive", expected: Number(q.quote.expectedOut), actual: tokens, maxRatio: 2, symbol: detail.symbol });
    } else {
      policy.checkTokenAmount({ what: "Tokens you sell", expected: (Number(balanceRaw) / unit) * (n / 100), actual: -tokens, symbol: detail.symbol });
    }
  }
  const warnings = [];
  if (side === "buy" && g.balance !== null && g.balance < n + FEE_RESERVE_SOL) warnings.push(`The wallet has ${round(g.balance)} SOL; this needs about ${round(n + FEE_RESERVE_SOL)} SOL.`);
  if (g.balance === null) warnings.push("Couldn't read the wallet balance from your RPC.");
  if (policy.needsConfirm(source)) warnings.push("This trade was suggested from outside content. Check it yourself before confirming.");
  const summary = {
    kind: "trade", chain: "sol", chainName: CHAINS.sol.name, unit: "SOL", side, token: key, symbol: detail.symbol, name: detail.name, amount: n, network: g.net,
    quote: q.quote, expectedReceive: side === "buy" ? { amount: Number(q.quote.expectedOut), unit: `$${detail.symbol}`, min: Number(q.quote.minOut) } : { amount: Number(q.quote.expectedOut), unit: "SOL", min: Number(q.quote.minOut) },
    sellTokens: side === "sell" ? Math.round((Number(balanceRaw) / unit) * (n / 100) * 1e4) / 1e4 : undefined,
    valueNative: round(valueSol), txCount: q.txs.length, signer: q.signer, walletKind: g.hot ? "hot" : "main", balanceNative: g.balance, balanceSol: g.balance, decimals: mi.decimals,
    simulation: { ok: sim.ok, error: sim.error, logs: sim.logs, feeSol: solCheck.lamportsToSol(sim.feesLamports), spendSol: sim.ok ? solCheck.lamportsToSol(sim.spendLamports) : null, tokens: sim.ok ? Math.round(tokens * 1e4) / 1e4 : null },
    caps: policy.capsLeft("sol"), warnings, source, liveTrading: getConfig().claudia.liveTrading,
  };
  const { id, expiresAt } = policy.savePreview("trade", "sol", { q, summary, hot: g.hot });
  trackActivity("claudia", `Dry run: ${side} ${side === "buy" ? n + " SOL of" : n + "% of"} $${detail.symbol}`);
  return { id, expiresAt, ...summary };
}

/** Step 2: the person confirmed this exact preview. Everything that can change is checked again. */
export async function confirmTrade({ previewId, confirm, chain }) {
  const p = policy.takePreview(previewId, "trade", confirm);
  if (chain && chain !== p.chain) throw err(409, "This preview is for another chain.", "wrong_chain");
  if (p.chain === "hood") return evm.confirmTrade(p);
  const { summary: s, q } = p;
  if (s.simulation.ok !== true) throw err(409, "The simulation didn't pass, so this wasn't sent. " + (s.simulation.error || ""), "simulation_failed");
  await assertOpen("sol");
  const g = await guards(s.side); // agent still active, same wallet, still the registered one
  if (g.address !== s.signer || g.hot !== p.hot) throw err(409, `The wallet changed since the dry run (${s.signer} → ${g.address}). Run the dry run again.`, "wallet_mismatch");
  policy.checkCaps("sol", s.valueNative, s.side === "buy" ? "buy" : "sell");
  const signatures = g.hot
    ? await sendAndConfirm(signTransactions(q, g.keypair), g.rpc)
    : await agentClient().executeQuote(q, g.keypair, { rpcUrl: g.rpc });
  policy.recordSpend("sol", s.side, { native: s.valueNative, token: s.token, signatures });
  trackActivity("trade", `${s.side === "buy" ? "Bought" : "Sold"} ${s.side === "buy" ? s.amount + " SOL of" : s.amount + "% of"} $${s.symbol} (live)`);
  return { ok: true, chain: "sol", signatures, explorer: signatures.map(x => explorerUrl("tx", x, s.network)) };
}

// ── launch pictures: uploads, the media library or the workspace ───────────
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;
const uploaded = new Map(); // sha256 -> uri (a second dry run with the same picture doesn't upload it again)

/** Pictures you can launch with: your uploads, the studio's media library and the workspace. Newest first. */
export function launchImages() {
  const out = [];
  const walk = (dir, source, depth = 0) => {
    if (depth > 6 || !existsSync(dir) || out.length > 300) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isSymbolicLink()) continue;
      const f = join(dir, e.name);
      if (e.isDirectory()) { walk(f, source, depth + 1); continue; }
      if (!e.isFile() || !IMAGE_EXT.test(e.name)) continue;
      const st = statSync(f);
      if (st.size > 4 * 1024 * 1024) continue;
      out.push({ path: source === "workspace" ? ws.display(f) : f, name: e.name, source, size: st.size, modified: st.mtimeMs });
    }
  };
  walk(P.uploads, "uploads");
  walk(join(P.media, "library"), "library");
  walk(ws.root(), "workspace");
  return out.sort((a, b) => b.modified - a.modified).slice(0, 200);
}

/** https:// and ipfs:// links pass through; files are read from uploads, the library or the workspace. */
function readLaunchImage(image) {
  const src = String(image || "").trim();
  if (!src) throw err(400, "Pick a picture for the coin (from your uploads, the media library, the workspace, or an https:// link).");
  if (/^(https:\/\/|ipfs:\/\/)/i.test(src)) return { uri: src };
  const full = safeMediaPath(src);
  const st = statSync(full);
  if (st.size > 4 * 1024 * 1024) throw err(413, "Coin pictures must be 4 MB or smaller.");
  const bytes = readFileSync(full);
  const type = imageTypeOf(new Uint8Array(bytes.subarray(0, 16)));
  if (!type) throw err(400, `${basename(full)} isn't a PNG, JPEG, GIF or WEBP picture.`);
  return { bytes, type, name: basename(full) };
}

async function uploadLaunchImage(client, img) {
  if (img.uri) return img.uri;
  const h = createHash("sha256").update(img.bytes).digest("hex");
  if (uploaded.has(h)) return uploaded.get(h);
  const uri = (await client.uploadImage(new Uint8Array(img.bytes), img.name, img.type)).uri;
  uploaded.set(h, uri);
  trackActivity("claudia", `Uploaded ${img.name} to Claudia for a launch`);
  return uri;
}

/**
 * Step 1 of a launch: local checks first (name, ticker, picture, wallet, caps), then the picture and the coin's
 * details are uploaded to Claudia (they're public once the coin launches) so Claudia can plan it. The plan is
 * signed locally to check it. Nothing goes on-chain until you confirm.
 */
export async function previewLaunch({ chain = "sol", name, symbol, description, image, devBuy = 0, launchpad, twitter, telegram, website, source = "user" }) {
  const img = readLaunchImage(image); // before anything leaves this computer
  if (chain === "hood") {
    await evm.checkLaunch({ name, symbol, devBuy, launchpad }); // before anything is uploaded
    const imageUri = await uploadLaunchImage(publicClient(), img);
    return evm.previewLaunch({ name, symbol, description, imageUri, devBuy, launchpad, twitter, telegram, website, source });
  }
  if (chain !== "sol") throw err(403, `${CHAINS[chain]?.name || "That chain"} is coming soon on Claudia.`, "chain_coming_soon");
  await assertOpen("sol");
  const nm = normalizeCoinName(String(name || ""));
  if (!nm.ok) throw err(400, nm.error);
  const sym = normalizeTicker(String(symbol || ""));
  if (!sym.ok) throw err(400, sym.error);
  const dev = Number(devBuy) || 0;
  if (dev < 0) throw err(400, "The first buy can't be negative.");
  if (dev > 0) policy.checkCaps("sol", dev, "buy");
  const g = await guards("launch");
  if (g.hot) throw err(409, "Launches on Solana use your agent wallet (the creator share goes there). Switch the hot wallet off for launches.");
  if (!g.me?.passport) throw err(409, "Agents need an on-chain passport before launching (claudia passport).", "passport_required");
  const client = agentClient();
  const imageUri = await uploadLaunchImage(client, img);
  const planned = await client.launchPlan({
    name: nm.value, symbol: sym.value, imageUri, description: description ? String(description).slice(0, 500) : undefined,
    socials: { twitter: twitter || undefined, telegram: telegram || undefined, website: website || undefined }, devBuyNative: dev,
  });
  const p = planned.plan;
  const total = p.fees.totalNative;
  const left = policy.capsLeft("sol").leftToday;
  const warnings = [...(p.split.warnings || [])];
  if (total > left + 1e-12) warnings.push(`This costs about ${round(total)} SOL, more than what's left of your daily cap (${round(left)} SOL).`);
  if (g.balance !== null && g.balance < total + FEE_RESERVE_SOL) warnings.push(`The wallet has ${round(g.balance)} SOL; this needs about ${round(total + FEE_RESERVE_SOL)} SOL.`);
  if (policy.needsConfirm(source)) warnings.push("This launch was suggested from outside content. Check it yourself before confirming.");
  if (!p.txs.length) throw err(502, "Claudia couldn't build the launch transactions. " + warnings.join(" "));
  if (p.txs.some(t => t.kind !== "svm")) throw err(409, "Claudia returned a transaction for another chain.", "wrong_chain");
  signTransactions(planned, g.keypair);
  const summary = {
    kind: "launch", chain: "sol", chainName: CHAINS.sol.name, unit: "SOL", launchpad: "pump", launchpadName: "pump.fun", name: nm.value, symbol: sym.value, imageUri, network: g.net,
    mint: p.predicted.token || null, devBuy: dev, fees: p.fees, split: { creatorPct: p.split.creatorBps / 100, platformPct: p.split.platformBps / 100, creator: p.split.creator },
    devBuyPreview: p.devBuyPreview, simulation: p.simulation || null, warnings, balanceNative: g.balance, balanceSol: g.balance, overCap: total > left + 1e-12,
    caps: policy.capsLeft("sol"), signer: g.address, txCount: p.txs.length, source, liveTrading: getConfig().claudia.liveTrading,
  };
  const { id, expiresAt } = policy.savePreview("launch", "sol", { planned, summary });
  trackActivity("claudia", `Dry run: launch $${sym.value}`);
  return { id, expiresAt, ...summary };
}

export async function confirmLaunch({ previewId, confirm }) {
  const p = policy.takePreview(previewId, "launch", confirm);
  if (p.chain === "hood") return evm.confirmLaunch(p);
  const s = p.summary;
  if (s.overCap) throw err(403, "This launch is over your daily cap.", "cap_exceeded");
  if (s.simulation && s.simulation.ok === false) throw err(409, "The simulation failed, so this wasn't sent.", "simulation_failed");
  await assertOpen("sol");
  const g = await guards("launch");
  if (g.hot || g.address !== s.signer) throw err(409, "The wallet changed since the dry run. Run it again.", "wallet_mismatch");
  policy.checkCaps("sol", s.fees.totalNative, "launch");
  if (s.devBuy) policy.checkCaps("sol", s.devBuy, "buy");
  const r = await agentClient().executeLaunch(p.planned, g.keypair, { rpcUrl: g.rpc });
  policy.recordSpend("sol", "launch", { native: s.fees.totalNative, token: r.mint ? `sol:${r.mint}` : undefined, signatures: r.signatures });
  trackActivity("trade", `Launched $${s.symbol} (live)`);
  return { ok: true, chain: "sol", mint: r.mint || s.mint, token: (r.mint || s.mint) ? `sol:${r.mint || s.mint}` : null, signatures: r.signatures, explorer: r.signatures.map(x => explorerUrl("tx", x, s.network)) };
}

// ── hot wallets: a small separate wallet per chain, swept back on demand ───
export async function hotInfo() {
  const cfg = getConfig().claudia;
  const out = {};
  for (const chain of ["sol", "hood"]) {
    const address = wallets.hotAddress(chain);
    let balance = null, error = null;
    if (address) {
      try { balance = chain === "sol" ? await getSolBalance(await rpcUrl(), address) : await evm.balanceOf(address); } catch (e) { error = String(e.message || e).split("\n")[0]; }
    }
    const main = mainWallet(chain);
    out[chain] = { address, balance, error, unit: CHAINS[chain].nativeSymbol, use: !!cfg.hot[chain] && !!address, mainWallet: main };
  }
  return out;
}

function mainWallet(chain) {
  const set = getConfig().claudia.mainWallet?.[chain];
  return set || (chain === "sol" ? walletAddress() : wallets.evmAddress()) || null;
}

export function setMainWallet(chain, address) {
  if (!["sol", "hood"].includes(chain)) throw err(400, "Unknown chain.");
  const a = String(address || "").trim();
  if (a && chain === "sol" && !isPublicKey(a)) throw err(400, "That isn't a Solana address.");
  if (a && chain === "hood" && !isEvmAddress(a)) throw err(400, "That isn't a 0x address.");
  const cfg = getConfig();
  cfg.claudia.mainWallet = { ...(cfg.claudia.mainWallet || {}), [chain]: a };
  saveConfig(cfg);
}

/** Prepares (and simulates) sending the hot wallet's balance back to your main wallet. */
export async function prepareSweep(chain) {
  const to = mainWallet(chain);
  if (!to) throw err(409, "Set the main wallet to sweep back to first.");
  if (chain === "hood") return evm.prepareSweep(to);
  if (chain !== "sol") throw err(400, "Unknown chain.");
  const from = wallets.hotAddress("sol");
  if (!from) throw err(409, "There's no Solana hot wallet.");
  if (from === to) throw err(400, "The main wallet is the hot wallet itself.");
  const rpc = await rpcUrl();
  const conn = connectionFor(rpc);
  const lamports = await conn.getBalance(new PublicKey(from));
  const fee = 5000;
  const amount = Math.max(0, lamports - fee); // the whole balance: the account closes, no rent left behind
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({ payerKey: new PublicKey(from), recentBlockhash: blockhash, instructions: [SystemProgram.transfer({ fromPubkey: new PublicKey(from), toPubkey: new PublicKey(to), lamports: amount })] }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  let sim;
  if (amount <= 0) sim = { ok: false, error: "The hot wallet is empty." };
  else {
    try {
      const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
      sim = r.value.err ? { ok: false, error: JSON.stringify(r.value.err) } : { ok: true };
    } catch (e) { sim = { ok: null, error: String(e.message).split("\n")[0] }; }
  }
  const summary = { kind: "sweep", chain: "sol", unit: "SOL", from, to, amount: lamports / 1e9 - fee / 1e9 > 0 ? round(amount / 1e9) : 0, feeSol: fee / 1e9, simulation: sim, network: await network(), liveTrading: getConfig().claudia.liveTrading };
  const { id, expiresAt } = policy.savePreview("sweep", "sol", { tx: Buffer.from(tx.serialize()).toString("base64"), summary });
  return { id, expiresAt, ...summary };
}

export async function confirmSweep({ previewId, confirm }) {
  const p = policy.takePreview(previewId, "sweep", confirm);
  if (p.chain === "hood") return evm.confirmSweep(p);
  if (p.summary.simulation.ok !== true) throw err(409, "The simulation didn't pass, so nothing was sent.", "simulation_failed");
  if (wallets.hotAddress("sol") !== p.summary.from) throw err(409, "The hot wallet changed. Prepare the sweep again.");
  const signed = signTransactions({ txs: [{ kind: "svm", base64: p.tx, signers: [p.summary.from], description: "Sweep the hot wallet back to your main wallet", partiallySigned: false }] }, toKeypair(wallets.hotKey("sol")));
  const signatures = await sendAndConfirm(signed, await rpcUrl());
  trackActivity("trade", `Swept ${p.summary.amount} SOL from the Solana hot wallet to ${p.summary.to} (live)`);
  return { ok: true, signatures, explorer: signatures.map(x => explorerUrl("tx", x, p.summary.network)) };
}

// ── agent proposals (the agent can suggest; only you can act) ──────────────
export const listProposals = () => readJsonFile(P.proposals, []);
export function addProposal(p) {
  const chain = p.chain || chainOfKey(p.token) || "sol";
  const entry = { id: newId("pr_"), ts: Date.now(), status: "open", origin: "agent", ...p, chain, unit: CHAINS[chain]?.nativeSymbol || "SOL" };
  writeJsonFile(P.proposals, [entry, ...listProposals()].slice(0, 100));
  trackActivity("claudia", `Your agent suggested: ${entry.side} $${entry.symbol} (${entry.side === "buy" ? entry.amount + " " + entry.unit : entry.amount + "%"})${!["agent", "user"].includes(entry.origin) ? `, prompted by outside content (${entry.origin})` : ""}`);
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
  if (d.chain !== "sol") throw err(400, "The paper account is in SOL, so it covers Solana coins. Robinhood Chain paper trading isn't here yet.");
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
