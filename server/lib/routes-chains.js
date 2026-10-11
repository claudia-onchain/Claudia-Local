/**
 * routes-chains.js — chains, the Robinhood wallet, hot wallets, market data and one-click connect.
 *
 *   GET  /api/claudia/chains                    Solana, Robinhood Chain (beta), BNB Chain (coming soon) + the picked one
 *   POST /api/claudia/chain                     { chain } pick the chain shown on the Claudia page
 *   POST /api/claudia/connect/one-click         { name? } → { url } to open on useclaudia.xyz
 *   GET  /api/claudia/evm/wallet                Robinhood wallet address and ETH balance
 *   POST /api/claudia/evm/wallet                { create } | { importKey } (force to replace)
 *   POST /api/claudia/evm/wallet/export         { passphrase } → secret key (backup)
 *   POST /api/claudia/evm/wallet/remove         { passphrase }
 *   GET  /api/claudia/hot                       hot wallets per chain
 *   POST /api/claudia/hot/create | use | main | export | remove
 *   POST /api/claudia/hot/sweep/preview         { chain } → prepared + simulated, nothing sent
 *   POST /api/claudia/hot/sweep/confirm         { previewId, confirm: true }
 *   GET  /api/claudia/launchpads?chain=hood     Robinhood launchpads and which are open
 *   GET  /api/claudia/launch/images             pictures from uploads, the media library and the workspace
 *   GET  /api/claudia/data/coin/:key?part=      insights: overview | holders | traders | dev | scores
 *   GET  /api/claudia/data/market?chain=&list=|feed=   trending, hot, kol, smart, signals
 *   GET  /api/claudia/data/wallet/:address?chain=
 *   GET  /api/claudia/live/:key                 live price updates (server-sent events) while a coin page is open
 *   POST /api/files/upload?path=/pics/coin.png  a picture (raw body) into the workspace, for launches and posts
 *   GET  /oauth/claudia                         one-click connect comes back here (public, checked by state)
 */
import { json, readJson, HttpError } from "./http.js";
import * as vault from "./vault.js";
import * as cl from "./claudia.js";
import * as evm from "./evm.js";
import * as wallets from "./wallets.js";
import * as data from "./tools-data.js";
import * as oneClick from "./connect-claudia.js";
import * as wsp from "./workspace.js";
import { updateConfig, trackActivity } from "./store.js";

const qs = (req) => new URL(req.url, "http://x").searchParams;
const CHAIN_IDS = ["sol", "hood"];
const chainParam = (v) => {
  if (v === "bsc") throw new HttpError(403, "BNB Chain is coming soon on Claudia.");
  if (!CHAIN_IDS.includes(v)) throw new HttpError(400, "Unknown chain. Use sol or hood.");
  return v;
};
async function withPassphrase(d) {
  if (!(await vault.verify(String(d.passphrase || "")))) throw new HttpError(401, "Wrong passphrase.");
}

