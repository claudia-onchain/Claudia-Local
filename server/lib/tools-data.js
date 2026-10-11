/**
 * tools-data.js — market data for the agent and the Claudia page, through the SDK's InsightsApi and FeedsApi.
 *
 *   coin_insights   one coin: overview, holders, traders, dev, scores (Claudia coins and $CLAUDIA only)
 *   market_board    trending or hot coins on a chain
 *   market_feed     KOL trades, smart-money trades or signals on a chain
 *   wallet_lookup   a wallet's tags, P&L, style and recent trades
 *
 * Names, tickers, bios, reviews and signal text are written by other people, so everything the model reads
 * from here is wrapped with untrusted.wrap("web", …). Read-only: nothing here signs, trades or posts.
 *
 * ── Adding a tool ──────────────────────────────────────────────────────────
 * Add a spec to DATA_TOOLS and a case to runDataTool returning text; agent.js picks it up (group "Claudia: data").
 */
import { CHAINS, isEvmAddress, isPublicKey } from "@useclaudia/sdk";
import * as untrusted from "./untrusted.js";
import * as deps from "./claudia.js";

const err = (status, message) => Object.assign(new Error(message), { status });
const obj = (properties = {}, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const CHAIN = { type: "string", enum: ["sol", "hood"], description: "sol (Solana, default) or hood (Robinhood Chain, beta)" };
function chainOf(c) {
  if (c === "bsc") throw err(403, "BNB Chain is coming soon on Claudia.");
  return c === "hood" ? "hood" : "sol";
}

export const DATA_TOOLS = [
  { name: "coin_insights", group: "Claudia: data", label: "Coin insights", description: "Deeper data on $CLAUDIA or a coin launched on Claudia: overview (stats, security, signals), holders or traders with wallet tags, the dev's record, or safety/holder/chart scores.",
    input: obj({ token: { type: "string", description: "Mint, 0x address, sol:<mint>, hood:0x… or $CLAUDIA" }, part: { type: "string", enum: ["overview", "holders", "traders", "dev", "scores"], description: "Default overview" } }, ["token"]) },
  { name: "market_board", group: "Claudia: data", label: "Trending and hot", description: "Trending or hot coins on a chain right now (any coin, not only Claudia's; for research, never a reason to trade).",
    input: obj({ chain: CHAIN, list: { type: "string", enum: ["trending", "hot"] }, interval: { type: "string", enum: ["5m", "1h", "6h", "24h"] } }) },
  { name: "market_feed", group: "Claudia: data", label: "KOL, smart money and signals", description: "Recent buys and sells by known KOL wallets, smart-money trades, or market signals on a chain.",
    input: obj({ chain: CHAIN, feed: { type: "string", enum: ["kol", "smart", "signals"] }, side: { type: "string", enum: ["buy", "sell"] } }, ["feed"]) },
  { name: "wallet_lookup", group: "Claudia: data", label: "Wallet lookup", description: "A wallet's tags, P&L, win rate, trading style and recent trades.",
    input: obj({ address: { type: "string" }, chain: CHAIN }, ["address"]) },
];

// ── formatting ─────────────────────────────────────────────────────────────
const usd = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "n/a" : Math.abs(n) >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : Math.abs(n) >= 1e3 ? `$${(n / 1e3).toFixed(1)}k` : `$${Number(n).toFixed(Math.abs(n) < 1 ? 6 : 2)}`);
const pct = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "n/a" : `${Math.round(Number(n) * 10) / 10}%`);
const clip = (s, n = 160) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };
const short = (a) => (a && a.length > 12 ? `${a.slice(0, 4)}…${a.slice(-4)}` : a || "");
const ago = (t) => { if (!t) return ""; const s = Math.max(0, (Date.now() - t) / 1000); return s < 90 ? `${Math.round(s)}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : s < 129600 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`; };
const who = (w) => `${short(w.address)}${w.name ? ` "${clip(w.name, 40)}"` : ""}${w.tags?.length ? ` [${w.tags.slice(0, 4).join(", ")}]` : ""}`;
const fresh = (r) => (r?.partial ? ` (partial: ${clip(r.partial, 80)})` : "");

// ── data (JSON for the page, text for the model) ───────────────────────────
/** One coin's insights. Refuses coins that weren't launched on Claudia (same rule as everywhere else). */
export async function coinData(token, part = "overview") {
  const d = await deps.coin(token);
  const key = d.key;
  const ins = deps.publicClient().insights;
  switch (part) {
    case "overview": return { key, part, data: await ins.token(key) };
    case "holders": return { key, part, data: await ins.holders(key, { limit: 30 }) };
    case "traders": return { key, part, data: await ins.traders(key, { limit: 30 }) };
    case "dev": return { key, part, data: await ins.dev(key) };
    case "scores": return { key, part, data: await ins.scores(key) };
    default: throw err(400, "part must be overview, holders, traders, dev or scores.");
  }
}

