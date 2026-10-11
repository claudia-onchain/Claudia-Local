// Chains on the Claudia page: the switcher, the market-data panel, live prices, the confirm card, the Robinhood
// wallet and the optional hot wallets. Amounts always show in the chain's own coin (SOL, ETH).
import { Fragment, useEffect, useState } from "react";
import { api, ago, bus, errText, num, pct, short, usd } from "../../lib";
import { Copyable, Modal, Switch, useAsync, useToast } from "../../ui";

export type ChainId = "sol" | "hood";
export type ChainRow = { id: string; name: string; unit: string; status: "live" | "beta" | "view_only" | "coming_soon"; open: boolean; note: string | null };

export const UNIT: Record<string, string> = { sol: "SOL", hood: "ETH", bsc: "BNB" };
export const CHAIN_NAME: Record<string, string> = { sol: "Solana", hood: "Robinhood Chain", bsc: "BNB Chain" };
export const chainOfKey = (key?: string): ChainId => (key?.startsWith("hood:") ? "hood" : "sol");

/** An amount in a chain's own coin: "0.01 SOL", "0.002 ETH". */
export function native(n: number | null | undefined, unit: string, digits = 6) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return `${Number(n.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits })} ${unit}`;
}

const FALLBACK: ChainRow[] = [
  { id: "sol", name: "Solana", unit: "SOL", status: "live", open: true, note: null },
  { id: "hood", name: "Robinhood Chain", unit: "ETH", status: "beta", open: true, note: null },
  { id: "bsc", name: "BNB Chain", unit: "BNB", status: "coming_soon", open: false, note: null },
];

/** Solana first, then Robinhood Chain (beta), then BNB Chain (coming soon, disabled). */
export function ChainSwitch({ value, onChange }: { value: string; onChange: (c: ChainId) => void }) {
  const r = useAsync(() => api<{ chains: ChainRow[] }>("/api/claudia/chains").then(x => x.chains).catch(() => FALLBACK));
  const list = r.data || FALLBACK;
  return (
    <div className="seg" role="group" aria-label="Chain">
      {list.map(c => {
        const off = c.status === "coming_soon" || (c.id !== "sol" && c.id !== "hood"); // view-only chains can be looked at
        const label = c.id === "bsc" ? "BSC" : c.name;
        const tag = c.status === "beta" ? " · beta" : c.status === "coming_soon" ? " · coming soon" : c.status === "view_only" ? " · view only" : "";
        return (
          <button key={c.id} className={value === c.id ? "on" : ""} aria-pressed={value === c.id} disabled={off} title={c.note || undefined} onClick={() => !off && onChange(c.id as ChainId)}>
            {label}{tag && <span className="tiny muted">{tag}</span>}
          </button>
        );
      })}
    </div>
  );
}

// ── live price (server-sent events through the SDK hub) ────────────────────
export function useLivePrice(key: string, on: boolean) {
  const [tick, setTick] = useState<any>(null);
  useEffect(() => {
    if (!on || !key) return;
    const es = new EventSource(`/api/claudia/live/${encodeURIComponent(key)}`);
    es.onmessage = (e) => { try { setTick(JSON.parse(e.data)); } catch { /* */ } };
    es.onerror = () => { /* the browser retries; Refresh still works */ };
    return () => es.close();
  }, [key, on]);
  return tick;
}

// ── market data panel ──────────────────────────────────────────────────────
const PARTS = [["overview", "Overview"], ["holders", "Holders"], ["traders", "Traders"], ["dev", "Dev"], ["scores", "Scores"]] as const;