function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new HttpError(413, `That's too big (max ${Math.round(limit / 1024 / 1024)} MB).`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** POST /api/files/upload?path=… — a picture from the Files page (binary body). */
export async function filesUpload(req, res) {
  const path = qs(req).get("path") || "";
  const r = wsp.writeImage(path, await readRaw(req, wsp.MAX_IMAGE_BYTES));
  trackActivity("files", `Uploaded ${r.path}`);
  return json(res, 200, r);
}

let live = 0;
const MAX_LIVE = 4;

/** Handles the routes above; returns false for anything else under /api/claudia. */
export async function chainRoutes(req, res, url, { port }) {
  const m = req.method;
  const sub = url.slice("/api/claudia".length);
  const body = () => readJson(req, 64 * 1024);

  if (sub === "/chains" && m === "GET") return json(res, 200, { chains: await cl.chainsView(), selected: cl.status().chain }), true;
  if (sub === "/chain" && m === "POST") {
    const d = await body();
    updateConfig({ claudia: { chain: chainParam(d.chain) } });
    return json(res, 200, { selected: d.chain }), true;
  }
  if (sub === "/connect/one-click" && m === "POST") {
    const d = await body();
    return json(res, 200, oneClick.start({ port, name: d.name })), true;
  }

  // ── Robinhood wallet ──
  if (sub === "/evm/wallet" && m === "GET") return json(res, 200, await evm.walletInfo()), true;
  if (sub === "/evm/wallet" && m === "POST") {
    const d = await body();
    if (d.importKey !== undefined) return json(res, 200, wallets.setEvm({ importKey: d.importKey, force: !!d.force })), true;
    if (d.create) return json(res, 200, wallets.setEvm({ force: !!d.force })), true;
    throw new HttpError(400, "Say create or importKey.");
  }
  if (sub === "/evm/wallet/export" && m === "POST") {
    await withPassphrase(await body());
    if (!wallets.hasEvm()) throw new HttpError(404, "There's no Robinhood Chain wallet.");
    trackActivity("claudia", "Robinhood Chain wallet key shown for backup");
    return json(res, 200, wallets.exportKey("evm")), true;
  }
  if (sub === "/evm/wallet/remove" && m === "POST") {
    await withPassphrase(await body());
    wallets.removeEvm();
    return json(res, 200, { ok: true }), true;
  }

  // ── hot wallets ──
  if (sub === "/hot" && m === "GET") return json(res, 200, await cl.hotInfo()), true;
  if (sub.startsWith("/hot/") && m === "POST") {
    const d = await body();
    const chain = chainParam(d.chain);
    const action = sub.slice(5);
    if (action === "create") return json(res, 200, wallets.createHot(chain, { force: false })), true;
    if (action === "use") {
      if (d.use && !wallets.hasHot(chain)) throw new HttpError(409, "Create the hot wallet first.");
      updateConfig({ claudia: { hot: { [chain]: !!d.use } } });
      trackActivity("claudia", `${d.use ? "Trading from" : "Stopped trading from"} the ${chain === "sol" ? "Solana" : "Robinhood Chain"} hot wallet`);
      return json(res, 200, await cl.hotInfo()), true;
    }
    if (action === "main") { cl.setMainWallet(chain, d.address); return json(res, 200, await cl.hotInfo()), true; }
    if (action === "export") {
      await withPassphrase(d);
      trackActivity("claudia", "Hot wallet key shown for backup");
      return json(res, 200, wallets.exportKey(`hot:${chain}`)), true;
    }
    if (action === "remove") {
      await withPassphrase(d);
      updateConfig({ claudia: { hot: { [chain]: false } } });
      wallets.removeHot(chain);
      return json(res, 200, await cl.hotInfo()), true;
    }
    if (action === "sweep/preview") return json(res, 200, await cl.prepareSweep(chain)), true;
  }
  if (sub === "/hot/sweep/confirm" && m === "POST") return json(res, 200, await cl.confirmSweep(await body())), true;

  // ── launches ──
  if (sub === "/launchpads" && m === "GET") {
    if (qs(req).get("chain") !== "hood") return json(res, 200, { launchpads: [{ id: "pump", name: "pump.fun", devBuy: true, open: true }] }), true;
    return json(res, 200, { launchpads: await evm.launchpads() }), true;
  }
  if (sub === "/launch/images" && m === "GET") return json(res, 200, { images: cl.launchImages() }), true;

  // ── market data ──
  if (sub.startsWith("/data/coin/") && m === "GET") return json(res, 200, await data.coinData(decodeURIComponent(sub.slice(11)), qs(req).get("part") || "overview")), true;
  if (sub === "/data/market" && m === "GET") {
    const q = qs(req);
    return json(res, 200, await data.marketData({ chain: q.get("chain") || "sol", list: q.get("list") || "trending", feed: q.get("feed") || undefined, side: q.get("side") || undefined, interval: q.get("interval") || "1h" })), true;
  }
  if (sub.startsWith("/data/wallet/") && m === "GET") return json(res, 200, await data.walletData(decodeURIComponent(sub.slice(13)), qs(req).get("chain") || undefined)), true;

  // ── live price (server-sent events through the SDK hub) ──
  if (sub.startsWith("/live/") && m === "GET") {
    const d = await cl.coin(decodeURIComponent(sub.slice(6))); // Claudia coins only
    if (live >= MAX_LIVE) throw new HttpError(429, "Too many live views open.");
    live++;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive" });
    res.write(`retry: 10000\n\n`);
    const stream = cl.publicClient().stream.token(d.key);
    const beat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* */ } }, 25_000);
    const end = () => { clearInterval(beat); try { stream.close(); } catch { /* */ } };
    req.on("close", () => { end(); live--; });
    (async () => {
      try {
        for await (const ev of stream) {
          if (ev.type !== "token") continue;
          const t = ev.token;
          res.write(`data: ${JSON.stringify({ key: t.key, priceUsd: t.priceUsd, priceNative: t.priceNative, mcapUsd: t.mcapUsd, change5mPct: t.change5mPct, change1hPct: t.change1hPct, volume24hUsd: t.volume24hUsd, holders: t.holders, updatedAt: t.updatedAt })}\n\n`);
        }
      } catch { /* the hub closed; the page falls back to Refresh */ }
      try { res.end(); } catch { /* */ }
    })();
    return true;
  }
  return false;
}

// ── GET /oauth/claudia (public) ────────────────────────────────────────────
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

export async function oauthClaudia(req, res) {
  const r = await oneClick.callback(qs(req));
  res.writeHead(r.ok ? 200 : 400, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(r.title)} · Claudia Local</title>
<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#120b10;color:#f8ece8;font:15px/1.5 system-ui,-apple-system,sans-serif;padding:24px;box-sizing:border-box}
.box{max-width:440px;width:100%;background:#1b1118;border:1px solid #34222e;border-left:3px solid ${r.ok ? "#3ddc97" : "#ff5a52"};border-radius:10px;padding:20px}
h1{font:400 28px/1.1 Georgia,serif;margin:0 0 8px}p{margin:0 0 14px;color:#d6bfc7}a{color:#ff6fa5}img{width:44px;height:44px;border-radius:50%;margin-bottom:10px}</style></head>
<body><div class="box"><img src="/claudia/avatar-96.webp" alt=""><h1>${esc(r.title)}</h1><p>${esc(r.text)}</p><a href="/claudia/agent">Open Claudia Local</a></div></body></html>`);
}