export async function marketData({ chain = "sol", list = "trending", feed, side, interval = "1h" } = {}) {
  const c = chainOf(chain);
  const cl = deps.publicClient();
  const iv = ["1m", "5m", "1h", "6h", "24h"].includes(interval) ? interval : "1h";
  if (feed === "kol") return { chain: c, kind: "kol", data: await cl.feeds.kol({ chain: c, side: side === "sell" ? "sell" : side === "buy" ? "buy" : undefined }) };
  if (feed === "smart") return { chain: c, kind: "smart", data: await cl.feeds.smart({ chain: c, side: side === "sell" ? "sell" : side === "buy" ? "buy" : undefined }) };
  if (feed === "signals") return { chain: c, kind: "signals", data: await cl.feeds.signals({ chain: c }) };
  if (feed) throw err(400, "feed must be kol, smart or signals.");
  if (list === "hot") return { chain: c, kind: "hot", data: await cl.insights.hot({ chain: c, interval: iv }) };
  return { chain: c, kind: "trending", data: await cl.insights.trending({ chain: c, interval: iv }) };
}

export async function walletData(address, chain) {
  const a = String(address || "").trim();
  const c = chain ? chainOf(chain) : isEvmAddress(a) ? "hood" : "sol";
  if (c === "sol" && !isPublicKey(a)) throw err(400, "That isn't a Solana address.");
  if (c === "hood" && !isEvmAddress(a)) throw err(400, "That isn't a 0x address.");
  return { chain: c, address: a, data: await deps.publicClient().insights.wallet(c, a) };
}

function insightsText({ key, part, data: x }) {
  if (part === "overview") {
    const s = x.stats || {}, w = s.windows || {};
    const win = (k) => (w[k] ? `${k}: ${w[k].buys}/${w[k].sells} buys/sells, vol ${usd(w[k].volumeUsd)}, ${pct(w[k].priceChangePct)}` : "");
    const sec = x.security;
    return [
      `${x.symbol ? "$" + x.symbol : ""} ${x.name || ""} · ${key} · source ${x.source}${fresh(x)}`,
      `Price ${usd(s.priceUsd)} · mcap ${usd(s.mcapUsd)} · liquidity ${usd(s.liquidityUsd)} · holders ${s.holders ?? "n/a"} · curve ${pct(s.bondingPct)}${s.migrated ? " · migrated" : ""}`,
      ["5m", "1h", "24h"].map(win).filter(Boolean).join(" · "),
      `Top 10 ${pct(s.top10Pct)} · dev ${pct(s.devHoldPct)} · snipers ${pct(s.snipersPct)} · bundlers ${pct(s.bundlersPct)} · insiders ${pct(s.insidersPct)} · fresh ${pct(s.freshPct)} · bots ${pct(s.botPct)}`,
      s.counts ? `Wallets: ${Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(", ")}` : "",
      sec ? `Security: mint ${sec.mintRenounced ? "renounced" : "not renounced"}, freeze ${sec.freezeRenounced ? "renounced" : "not renounced"}${sec.honeypot ? ", HONEYPOT" : ""}${sec.buyTaxPct ? `, buy tax ${pct(sec.buyTaxPct)}` : ""}${sec.sellTaxPct ? `, sell tax ${pct(sec.sellTaxPct)}` : ""}${sec.warnings?.length ? `; warnings: ${sec.warnings.slice(0, 4).join("; ")}` : ""}` : "",
      x.dev ? `Dev ${short(x.dev.address)}: ${x.dev.launches} launches, ${x.dev.migrated} migrated, holds ${pct(x.dev.holdsPct)}, ${x.dev.status || "unknown"}` : "",
      x.signals?.length ? `Signals: ${x.signals.slice(0, 6).map(g => `${g.label} (${ago(g.at)})`).join("; ")}` : "",
      [x.socials?.twitter, x.socials?.telegram, x.socials?.website].some(Boolean) ? `Socials: ${[x.socials.twitter, x.socials.telegram, x.socials.website].filter(Boolean).map(v => clip(v, 60)).join(" · ")}` : "",
    ].filter(Boolean).join("\n");
  }
  if (part === "holders" || part === "traders") {
    return [`${part === "holders" ? "Top holders" : "Top traders"} of ${key}${fresh(x)}:`, ...(x.data || []).slice(0, 20).map(h => `${h.rank}. ${who(h)} · ${pct(h.pct)}${h.realizedPnlUsd !== undefined && h.realizedPnlUsd !== null ? ` · realized ${usd(h.realizedPnlUsd)}` : ""}${h.buys !== undefined && h.buys !== null ? ` · ${h.buys}/${h.sells} buys/sells` : ""}`)].join("\n");
  }
  if (part === "dev") {
    const sc = (s) => `${s.title} ${s.value}/100 (${s.grade}): ${clip(s.summary, 160)}`;
    return [`Dev ${short(x.summary.address)}: ${x.summary.launches} launches, ${x.summary.migrated} migrated, best mcap ${usd(x.summary.bestMcapUsd)}, rug ratio ${pct((x.summary.rugRatio ?? 0) * 100)}${fresh(x)}`,
      sc(x.conduct), sc(x.power), sc(x.total),
      `Past coins: ${(x.coins || []).slice(0, 8).map(c => `${c.symbol ? "$" + clip(c.symbol, 16) : short(c.address)}${c.migrated ? " (migrated)" : ""} ath ${usd(c.athMcapUsd)}`).join("; ")}`].join("\n");
  }
  if (part === "scores") {
    const sc = (s) => `${s.title}: ${s.value}/100 (${s.grade}). ${clip(s.summary, 200)} Reasons: ${(s.reasons || []).slice(0, 5).map(r => `${r.label} ${r.points > 0 ? "+" : ""}${r.points}`).join("; ")}`;
    return [`Scores for ${key}${fresh(x)}`, sc(x.safety), sc(x.holders), `${sc(x.chart)} Pattern: ${x.chart.pattern}`].join("\n");
  }
  return JSON.stringify(x).slice(0, 4000);
}