export function DataPanel({ coinKey, unit }: { coinKey: string; unit: string }) {
  const [part, setPart] = useState<(typeof PARTS)[number][0]>("overview");
  const r = useAsync(() => api<{ data: any }>(`/api/claudia/data/coin/${encodeURIComponent(coinKey)}?part=${part}`).then(x => x.data), [coinKey, part]);
  const x = r.data;
  return (
    <div className="card">
      <div className="card-head"><h2 className="grow">Market data</h2><span className="tiny muted">{x?.updatedAt ? `updated ${ago(x.updatedAt)}` : ""}</span></div>
      <div className="tabs" style={{ marginBottom: 12 }}>
        {PARTS.map(([id, label]) => <button key={id} className={part === id ? "on" : ""} onClick={() => setPart(id)}>{label}</button>)}
      </div>
      {r.error && <p className="small muted">{r.error.includes("404") || /http_404|no data/i.test(r.error) ? "No data for this coin yet." : r.error}</p>}
      {r.loading && !x && <p className="small muted">Loading…</p>}
      {x && !r.loading && part === "overview" && <Overview x={x} />}
      {x && !r.loading && (part === "holders" || part === "traders") && <Wallets rows={x.data || []} />}
      {x && !r.loading && part === "dev" && <Dev x={x} />}
      {x && !r.loading && part === "scores" && <Scores x={x} />}
      {x?.partial && <p className="tiny muted mt-8">Partial data: {x.partial}</p>}
      <p className="tiny muted mt-8">Names, tags and signals come from other people and data providers. Amounts in {unit} or USD.</p>
    </div>
  );
}

function Overview({ x }: { x: any }) {
  const s = x.stats || {}, w = s.windows || {}, sec = x.security;
  return (
    <div className="col gap-12">
      <div className="kv small">
        {(["5m", "1h", "24h"] as const).filter(k => w[k]).map(k => <Fragment key={k}><span>{k}</span><span>{w[k].buys}/{w[k].sells} buys/sells · {usd(w[k].volumeUsd)} · {pct(w[k].priceChangePct, true)}</span></Fragment>)}
        <span>Bots / rats</span><span>{pct(s.botPct)} / {pct(s.ratPct)}</span>
        {s.counts && <><span>Wallets</span><span>{Object.entries(s.counts).map(([k, v]) => `${k} ${v}`).join(" · ")}</span></>}
        {sec && <><span>Security</span><span>mint {sec.mintRenounced ? "renounced" : "not renounced"} · freeze {sec.freezeRenounced ? "renounced" : "not renounced"}{sec.honeypot ? " · honeypot" : ""}{sec.lpLocked ? " · LP locked" : ""}</span></>}
        {x.dev && <><span>Dev</span><span>{short(x.dev.address)} · {x.dev.launches} launches, {x.dev.migrated} migrated · {x.dev.status || "unknown"}</span></>}
      </div>
      {(sec?.warnings || []).slice(0, 4).map((m: string, i: number) => <div key={i} className="note warn small">{m}</div>)}
      {(x.signals || []).length > 0 && (
        <div className="list">{x.signals.slice(0, 6).map((g: any, i: number) => <div key={i} className="item small"><span className="grow">{g.label}</span><span className="tiny muted">{ago(g.at)}</span></div>)}</div>
      )}
    </div>
  );
}

function Wallets({ rows }: { rows: any[] }) {
  if (!rows.length) return <p className="small muted">No wallets listed yet.</p>;
  return (
    <div style={{ overflowX: "auto" }}>
      <table className="table">
        <thead><tr><th>#</th><th>Wallet</th><th>Tags</th><th className="r">Share</th><th className="r">Realized</th></tr></thead>
        <tbody>{rows.slice(0, 20).map(h => (
          <tr key={h.address}><td className="tiny muted">{h.rank}</td><td className="mono small">{short(h.address)}{h.name ? <span className="muted"> {h.name}</span> : null}</td><td className="tiny">{(h.tags || []).slice(0, 3).join(", ")}</td><td className="r num">{pct(h.pct)}</td><td className="r num">{usd(h.realizedPnlUsd)}</td></tr>
        ))}</tbody>
      </table>
    </div>
  );
}

const ScoreRow = ({ s }: { s: any }) => (
  <div className="col gap-4">
    <div className="row"><strong className="grow">{s.title}</strong><span className={`badge ${s.grade === "good" ? "ok" : s.grade === "risky" ? "bad" : ""}`}>{s.value}/100 · {s.grade}</span></div>
    <div className="small soft">{s.summary}</div>
    <div className="tiny muted">{(s.reasons || []).slice(0, 5).map((r: any) => `${r.label} ${r.points > 0 ? "+" : ""}${r.points}`).join(" · ")}</div>
  </div>
);
function Dev({ x }: { x: any }) {
  return (
    <div className="col gap-12">
      <div className="small">{short(x.summary.address)} · {x.summary.launches} launches · {x.summary.migrated} migrated · best {usd(x.summary.bestMcapUsd)}</div>
      <ScoreRow s={x.total} /><ScoreRow s={x.conduct} /><ScoreRow s={x.power} />
    </div>
  );
}
function Scores({ x }: { x: any }) {
  return <div className="col gap-12"><ScoreRow s={x.safety} /><ScoreRow s={x.holders} /><ScoreRow s={x.chart} /></div>;
}