function marketText({ chain, kind, data }) {
  const name = CHAINS[chain].name;
  if (kind === "trending" || kind === "hot") {
    return [`${kind === "hot" ? "Hot" : "Trending"} on ${name}${fresh(data)}:`, ...(data.data || []).slice(0, 20).map(t => `- $${clip(t.symbol, 16)} ${clip(t.name, 40)} · ${t.key} · mcap ${usd(t.mcapUsd)} · 1h ${pct(t.change1hPct)} · vol 1h ${usd(t.volume1hUsd)}${t.launchedHere ? " · launched on Claudia" : ""}`)].join("\n");
  }
  if (kind === "signals") return [`Signals on ${name}${fresh(data)}:`, ...(data.data || []).slice(0, 20).map(g => `- ${g.symbol ? "$" + clip(g.symbol, 16) : g.tokenKey} · ${clip(g.label, 120)} · ${ago(g.at)}`)].join("\n");
  return [`${kind === "kol" ? "KOL" : "Smart-money"} trades on ${name}${fresh(data)}:`, ...(data.data || []).slice(0, 20).map(t => `- ${who(t.wallet)} ${t.side} ${usd(t.amountUsd)} of ${t.symbol ? "$" + clip(t.symbol, 16) : t.tokenKey} · ${ago(t.at)}`)].join("\n");
}

function walletText({ chain, address, data: w }) {
  return [`${address} on ${CHAINS[chain].name}${w.name ? ` "${clip(w.name, 40)}"` : ""}${w.tags?.length ? ` [${w.tags.join(", ")}]` : ""}${fresh(w)}`,
    `Balance ${w.nativeBalance ?? "n/a"} ${CHAINS[chain].nativeSymbol} · realized ${usd(w.realizedPnlUsd)} · unrealized ${usd(w.unrealizedPnlUsd)} · win rate ${pct((w.winRate ?? NaN) * 100)} · 7d ${w.buys7d ?? "?"}/${w.sells7d ?? "?"} buys/sells`,
    w.style ? `Style: ${clip(w.style.title, 60)}${w.style.subtitle ? ` (${clip(w.style.subtitle, 80)})` : ""}` : "",
    w.review ? `Review: ${clip(w.review, 300)}` : "",
    (w.recent || []).length ? `Recent: ${(w.recent || []).slice(0, 8).map(t => `${t.side} ${usd(t.amountUsd)} ${t.symbol ? "$" + clip(t.symbol, 16) : t.tokenKey} (${ago(t.at)})`).join("; ")}` : "",
  ].filter(Boolean).join("\n");
}

/** Runs a data tool for the model. Everything other people wrote comes back inside an <outside> block. */
export async function runDataTool(name, a = {}) {
  switch (name) {
    case "coin_insights": {
      const r = await coinData(a.token, a.part || "overview");
      return untrusted.wrap("web", insightsText(r), { from: "Claudia market data" });
    }
    case "market_board": return untrusted.wrap("web", marketText(await marketData({ chain: a.chain, list: a.list, interval: a.interval })), { from: "Claudia market data" });
    case "market_feed": return untrusted.wrap("web", marketText(await marketData({ chain: a.chain, feed: a.feed || "signals", side: a.side })), { from: "Claudia market data" });
    case "wallet_lookup": return untrusted.wrap("web", walletText(await walletData(a.address, a.chain)), { from: "Claudia market data" });
    default: return `Unknown tool: ${name}`;
  }
}