// ── confirm card (trades) ──────────────────────────────────────────────────
/** chain, coin, side, amount, expected receive, caps left today and the simulation, before anything is sent. */
export function TradeConfirm({ p, busy, err, onConfirm, onClose }: { p: any; busy: boolean; err: string; onConfirm: () => void; onClose: () => void }) {
  const [agree, setAgree] = useState(false);
  const u = p.unit;
  const sim = p.simulation || {};
  const caps = p.caps || {};
  const secs = Math.max(0, Math.round((p.expiresAt - Date.now()) / 1000));
  return (
    <Modal title={`Confirm: ${p.side} $${p.symbol}`} onClose={onClose}>
      <div className="kv small">
        <span>Chain</span><span>{p.chainName}{p.chain === "hood" ? " (beta)" : ""}</span>
        <span>Coin</span><span>${p.symbol} · {p.name} <span className="mono tiny muted">{short(p.token.split(":")[1], 6)}</span></span>
        <span>Side</span><span className={p.side === "buy" ? "buy" : "sell"}>{p.side}</span>
        <span>Amount</span><span className="num">{p.side === "buy" ? native(p.amount, u) : `${p.amount}% · ${num(p.sellTokens)} $${p.symbol}`}</span>
        <span>You get about</span><span className="num">{p.side === "buy" ? `${num(p.expectedReceive.amount)} $${p.symbol} (at least ${num(p.expectedReceive.min)})` : `${native(p.expectedReceive.amount, u)} (at least ${native(p.expectedReceive.min, u)})`}</span>
        <span>Price impact</span><span className="num">{pct(p.quote?.priceImpactPct)}{p.quote?.taxPct ? ` · tax ${p.quote.taxPct}%` : ""}</span>
        <span>Caps left today</span><span className="num">{p.side === "buy" ? `${native(caps.leftToday, u)} of ${native(caps.perDay, u)}` : `${native(caps.sellLeftToday, u)} of ${native(caps.perDay, u)} in sales`} · {native(caps.perTrade, u)} per trade</span>
        <span>Simulation</span><span>{sim.ok === true ? <span className="buy">passed{sim.spendSol !== null && sim.spendSol !== undefined ? ` · spends ${native(sim.spendSol, u)}` : ""}{sim.tokens !== null && sim.tokens !== undefined ? ` · ${sim.tokens > 0 ? "+" : ""}${num(sim.tokens)} $${p.symbol}` : ""}{sim.gasEth ? ` · gas about ${native(sim.gasEth, u, 8)}` : ""}</span> : sim.ok === false ? <span className="sell">would fail</span> : <span className="muted">couldn't run</span>}</span>
        <span>Wallet</span><span className="mono small">{short(p.signer, 6)}{p.walletKind === "hot" ? " (hot wallet)" : ""} · {native(p.balanceNative, u, 4)}</span>
        <span>Network</span><span>{p.network === "mainnet" || p.chain === "hood" ? <strong className="sell">mainnet, real {u}</strong> : `devnet (test ${u})`}</span>
        <span>Transactions</span><span>{p.txCount}, checked on this computer</span>
      </div>
      {sim.error && <p className="small muted mt-8 break">{sim.error}</p>}
      {(p.warnings || []).map((w: string, i: number) => <div key={i} className="note warn small mt-8">{w}</div>)}
      <label className="row mt-16 small"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> I understand this {p.side === "buy" ? "spends" : "sells for"} real {u} and can't be undone.</label>
      {err && <p className="error mt-8">{err}</p>}
      <div className="row mt-16">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className={`btn grow ${p.side === "buy" ? "buyb" : "sellb"}`} disabled={!agree || busy || !p.liveTrading || sim.ok !== true} onClick={onConfirm}>{busy ? "Sending…" : `Confirm ${p.side}`}</button>
      </div>
      {!p.liveTrading && <p className="tiny muted mt-8">Live trading is off, so this dry run can't be sent.</p>}
      {p.liveTrading && sim.ok !== true && <p className="tiny muted mt-8">Only a dry run whose simulation passed can be sent.</p>}
      <p className="tiny muted mt-8">This preview expires in {secs} s.</p>
    </Modal>
  );
}

// ── Robinhood Chain wallet ─────────────────────────────────────────────────
export function EvmWalletCard() {
  const toast = useToast();
  const w = useAsync(() => api("/api/claudia/evm/wallet"));
  const [importing, setImporting] = useState(false);
  const [key, setKey] = useState("");
  const done = () => { w.reload(); bus.dispatchEvent(new Event("claudia")); };
  const create = async () => { try { await api("/api/claudia/evm/wallet", { body: { create: true } }); toast("Wallet created", "ok"); done(); } catch (e) { toast(errText(e), "bad"); } };
  const doImport = async () => { try { await api("/api/claudia/evm/wallet", { body: { importKey: key.trim() } }); setKey(""); setImporting(false); toast("Wallet imported", "ok"); done(); } catch (e) { toast(errText(e), "bad"); } };
  const d = w.data;
  return (
    <div className="card">
      <div className="card-head"><h2>Robinhood Chain wallet <span className="badge">beta</span></h2><p>Your own 0x wallet. It signs Robinhood Chain trades and launches on this computer. Amounts are in ETH.</p></div>
      {!d?.address ? (
        <div className="fields">
          <div className="row wrap">
            <p className="small soft grow">No Robinhood wallet yet. Fund it only with what you're willing to lose.</p>
            <button className="btn" onClick={create}>Create wallet</button>
            <button className="btn ghost" onClick={() => setImporting(!importing)}>Import</button>
          </div>
          {importing && (
            <div className="row">
              <input className="input mono" type="password" autoComplete="off" placeholder="0x… private key" value={key} onChange={e => setKey(e.target.value)} />
              <button className="btn primary" disabled={!key.trim()} onClick={doImport}>Import</button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className="kv">
            <span>Address</span><Copyable text={d.address} />
            <span>Balance</span><span className="num">{d.balanceEth !== null && d.balanceEth !== undefined ? native(d.balanceEth, "ETH") : d.error ? <span className="muted small">{d.error}</span> : "…"}</span>
            <span>Explorer</span><a className="small" href={d.explorer} target="_blank" rel="noreferrer">Blockscout</a>
          </div>
          <div className="row mt-12"><button className="btn sm" onClick={w.reload}>Refresh balance</button><ExportKey route="/api/claudia/evm/wallet/export" what="the Robinhood Chain wallet" /></div>
        </>
      )}
    </div>
  );
}

export function ExportKey({ route, what, extra }: { route: string; what: string; extra?: Record<string, string> }) {
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState("");
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState("");
  const close = () => { setOpen(false); setPass(""); setSecret(""); setErr(""); };
  return (
    <>
      <button className="btn ghost sm" onClick={() => setOpen(true)}>Back up key</button>
      {open && (
        <Modal title={`Back up ${what}`} onClose={close}>
          {!secret ? (
            <div className="fields">
              <p className="small soft">The key controls the wallet's funds. Anyone who sees it can take them. Enter your passphrase to show it.</p>
              <input className="input" type="password" autoFocus value={pass} onChange={e => setPass(e.target.value)} placeholder="Passphrase" />
              {err && <p className="error">{err}</p>}
              <button className="btn primary" disabled={!pass} onClick={async () => { try { setSecret((await api(route, { body: { ...extra, passphrase: pass } })).secretKey); } catch (e) { setErr(errText(e)); } }}>Show key</button>
            </div>
          ) : (
            <div className="fields">
              <div className="note warn small">Store it offline. Never paste it into a website or a chat.</div>
              <textarea className="textarea mono" readOnly value={secret} onFocus={e => e.target.select()} />
              <button className="btn" onClick={close}>Done</button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

// ── hot wallets ────────────────────────────────────────────────────────────
export function HotWallets() {
  const toast = useToast();
  const h = useAsync(() => api("/api/claudia/hot"));
  const [sweep, setSweep] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const call = async (path: string, body: any, msg?: string) => { try { await api(`/api/claudia/hot/${path}`, { body }); if (msg) toast(msg, "ok"); h.reload(); bus.dispatchEvent(new Event("claudia")); } catch (e) { toast(errText(e), "bad"); } };
  const prepare = async (chain: string) => { setErr(""); try { setSweep(await api("/api/claudia/hot/sweep/preview", { body: { chain } })); } catch (e) { toast(errText(e), "bad"); } };
  const confirmSweep = async () => { setBusy(true); setErr(""); try { await api("/api/claudia/hot/sweep/confirm", { body: { previewId: sweep.id, confirm: true } }); toast("Swept back", "ok"); setSweep(null); h.reload(); } catch (e) { setErr(errText(e)); } setBusy(false); };
  return (
    <div className="card">
      <div className="card-head"><h2>Hot wallets (optional)</h2><p>A separate small wallet per chain for trading. Send it only what you want to trade with; sweep the rest back to your main wallet any time.</p></div>
      {(["sol", "hood"] as const).map(chain => {
        const x = h.data?.[chain];
        return (
          <div key={chain} className="col gap-8" style={{ paddingBottom: 12, marginBottom: 12, borderBottom: chain === "sol" ? "1px solid var(--line)" : undefined }}>
            <div className="row"><strong className="grow">{CHAIN_NAME[chain]}{chain === "hood" ? " (beta)" : ""}</strong>
              {x?.address && <Switch checked={x.use} label="Trade from it" onChange={v => call("use", { chain, use: v })} />}
            </div>
            {!x?.address ? <div className="row"><span className="small muted grow">No hot wallet.</span><button className="btn sm" onClick={() => call("create", { chain }, "Hot wallet created")}>Create</button></div> : (
              <>
                <div className="kv small">
                  <span>Address</span><Copyable text={x.address} />
                  <span>Balance</span><span className="num">{x.balance !== null ? native(x.balance, x.unit) : x.error || "…"}</span>
                  <span>Main wallet</span><MainWallet chain={chain} value={x.mainWallet || ""} onSave={(a) => call("main", { chain, address: a }, "Saved")} />
                </div>
                <div className="row wrap"><button className="btn sm" onClick={() => prepare(chain)}>Sweep back to my main wallet</button><ExportKey route="/api/claudia/hot/export" what={`the ${CHAIN_NAME[chain]} hot wallet`} extra={{ chain }} /></div>
              </>
            )}
          </div>
        );
      })}
      <p className="tiny muted">Solana launches always use your agent wallet. Trades use the hot wallet while "Trade from it" is on, inside the same caps.</p>
      {sweep && (
        <Modal title="Sweep back to your main wallet?" onClose={() => setSweep(null)}>
          <div className="kv small">
            <span>Chain</span><span>{CHAIN_NAME[sweep.chain]}</span>
            <span>From</span><span className="mono">{short(sweep.from, 6)} (hot wallet)</span>
            <span>To</span><span className="mono">{short(sweep.to, 6)}</span>
            <span>Amount</span><span className="num">{native(sweep.amount, sweep.unit)}</span>
            <span>Network fee</span><span className="num">about {native(sweep.feeSol ?? sweep.feeEth, sweep.unit, 8)}</span>
            <span>Simulation</span><span>{sweep.simulation.ok === true ? <span className="buy">passed</span> : <span className="sell">{sweep.simulation.error || "didn't pass"}</span>}</span>
          </div>
          {err && <p className="error mt-8">{err}</p>}
          <div className="row mt-16"><button className="btn ghost" onClick={() => setSweep(null)}>Cancel</button><button className="btn primary grow" disabled={busy || !sweep.liveTrading || sweep.simulation.ok !== true} onClick={confirmSweep}>{busy ? "Sending…" : "Confirm sweep"}</button></div>
          {!sweep.liveTrading && <p className="tiny muted mt-8">Live trading is off, so this can't be sent yet.</p>}
        </Modal>
      )}
    </div>
  );
}

function MainWallet({ chain, value, onSave }: { chain: string; value: string; onSave: (a: string) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <span className="row gap-4">
      <input className="input mono small" style={{ maxWidth: 360 }} placeholder={chain === "sol" ? "Solana address" : "0x address"} value={v} onChange={e => setV(e.target.value)} />
      {v !== value && <button className="btn sm" onClick={() => onSave(v)}>Save</button>}
    </span>
  );
}

// ── Robinhood launchpads ───────────────────────────────────────────────────
export function useLaunchpads(chain: string) {
  return useAsync(() => api<{ launchpads: any[] }>(`/api/claudia/launchpads?chain=${chain}`).then(r => r.launchpads), [chain]);
}
