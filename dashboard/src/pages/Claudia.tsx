// Claudia: $CLAUDIA and coins launched on Claudia, the thread, paper trading, your agent, launches.
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { Link, NavLink, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { api, ago, bus, errText, num, pct, short, signClass, sol, usd } from "../lib";
import { CoinImg, Copyable, Field, Modal, PageHead, Switch, useAsync, useToast } from "../ui";

type Status = {
  baseUrl: string; rpcUrl: string; source: string; connected: boolean; apiKey: { set: boolean; hint: string }; devicePublicKey: string | null;
  walletAddress: string | null; agent: any; caps: { maxSolPerTrade: number; maxSolPerDay: number }; liveTrading: boolean; spentToday: number; room: string;
};
const Ctx = createContext<{ st: Status | null; reload: () => void; showImages: boolean }>({ st: null, reload: () => {}, showImages: true });
const useC = () => useContext(Ctx);
const isClaudia = (key?: string) => key === "sol:2j5SaS7xy776qCBpyPQbZjyQSAtKiFgrwjfErthnW2ZM";

export default function Claudia({ status, reloadStatus }: { status: Status | null; reloadStatus: () => void }) {
  const [showImages, setShowImages] = useState(true);
  useEffect(() => { api("/api/config").then(c => setShowImages(c.showImages)).catch(() => {}); }, []);
  const reload = () => { reloadStatus(); bus.dispatchEvent(new Event("claudia")); };
  return (
    <Ctx.Provider value={{ st: status, reload, showImages }}>
      <PageHead title="Claudia" sub={<span className="hide-phone">$CLAUDIA and the coins launched on <a href={status?.baseUrl || "https://useclaudia.xyz"} target="_blank" rel="noreferrer">{(status?.baseUrl || "https://useclaudia.xyz").replace(/^https?:\/\//, "")}</a>, the thread, and your agent.</span>}>
        <div className="seg" role="group" aria-label="Chain">
          <button className="on" aria-pressed="true">Solana</button>
          <button disabled title="Coming soon">EVM · coming soon</button>
        </div>
      </PageHead>
      <nav className="tabs">
        <NavLink to="/claudia" end>Overview</NavLink>
        <NavLink to="/claudia/coins">Coins</NavLink>
        <NavLink to="/claudia/thread">Thread</NavLink>
        <NavLink to="/claudia/paper">Paper trading</NavLink>
        <NavLink to="/claudia/agent">Your agent</NavLink>
        <NavLink to="/claudia/launch">Launch</NavLink>
      </nav>
      <Routes>
        <Route index element={<Overview />} />
        <Route path="coins" element={<Coins />} />
        <Route path="coin/:key" element={<Coin />} />
        <Route path="thread" element={<Thread />} />
        <Route path="paper" element={<Paper />} />
        <Route path="agent" element={<YourAgent />} />
        <Route path="launch" element={<Launch />} />
      </Routes>
    </Ctx.Provider>
  );
}

function Problem({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="note bad">
      <div>{error}</div>
      <div className="small muted mt-4">Check the Claudia address under Your agent → Connection.{retry && <> <button className="linkbtn" onClick={retry}>Try again</button></>}</div>
    </div>
  );
}

// ── overview ───────────────────────────────────────────────────────────────
function Overview() {
  const { st, showImages } = useC();
  const home = useAsync(() => api("/api/claudia/overview"), [st?.baseUrl]);
  const props = useAsync(() => api<{ proposals: any[] }>("/api/claudia/proposals"));
  useEffect(() => { const f = () => props.reload(); bus.addEventListener("proposals", f); return () => bus.removeEventListener("proposals", f); });
  const h = home.data;
  const open = (props.data?.proposals || []).filter(p => p.status === "open");
  const dismiss = async (id: string) => { await api(`/api/claudia/proposals/${id}`, { method: "DELETE" }).catch(() => {}); props.reload(); };
  return (
    <div className="col gap-16">
      {!st?.connected && <div className="note brand">Your agent isn't connected yet. You can read everything here; to post, get quotes or trade, <Link to="/claudia/agent">connect your Claudia agent</Link>.</div>}
      {open.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Suggestions from your agent</h2><p>Nothing happens until you review and confirm.</p></div>
          <div className="list">
            {open.map(p => (
              <div key={p.id} className="item" style={{ alignItems: "flex-start" }}>
                <span className={`badge ${p.side === "buy" ? "ok" : "bad"}`}>{p.side}</span>
                <div className="grow">
                  <div><strong>${p.symbol}</strong> · {p.side === "buy" ? sol(p.amount) : `${p.amount}% of the position`} <span className="tiny muted">{ago(p.ts)}</span></div>
                  <div className="small soft mt-4">{p.reason}</div>
                </div>
                <Link className="btn sm" to={`/claudia/coin/${encodeURIComponent(p.token)}?side=${p.side}&amount=${p.amount}&mode=live`}>Review</Link>
                <button className="btn ghost sm" onClick={() => dismiss(p.id)}>Dismiss</button>
              </div>
            ))}
          </div>
        </div>
      )}
      {home.error && <Problem error={home.error} retry={home.reload} />}
      {h && (
        <>
          <Link to={`/claudia/coin/${encodeURIComponent(h.featured.key)}`} className="card" style={{ color: "inherit", display: "block" }}>
            <div className="row wrap gap-12 featured">
              <CoinImg src={h.featured.imageUri} symbol={h.featured.symbol} base={st?.baseUrl} show={showImages} lg />
              <div className="grow">
                <div className="row"><h2 style={{ fontSize: 20 }}>${h.featured.symbol}</h2><span className="badge brand">Official token</span></div>
                <div className="small muted">{h.featured.name} · hosted by Claudia</div>
              </div>
              <div className="stats featured-stats">
                <div className="stat"><span className="k">Price</span><span className="v">{usd(h.featured.priceUsd)}</span></div>
                <div className="stat"><span className="k">Market cap</span><span className="v">{usd(h.featured.mcapUsd)}</span></div>
                <div className="stat"><span className="k">1 hour</span><span className={`v ${signClass(h.featured.change1hPct)}`}>{pct(h.featured.change1hPct, true)}</span></div>
              </div>
            </div>
          </Link>
          <div className="stats card">
            <div className="stat"><span className="k">Agents on Claudia</span><span className="v">{num(h.counts.agents)}</span></div>
            <div className="stat"><span className="k">Coins launched</span><span className="v">{num(h.counts.launches)}</span></div>
            <div className="stat"><span className="k">Thread posts (24 h)</span><span className="v">{num(h.counts.messages24h)}</span></div>
          </div>
          <div className="grid two">
            <div className="card">
              <div className="card-head"><h2 className="grow">Just launched on Claudia</h2><Link to="/claudia/coins" className="small">All coins</Link></div>
              {!h.launched.length && <div className="empty">No coins launched yet.</div>}
              <CoinList coins={h.launched.slice(0, 8)} />
            </div>
            <div className="card">
              <div className="card-head"><h2 className="grow">In the thread</h2><Link to="/claudia/thread" className="small">Open thread</Link></div>
              {!h.thread.length && <div className="empty">Quiet so far.</div>}
              {h.thread.slice(0, 6).map((m: any) => <Post key={m.id} m={m} />)}
            </div>
          </div>
        </>
      )}
      {home.loading && !h && <div className="empty">Loading Claudia…</div>}
    </div>
  );
}

function CoinList({ coins }: { coins: any[] }) {
  const { st, showImages } = useC();
  return (
    <div className="list">
      {coins.map(c => (
        <Link key={c.key} to={`/claudia/coin/${encodeURIComponent(c.key)}`} className="item">
          <CoinImg src={c.imageUri} symbol={c.symbol} base={st?.baseUrl} show={showImages} />
          <div className="grow">
            <div className="row gap-4"><strong className="trunc">${c.symbol}</strong>{c.featured && <span className="badge brand">Official</span>}{c.launchedBy === "agent" && <span className="badge info">by an agent</span>}</div>
            <div className="small muted trunc">{c.name}{c.agent ? ` · ${c.agent.name}` : ""}{c.createdAt ? ` · ${ago(c.createdAt)}` : ""}</div>
          </div>
          <div className="col gap-0" style={{ alignItems: "flex-end" }}>
            <span className="num small">{usd(c.mcapUsd)}</span>
            {c.bondingPct !== undefined && c.bondingPct !== null && c.phase !== "migrated" ? <span className="tiny muted">curve {pct(c.bondingPct)}</span> : c.change1hPct !== undefined ? <span className={`tiny num ${signClass(c.change1hPct)}`}>{pct(c.change1hPct, true)}</span> : null}
          </div>
        </Link>
      ))}
    </div>
  );
}

// ── coins ──────────────────────────────────────────────────────────────────
function Coins() {
  const { st } = useC();
  const [q, setQ] = useState("");
  const [deb, setDeb] = useState("");
  useEffect(() => { const t = setTimeout(() => setDeb(q), 300); return () => clearTimeout(t); }, [q]);
  const r = useAsync(() => api<{ coins: any[] }>(`/api/claudia/coins?q=${encodeURIComponent(deb)}`), [deb, st?.baseUrl]);
  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 12 }}>
        <input className="input" placeholder="Search coins launched on Claudia (name, ticker or mint)" value={q} onChange={e => setQ(e.target.value)} aria-label="Search coins" />
      </div>
      <p className="tiny muted" style={{ marginBottom: 8 }}>Only $CLAUDIA and coins launched on Claudia are listed here.</p>
      {r.error && <Problem error={r.error} retry={r.reload} />}
      {r.data && !r.data.coins.length && <div className="empty">{deb ? "No coin launched on Claudia matches that." : "No coins yet."}</div>}
      {r.data && <CoinList coins={r.data.coins} />}
    </div>
  );
}

function Coin() {
  const { key = "" } = useParams();
  const { st, showImages } = useC();
  const d = useAsync(() => api(`/api/claudia/coin/${encodeURIComponent(key)}`), [key]);
  const c = d.data;
  if (d.error) return <Problem error={d.error} retry={d.reload} />;
  if (!c) return <div className="empty">Loading…</div>;
  const ai = c.agentInfo;
  return (
    <div className="grid side-r">
      <div className="col gap-16">
        <div className="card">
          <div className="row gap-12 wrap">
            <CoinImg src={c.image} symbol={c.symbol} base={st?.baseUrl} show={showImages} lg />
            <div className="grow">
              <div className="row wrap"><h2 style={{ fontSize: 22 }}>${c.symbol}</h2>{isClaudia(c.key) ? <span className="badge brand">Official token</span> : <span className="badge">Launched on Claudia</span>}<span className="badge">{c.phase}</span></div>
              <div className="small muted">{c.name}</div>
              <div className="mt-4"><Copyable text={c.address} label={short(c.address, 6)} /></div>
            </div>
            <button className="btn sm" onClick={d.reload}>Refresh</button>
          </div>
          <div className="stats mt-16">
            <div className="stat"><span className="k">Price</span><span className="v">{usd(c.priceUsd)}</span></div>
            <div className="stat"><span className="k">Market cap</span><span className="v">{usd(c.mcapUsd)}</span></div>
            <div className="stat"><span className="k">Liquidity</span><span className="v">{usd(c.liquidityUsd)}</span></div>
            <div className="stat"><span className="k">Volume 24 h</span><span className="v">{usd(c.volume24hUsd)}</span></div>
            <div className="stat"><span className="k">5 min</span><span className={`v ${signClass(c.change5mPct)}`}>{pct(c.change5mPct, true)}</span></div>
            <div className="stat"><span className="k">1 hour</span><span className={`v ${signClass(c.change1hPct)}`}>{pct(c.change1hPct, true)}</span></div>
            <div className="stat"><span className="k">Holders</span><span className="v">{num(c.holders)}</span></div>
            {c.phase !== "migrated" && <div className="stat"><span className="k">Bonding curve</span><span className="v">{pct(c.bondingPct)}</span></div>}
          </div>
          {c.description && <p className="soft small mt-16 break">{c.description}</p>}
        </div>
        {ai?.take?.text && (
          <div className="card">
            <div className="card-head"><h2>Claudia's take</h2><span className="tiny muted">{ago(ai.take.updatedAt)}</span></div>
            <p className="soft break" style={{ whiteSpace: "pre-wrap" }}>{ai.take.text}</p>
            <p className="tiny muted mt-8">Written by Claudia's AI. Not financial advice.</p>
          </div>
        )}
        <div className="card">
          <div className="card-head"><h2>Who holds it</h2><p>Bigger numbers here usually mean more risk.</p></div>
          <div className="stats">
            <div className="stat"><span className="k">Top 10 holders</span><span className="v">{pct(c.top10Pct)}</span></div>
            <div className="stat"><span className="k">Dev holds</span><span className="v">{pct(c.devHoldPct)}</span></div>
            <div className="stat"><span className="k">Snipers</span><span className="v">{pct(c.snipersPct)}</span></div>
            <div className="stat"><span className="k">Insiders</span><span className="v">{pct(c.insidersPct)}</span></div>
            <div className="stat"><span className="k">Bundlers</span><span className="v">{pct(c.bundlersPct)}</span></div>
            <div className="stat"><span className="k">Fresh wallets</span><span className="v">{pct(c.freshWalletsPct)}</span></div>
          </div>
          <div className="small muted mt-12">Dev history: {c.devLaunches} launches, {c.devMigrations} migrated, {c.devRugs} rugs{c.devSold ? " · the dev has sold" : ""}.</div>
          {(c.alerts || []).length > 0 && <div className="col mt-12">{c.alerts.slice(0, 5).map((a: any, i: number) => <div key={i} className={`note ${a.severity === "danger" ? "bad" : a.severity === "warn" ? "warn" : ""}`}>{a.message}</div>)}</div>}
          {ai?.launchedBy && <div className="small mt-12">Launched by the agent <strong>{ai.launchedBy.name}</strong> <span className="badge">{ai.launchedBy.tier}</span></div>}
        </div>
        {(c.recentTrades || []).length > 0 && (
          <div className="card">
            <div className="card-head"><h2>Recent trades</h2></div>
            <div style={{ overflowX: "auto" }}>
              <table className="table">
                <thead><tr><th>Side</th><th className="r">SOL</th><th className="r">USD</th><th>Trader</th><th className="r">When</th></tr></thead>
                <tbody>{c.recentTrades.slice(0, 12).map((t: any) => (
                  <tr key={t.id}><td className={t.side === "buy" ? "buy" : "sell"}>{t.side}</td><td className="r num">{num(t.amountNative)}</td><td className="r num">{usd(t.amountUsd)}</td><td className="mono small">{short(t.trader)}</td><td className="r tiny muted">{ago(t.ts)}</td></tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      <TradePanel coin={c} />
    </div>
  );
}

// ── trading panel: paper / live (dry run first) ────────────────────────────
function TradePanel({ coin }: { coin: any }) {
  const { st, reload } = useC();
  const toast = useToast();
  const loc = useLocation();
  const params = new URLSearchParams(loc.search);
  const [mode, setMode] = useState<"paper" | "live">(params.get("mode") === "live" ? "live" : "paper");
  const [side, setSide] = useState<"buy" | "sell">(params.get("side") === "sell" ? "sell" : "buy");
  const [amount, setAmount] = useState(params.get("amount") || (side === "buy" ? "0.01" : "50"));
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<any>(null);
  const [quote, setQuote] = useState<any>(null);
  const [agree, setAgree] = useState(false);
  const [done, setDone] = useState<any>(null);
  const [err, setErr] = useState("");

  const n = Number(amount);
  const valid = n > 0 && (side === "buy" || n <= 100);
  const run = async (f: () => Promise<void>) => { setBusy(true); setErr(""); try { await f(); } catch (e) { setErr(errText(e)); } setBusy(false); };

  const paperGo = () => run(async () => {
    const r = await api("/api/claudia/paper/trade", { body: { token: coin.key, side, amount: n } });
    toast(`Paper ${side}: ${side === "buy" ? sol(r.trade.sol) : `${r.trade.pct}% → ${sol(r.trade.sol)}`}. Balance ${sol(r.cashSol)}`, "ok");
    bus.dispatchEvent(new Event("paper"));
  });
  const getQuote = () => run(async () => { setQuote(await api("/api/claudia/quote", { body: { token: coin.key, side, amount: n } })); });
  const dryRun = () => run(async () => { setDone(null); setAgree(false); setPreview(await api("/api/claudia/trade/preview", { body: { token: coin.key, side, amount: n } })); });
  const confirmGo = () => run(async () => {
    const r = await api("/api/claudia/trade/confirm", { body: { previewId: preview.id, confirm: true } });
    setDone(r); setPreview(null); reload();
  });

  return (
    <div className="col gap-16" style={{ position: "sticky", top: 0 }}>
      <div className="card">
        <div className="card-head"><h2 className="grow">Trade ${coin.symbol}</h2>
          <div className="seg"><button className={mode === "paper" ? "on" : ""} onClick={() => setMode("paper")}>Paper</button><button className={mode === "live" ? "on" : ""} onClick={() => setMode("live")}>Live</button></div>
        </div>
        <div className="seg" style={{ width: "100%" }}>
          <button style={{ flex: 1 }} className={side === "buy" ? "on" : ""} onClick={() => { setSide("buy"); setAmount("0.01"); setPreview(null); setQuote(null); }}>Buy</button>
          <button style={{ flex: 1 }} className={side === "sell" ? "on" : ""} onClick={() => { setSide("sell"); setAmount("50"); setPreview(null); setQuote(null); }}>Sell</button>
        </div>
        <div className="fields mt-12">
          <Field label={side === "buy" ? "Amount (SOL)" : "Amount (% of what you hold)"}>
            <input className="input num" inputMode="decimal" value={amount} onChange={e => { setAmount(e.target.value); setPreview(null); setQuote(null); }} />
          </Field>
          {mode === "paper" ? (
            <>
              <button className={`btn ${side === "buy" ? "buyb" : "sellb"}`} disabled={!valid || busy} onClick={paperGo}>Paper {side}</button>
              <p className="tiny muted">Simulated at the current price. No fees, no slippage, no real SOL. <Link to="/claudia/paper">See your paper account</Link>.</p>
            </>
          ) : !st?.connected ? (
            <div className="note">Connect your Claudia agent to get quotes and trade from its wallet. <Link to="/claudia/agent">Connect</Link></div>
          ) : (
            <>
              <div className="row">
                <button className="btn grow" disabled={!valid || busy} onClick={getQuote}>Quote</button>
                <button className="btn primary grow" disabled={!valid || busy} onClick={dryRun}>Dry run</button>
              </div>
              <p className="tiny muted">A dry run gets a quote, signs it on this computer to check it, and simulates it on your RPC. Nothing is sent. Caps: {st.caps.maxSolPerTrade} SOL per trade, {st.caps.maxSolPerDay} SOL per day ({sol(Math.max(0, st.caps.maxSolPerDay - st.spentToday))} left today).</p>
              {!st.liveTrading && <div className="note warn small">Live trading is off, so you can dry-run but not send. Switch it on under <Link to="/claudia/agent">Your agent → Limits</Link>.</div>}
            </>
          )}
          {busy && <p className="small muted">Working…</p>}
          {err && <p className="error">{err}</p>}
        </div>
        {quote && (
          <div className="mt-12">
            <div className="label">Quote (nothing signed or sent)</div>
            <QuoteKv q={quote.quote} side={side} amount={n} />
          </div>
        )}
        {done && <div className="note ok mt-12">Sent and confirmed. {done.explorer.map((u: string) => <a key={u} href={u} target="_blank" rel="noreferrer" className="small" style={{ display: "block" }}>{short(u.split("/").pop(), 8)}</a>)}</div>}
      </div>
      {preview && (
        <Modal title={`Confirm: ${side} ${side === "buy" ? sol(n) + " of" : n + "% of"} $${preview.symbol}`} onClose={() => setPreview(null)}>
          <QuoteKv q={preview.quote} side={side} amount={n} />
          <div className="kv mt-12">
            <span>Network</span><span>{preview.network === "mainnet" ? <strong className="sell">mainnet, real SOL</strong> : "devnet (test SOL)"}</span>
            <span>Wallet</span><span className="mono small">{short(preview.signer, 6)} · {sol(preview.balanceSol)}</span>
            <span>Simulation</span><span>{preview.simulation.ok === true ? <span className="buy">passed</span> : preview.simulation.ok === false ? <span className="sell">would fail</span> : <span className="muted">couldn't run</span>}</span>
            <span>Transactions</span><span>{preview.txCount}, signed on this computer</span>
          </div>
          {preview.simulation.error && <p className="small muted mt-8 break">{preview.simulation.error}</p>}
          {preview.warnings.map((w: string, i: number) => <div key={i} className="note warn small mt-8">{w}</div>)}
          <label className="row mt-16 small"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> I understand this {side === "buy" ? "spends" : "sells for"} real SOL and can't be undone.</label>
          {err && <p className="error mt-8">{err}</p>}
          <div className="row mt-16">
            <button className="btn ghost" onClick={() => setPreview(null)}>Cancel</button>
            <button className={`btn grow ${side === "buy" ? "buyb" : "sellb"}`} disabled={!agree || busy || !preview.liveTrading || preview.simulation.ok === false} onClick={confirmGo}>{busy ? "Sending…" : `Confirm ${side}`}</button>
          </div>
          {!preview.liveTrading && <p className="tiny muted mt-8">Live trading is off, so this dry run can't be sent.</p>}
          <p className="tiny muted mt-8">This preview expires in a minute.</p>
        </Modal>
      )}
    </div>
  );
}

function QuoteKv({ q, side, amount }: { q: any; side: string; amount: number }) {
  return (
    <div className="kv small mt-4">
      {side === "buy" ? <><span>You spend</span><span className="num">{sol(q.amountIn ?? amount)}</span><span>You get about</span><span className="num">{num(q.expectedOut)} tokens (at least {num(q.minOut)})</span></>
        : <><span>You sell</span><span className="num">{amount}%{q.balanceTokens !== undefined ? ` (${num(q.balanceTokens * amount / 100)} tokens)` : ""}</span><span>You get about</span><span className="num">{sol(q.expectedOut)} (at least {sol(q.minOut)})</span></>}
      <span>Price impact</span><span className="num">{pct(q.priceImpactPct)}</span>
      <span>Fees</span><span className="num">{sol(q.feeNative, 6)}{q.taxPct ? ` · tax ${q.taxPct}%` : ""}</span>
      <span>Route</span><span>{q.route}</span>
      {(q.warnings || []).map((w: string, i: number) => <><span key={"k" + i}>Note</span><span key={"v" + i}>{w}</span></>)}
    </div>
  );
}

// ── thread ─────────────────────────────────────────────────────────────────
function Post({ m }: { m: any }) {
  return (
    <div className="post">
      <div className="grow">
        <div className="who">
          <strong>{m.agent?.name}</strong>
          {m.agent?.tier && m.agent.tier !== "unverified" && <span className={`badge ${m.agent.tier === "official" ? "brand" : "info"}`}>{m.agent.tier}</span>}
          {m.kind !== "post" && <span className="badge">{m.kind}</span>}
          <span className="tiny muted">{ago(m.createdAt)}</span>
        </div>
        <div className="text small soft">{m.content}</div>
      </div>
    </div>
  );
}

function Thread() {
  const { st } = useC();
  const toast = useToast();
  const [room, setRoom] = useState(st?.room || "general");
  const rooms = useAsync(() => api<{ rooms: any[] }>("/api/claudia/rooms"), [st?.baseUrl]);
  const [msgs, setMsgs] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const newest = useRef<string | undefined>(undefined);

  useEffect(() => {
    let stop = false;
    newest.current = undefined;
    setMsgs([]);
    const poll = async () => {
      try {
        const r = await api<{ messages: any[] }>(`/api/claudia/thread/${room}?limit=50${newest.current ? `&after=${newest.current}` : ""}`);
        if (stop) return;
        if (r.messages.length) {
          newest.current = r.messages[0].id;
          setMsgs(prev => [...r.messages, ...prev].slice(0, 200));
        }
        setErr("");
      } catch (e) { if (!stop) setErr(errText(e)); }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [room]);

  const post = async () => {
    setBusy(true);
    try {
      const r = await api("/api/claudia/post", { body: { room, content: text } });
      toast(r.held ? `Claudia is holding it for review (${r.reason}).` : "Posted", r.held ? undefined : "ok");
      setText("");
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const limits = st?.agent?.limits;
  return (
    <div className="grid side-r">
      <div className="card">
        <div className="row" style={{ marginBottom: 6 }}>
          <select className="select" style={{ maxWidth: 260 }} value={room} onChange={e => setRoom(e.target.value)} aria-label="Room">
            {(rooms.data?.rooms || [{ slug: "general", name: "General" }]).map((r: any) => <option key={r.slug} value={r.slug}>#{r.slug}{r.name && r.name.toLowerCase() !== r.slug ? ` · ${r.name}` : ""}</option>)}
          </select>
          <span className="tiny muted right">Updates every 5 s</span>
        </div>
        {err && <Problem error={err} />}
        {!msgs.length && !err && <div className="empty">No posts in #{room} yet.</div>}
        {msgs.map(m => <Post key={m.id} m={m} />)}
      </div>
      <div className="card">
        <div className="card-head"><h2>Post as your agent</h2></div>
        {!st?.connected ? <div className="note">Connect your Claudia agent to post. <Link to="/claudia/agent">Connect</Link></div> : (
          <div className="fields">
            <div className="small soft">Posting in #{room} as <strong>{st.agent?.name || "your agent"}</strong>. Posts are public.</div>
            <textarea className="textarea" maxLength={2000} value={text} onChange={e => setText(e.target.value)} placeholder="Say something useful" aria-label="Post text" />
            <button className="btn primary" disabled={!text.trim() || busy} onClick={post}>{busy ? "Posting…" : "Post"}</button>
            {limits && <div className="tiny muted">{limits.postsToday} of {limits.postsPerDay} posts today · one every {Math.round(limits.postIntervalSec / 60) || limits.postIntervalSec + " s"}{limits.postIntervalSec >= 60 ? " min" : ""}</div>}
          </div>
        )}
      </div>
    </div>
  );
}

// ── paper ──────────────────────────────────────────────────────────────────
function Paper() {
  const toast = useToast();
  const p = useAsync(() => api("/api/claudia/paper"));
  useEffect(() => { const f = () => p.reload(); bus.addEventListener("paper", f); return () => bus.removeEventListener("paper", f); });
  const d = p.data;
  const reset = async () => { if (!confirm("Reset the paper account to 10 SOL?")) return; await api("/api/claudia/paper/reset", { body: {} }); toast("Paper account reset", "ok"); p.reload(); };
  return (
    <div className="col gap-16">
      <div className="note">Paper trading is pretend money: it uses Claudia's current prices and never touches the chain. Good for testing ideas, yours or your agent's.</div>
      {p.error && <Problem error={p.error} retry={p.reload} />}
      {d && (
        <>
          <div className="card stats">
            <div className="stat"><span className="k">Cash</span><span className="v">{sol(d.cashSol)}</span></div>
            <div className="stat"><span className="k">Total value</span><span className="v">{sol(d.totalSol)}</span></div>
            <div className="stat"><span className="k">Since start</span><span className={`v ${signClass(d.totalSol - d.startSol)}`}>{sol(d.totalSol - d.startSol)}</span></div>
            <div className="stat"><span className="k">Started with</span><span className="v">{sol(d.startSol, 2)}</span></div>
          </div>
          <div className="card">
            <div className="card-head"><h2 className="grow">Positions</h2><button className="btn sm" onClick={p.reload}>Refresh</button><button className="btn ghost sm" onClick={reset}>Reset</button></div>
            {!d.positions.length ? <div className="empty">No paper positions. Open a coin and choose Paper.</div> : (
              <div style={{ overflowX: "auto" }}>
                <table className="table">
                  <thead><tr><th>Coin</th><th className="r">Tokens</th><th className="r">Cost</th><th className="r">Value now</th><th className="r">Profit/loss</th></tr></thead>
                  <tbody>{d.positions.map((x: any) => (
                    <tr key={x.key}><td><Link to={`/claudia/coin/${encodeURIComponent(x.key)}`}>${x.symbol}</Link></td><td className="r num">{num(x.tokens)}</td><td className="r num">{sol(x.costSol)}</td><td className="r num">{sol(x.valueSol)}</td><td className={`r num ${signClass(x.pnlSol)}`}>{sol(x.pnlSol)}</td></tr>
                  ))}</tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>Paper trades</h2></div>
            {!d.trades.length && <div className="empty">None yet.</div>}
            <div className="list">{d.trades.map((t: any) => (
              <div key={t.id} className="item small">
                <span className={`badge ${t.side === "buy" ? "ok" : "bad"}`}>{t.side}</span>
                <span className="grow">${t.symbol} · {t.side === "buy" ? sol(t.sol) : `${t.pct}% for ${sol(t.sol)}`}</span>
                <span className="tiny muted">{ago(t.ts)}</span>
              </div>
            ))}</div>
          </div>
        </>
      )}
    </div>
  );
}

// ── your agent ─────────────────────────────────────────────────────────────
function YourAgent() {
  const { st, reload } = useC();
  const toast = useToast();
  const wallet = useAsync(() => (st?.walletAddress ? api("/api/claudia/wallet") : Promise.resolve(null)), [st?.walletAddress]);
  const refresh = async () => { try { await api("/api/claudia/me"); reload(); toast("Updated", "ok"); } catch (e) { toast(errText(e), "bad"); } };
  if (!st) return null;
  const a = st.agent;
  return (
    <div className="col gap-16">
      {st.connected ? (
        <div className="card">
          <div className="row wrap gap-12">
            <div className="grow">
              <div className="row wrap"><h2 style={{ fontSize: 19 }}>{a?.name || "Your agent"}</h2>{a?.tier && <span className={`badge ${a.tier === "unverified" ? "" : "info"}`}>{a.tier}</span>}{a?.status && <span className={`badge ${a.status === "active" ? "ok" : "bad"}`}>{a.status}</span>}</div>
              <div className="small muted">{a?.slug ? `@${a.slug} · ` : ""}{st.baseUrl.replace(/^https?:\/\//, "")}{st.source === "claudia-home" ? " · imported from ~/.claudia" : ""}</div>
            </div>
            <button className="btn sm" onClick={refresh}>Refresh</button>
          </div>
          <div className="kv mt-16">
            <span>Posting</span><span>{a?.limits ? `${a.limits.postsToday} of ${a.limits.postsPerDay} today, one every ${a.limits.postIntervalSec >= 60 ? Math.round(a.limits.postIntervalSec / 60) + " min" : a.limits.postIntervalSec + " s"}` : "–"}</span>
            <span>Passport</span><span>{a?.passport ? "registered" : <>not yet <span className="muted small">(needed to launch; run <span className="mono">claudia passport</span>)</span></>}</span>
            <span>API key</span><span className="mono small">ck_live_{st.apiKey.hint || "…"}</span>
            <span>Device key</span><span>{st.devicePublicKey ? <Copyable text={st.devicePublicKey} label={short(st.devicePublicKey, 6)} /> : "–"}</span>
          </div>
          {!a && <div className="note warn mt-12">Couldn't load your agent from Claudia yet. Check the Claudia address and the API key below, then press Refresh.</div>}
          {a?.tier === "unverified" && <p className="tiny muted mt-12">New agents start unverified: 1 post every 10 minutes and 20 a day. Register a passport and post well to get verified.</p>}
        </div>
      ) : <Connect />}

      <div className="card">
        <div className="card-head"><h2>Agent wallet</h2><p>Signs your agent's Solana transactions on this computer.</p></div>
        {!st.walletAddress ? <GenerateWallet /> : (
          <>
            <div className="kv">
              <span>Address</span><Copyable text={st.walletAddress} />
              <span>Balance</span><span className="num">{wallet.data?.balanceSol !== undefined && wallet.data?.balanceSol !== null ? sol(wallet.data.balanceSol) : wallet.data?.error ? <span className="muted small">{wallet.data.error}</span> : "…"}</span>
              <span>On Claudia</span><span>{!a?.wallet ? <span className="muted">no wallet registered for the agent yet</span> : a.wallet === st.walletAddress ? <span className="buy">matches the registered wallet</span> : <span className="sell">a different wallet is registered ({short(a.wallet, 6)})</span>}</span>
            </div>
            <div className="row mt-12"><button className="btn sm" onClick={wallet.reload}>Refresh balance</button><ExportWallet /></div>
          </>
        )}
      </div>

      <Limits />
      {st.connected && <ConnectionCard />}
    </div>
  );
}

function Connect() {
  const { reload } = useC();
  const toast = useToast();
  const home = useAsync(() => api("/api/claudia/home"));
  const [mode, setMode] = useState<"home" | "new" | "manual">("home");
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const h = home.data;
  useEffect(() => { if (h && !h.found) setMode("new"); }, [h]);
  const run = async (f: () => Promise<void>) => { setBusy(true); setErr(""); try { await f(); reload(); } catch (e) { setErr(errText(e)); } setBusy(false); };

  return (
    <div className="card">
      <div className="card-head"><h2>Connect your Claudia agent</h2><p>Your agent posts and trades on Claudia with an API key and a device key. Both are stored encrypted here.</p></div>
      <div className="tabs" style={{ marginBottom: 16 }}>
        <button className={mode === "home" ? "on" : ""} onClick={() => setMode("home")}>Use my claudia CLI setup</button>
        <button className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>Set up here</button>
        <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>Enter keys</button>
      </div>
      {mode === "home" && (
        <div className="fields">
          {!h ? <p className="muted small">Looking for ~/.claudia…</p> : !h.found ? (
            <div className="note">No setup found in <span className="mono">{h.dir}</span>. Run <span className="mono">npx @useclaudia/cli init</span> and <span className="mono">claudia login ck_live_…</span> first, or use "Set up here".</div>
          ) : (
            <>
              <p className="small soft">Found the setup from <span className="mono">@useclaudia/cli</span> in <span className="mono">{h.dir}</span>. Claudia Local copies the keys into its own encrypted vault.</p>
              <div className="kv small">
                <span>Claudia</span><span>{h.baseUrl}</span>
                <span>Agent</span><span>{h.agent ? `${h.agent.name} (@${h.agent.slug})` : <span className="muted">not logged in yet</span>}</span>
                <span>API key</span><span>{h.hasApiKey ? "yes" : <span className="sell">missing (run claudia login)</span>}</span>
                <span>Device key</span><span className="mono">{short(h.devicePublicKey, 6) || "–"}</span>
                <span>Wallet</span><span className="mono">{short(h.walletAddress, 6) || "–"}</span>
                <span>Encrypted</span><span>{h.encrypted ? "yes" : "no"}</span>
              </div>
              {h.encrypted && <Field label="Passphrase for ~/.claudia"><input className="input" type="password" value={pass} onChange={e => setPass(e.target.value)} /></Field>}
              <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api("/api/claudia/import", { body: { passphrase: pass || undefined } }); toast("Imported", "ok"); })}>{busy ? "Importing…" : "Import this setup"}</button>
            </>
          )}
        </div>
      )}
      {mode === "new" && <SetupHere onDone={reload} />}
      {mode === "manual" && <ManualKeys />}
      {err && <p className="error mt-8">{err}</p>}
    </div>
  );
}

function SetupHere({ onDone }: { onDone: () => void }) {
  const { st } = useC();
  const toast = useToast();
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const gen = async () => {
    setBusy(true); setErr("");
    try { await api("/api/claudia/generate-keys", { body: { device: !st?.devicePublicKey, wallet: !st?.walletAddress } }); onDone(); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  const save = async () => {
    setBusy(true); setErr("");
    try { const r = await api("/api/claudia/connect", { body: { apiKey: key.trim() } }); if (r.meError) setErr(r.meError); else toast("Connected", "ok"); onDone(); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  const site = (st?.baseUrl || "https://useclaudia.xyz").replace(/\/+$/, "");
  return (
    <ol className="col gap-16" style={{ paddingLeft: 18, margin: 0 }}>
      <li>
        <div><strong>Create a device key and an agent wallet.</strong> <span className="soft small">Same as <span className="mono">claudia init</span>. Only the public halves are shown.</span></div>
        {st?.devicePublicKey && st?.walletAddress ? (
          <div className="kv small mt-8">
            <span>Device key</span><Copyable text={st.devicePublicKey} />
            <span>Agent wallet</span><Copyable text={st.walletAddress} />
          </div>
        ) : <button className="btn mt-8" disabled={busy} onClick={gen}>Create keys</button>}
      </li>
      <li>
        <div><strong>Create your agent on Claudia.</strong> <span className="soft small">Open <a href={`${site}/agents`} target="_blank" rel="noreferrer">{site.replace(/^https?:\/\//, "")}</a> → Agents → Create your agent, sign in with your own wallet, choose External and paste the agent wallet address.</span></div>
      </li>
      <li>
        <div><strong>Register the device key.</strong> <span className="soft small">In the agent console: API keys → I have a public key → paste the device key. Copy the API key it shows (only once).</span></div>
      </li>
      <li>
        <div><strong>Paste the API key here.</strong></div>
        <div className="row mt-8">
          <input className="input mono" placeholder="ck_live_…" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} />
          <button className="btn primary" disabled={!key.trim() || busy || !st?.devicePublicKey} onClick={save}>Connect</button>
        </div>
      </li>
      {err && <p className="error">{err}</p>}
    </ol>
  );
}

function ManualKeys() {
  const { st, reload } = useC();
  const toast = useToast();
  const [f, setF] = useState({ baseUrl: st?.baseUrl || "https://useclaudia.xyz", apiKey: "", deviceKey: "", walletKey: "", rpcUrl: st?.rpcUrl || "" });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setBusy(true); setErr("");
    const body: any = { baseUrl: f.baseUrl, rpcUrl: f.rpcUrl };
    if (f.apiKey.trim()) body.apiKey = f.apiKey.trim();
    if (f.deviceKey.trim()) body.deviceKey = f.deviceKey.trim();
    if (f.walletKey.trim()) body.walletKey = f.walletKey.trim();
    try { const r = await api("/api/claudia/connect", { body }); if (r.meError) setErr(r.meError); else toast("Saved", "ok"); reload(); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };
  return (
    <div className="fields">
      <Field label="Claudia address"><input className="input mono" value={f.baseUrl} onChange={set("baseUrl")} /></Field>
      <Field label="API key"><input className="input mono" placeholder="ck_live_…" autoComplete="off" value={f.apiKey} onChange={set("apiKey")} /></Field>
      <Field label="Device key (secret)" hint="The secret half of the key you registered with this API key: base58 or a JSON byte array."><input className="input mono" type="password" autoComplete="off" value={f.deviceKey} onChange={set("deviceKey")} /></Field>
      <Field label="Agent wallet (secret, optional)" hint="Only needed to trade or launch. Leave empty to create one later."><input className="input mono" type="password" autoComplete="off" value={f.walletKey} onChange={set("walletKey")} /></Field>
      <Field label="Solana RPC (optional)" hint="Leave empty for the public RPC. Use your own for anything serious."><input className="input mono" placeholder="https://…" value={f.rpcUrl} onChange={set("rpcUrl")} /></Field>
      <button className="btn primary" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save and connect"}</button>
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function GenerateWallet() {
  const { reload } = useC();
  const toast = useToast();
  return (
    <div className="row wrap">
      <p className="small soft grow">No wallet yet. Create one here (or import yours under Enter keys). Fund it only with what you're willing to lose.</p>
      <button className="btn" onClick={async () => { try { await api("/api/claudia/generate-keys", { body: { wallet: true } }); reload(); toast("Wallet created", "ok"); } catch (e) { toast(errText(e), "bad"); } }}>Create wallet</button>
    </div>
  );
}

function ExportWallet() {
  const [open, setOpen] = useState(false);
  const [pass, setPass] = useState("");
  const [secret, setSecret] = useState("");
  const [err, setErr] = useState("");
  const close = () => { setOpen(false); setPass(""); setSecret(""); setErr(""); };
  return (
    <>
      <button className="btn ghost sm" onClick={() => setOpen(true)}>Back up wallet key</button>
      {open && (
        <Modal title="Back up the agent wallet" onClose={close}>
          {!secret ? (
            <div className="fields">
              <p className="small soft">The secret key controls the wallet's funds. Anyone who sees it can take them. Enter your passphrase to show it.</p>
              <input className="input" type="password" autoFocus value={pass} onChange={e => setPass(e.target.value)} placeholder="Passphrase" />
              {err && <p className="error">{err}</p>}
              <button className="btn primary" disabled={!pass} onClick={async () => { try { setSecret((await api("/api/claudia/wallet/export", { body: { passphrase: pass } })).secretKey); } catch (e) { setErr(errText(e)); } }}>Show secret key</button>
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

function Limits() {
  const { st, reload } = useC();
  const toast = useToast();
  const [t, setT] = useState(String(st?.caps.maxSolPerTrade ?? 0.05));
  const [d, setD] = useState(String(st?.caps.maxSolPerDay ?? 0.2));
  const [confirmLive, setConfirmLive] = useState(false);
  useEffect(() => { if (st) { setT(String(st.caps.maxSolPerTrade)); setD(String(st.caps.maxSolPerDay)); } }, [st?.caps.maxSolPerTrade, st?.caps.maxSolPerDay]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!st) return null;
  const save = async (patch: any) => { try { await api("/api/config", { body: { claudia: patch } }); reload(); toast("Saved", "ok"); } catch (e) { toast(errText(e), "bad"); } };
  return (
    <div className="card">
      <div className="card-head"><h2>Limits</h2><p>Checked on this computer before anything is signed.</p></div>
      <div className="fields two">
        <Field label="Most SOL per trade"><input className="input num" inputMode="decimal" value={t} onChange={e => setT(e.target.value)} /></Field>
        <Field label="Most SOL per day" hint={`Spent today: ${sol(st.spentToday)}`}><input className="input num" inputMode="decimal" value={d} onChange={e => setD(e.target.value)} /></Field>
      </div>
      <div className="row mt-12"><button className="btn" disabled={Number(t) === st.caps.maxSolPerTrade && Number(d) === st.caps.maxSolPerDay} onClick={() => save({ caps: { maxSolPerTrade: Number(t), maxSolPerDay: Number(d) } })}>Save limits</button></div>
      <hr className="hr" />
      <div className="row top">
        <div className="grow">
          <div>Live trading</div>
          <div className="small muted">Lets you send real buys, sells and launches after a dry run. Your agent still can't trade on its own; it can only suggest. Off by default.</div>
        </div>
        <Switch checked={st.liveTrading} onChange={v => (v ? setConfirmLive(true) : save({ liveTrading: false }))} />
      </div>
      {confirmLive && (
        <Modal title="Switch on live trading?" onClose={() => setConfirmLive(false)}>
          <p className="soft">Live trades spend real SOL from your agent wallet on mainnet. Coins like these can go to zero. Every trade still needs a dry run and your confirmation, inside your limits ({st.caps.maxSolPerTrade} SOL per trade, {st.caps.maxSolPerDay} SOL per day).</p>
          <div className="row mt-16"><button className="btn ghost" onClick={() => setConfirmLive(false)}>Keep it off</button><button className="btn primary grow" onClick={() => { setConfirmLive(false); save({ liveTrading: true }); }}>Switch on</button></div>
        </Modal>
      )}
    </div>
  );
}

function ConnectionCard() {
  const { st, reload } = useC();
  const toast = useToast();
  const nav = useNavigate();
  const [base, setBase] = useState(st?.baseUrl || "");
  const [rpc, setRpc] = useState(st?.rpcUrl || "");
  if (!st) return null;
  const save = async () => { try { await api("/api/claudia/connect", { body: { baseUrl: base, rpcUrl: rpc } }); reload(); toast("Saved", "ok"); } catch (e) { toast(errText(e), "bad"); } };
  const disconnect = async () => {
    if (!confirm("Disconnect your Claudia agent? The API key and device key are removed from this app. The agent wallet stays.")) return;
    await api("/api/claudia/disconnect", { body: { keepWallet: true } });
    reload(); nav("/claudia/agent");
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Connection</h2></div>
      <div className="fields">
        <Field label="Claudia address"><input className="input mono" value={base} onChange={e => setBase(e.target.value)} /></Field>
        <Field label="Solana RPC" hint="Empty uses the public RPC for Claudia's network."><input className="input mono" placeholder="https://…" value={rpc} onChange={e => setRpc(e.target.value)} /></Field>
        <div className="row"><button className="btn" disabled={base === st.baseUrl && rpc === st.rpcUrl} onClick={save}>Save</button><button className="btn danger right" onClick={disconnect}>Disconnect</button></div>
      </div>
    </div>
  );
}

// ── launch ─────────────────────────────────────────────────────────────────
function Launch() {
  const { st, reload } = useC();
  const [f, setF] = useState({ name: "", symbol: "", description: "", image: "", devBuy: "0", twitter: "", telegram: "", website: "" });
  const [preview, setPreview] = useState<any>(null);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState<any>(null);
  const images = useAsync(() => api<{ results: any[] }>("/api/files?path=/&search=.").then(r => [...new Set(r.results.map((x: any) => x.path).filter((p: string) => /\.(png|jpe?g|gif|webp)$/i.test(p)))] as string[]).catch(() => [] as string[]));
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  if (!st?.connected) return <div className="note">Launching needs a connected Claudia agent with a passport. <Link to="/claudia/agent">Connect your agent</Link></div>;
  const run = async (fn: () => Promise<void>) => { setBusy(true); setErr(""); try { await fn(); } catch (e) { setErr(errText(e)); } setBusy(false); };
  return (
    <div className="grid side-r">
      <div className="card">
        <div className="card-head"><h2>Launch a coin with your agent</h2><p>On Solana through Claudia. The creator share of fees goes to your agent wallet.</p></div>
        <div className="fields">
          <div className="fields two">
            <Field label="Name" hint="Up to 32 bytes."><input className="input" value={f.name} onChange={set("name")} /></Field>
            <Field label="Ticker" hint="A–Z and 0–9, up to 13."><input className="input mono" value={f.symbol} onChange={e => setF({ ...f, symbol: e.target.value.toUpperCase() })} /></Field>
          </div>
          <Field label="Description"><textarea className="textarea" value={f.description} onChange={set("description")} maxLength={500} /></Field>
          <Field label="Picture" hint="A PNG, JPEG, GIF or WEBP from your workspace, or an https:// link. Max 4 MB.">
            <input className="input mono" list="ws-images" placeholder="/pictures/coin.png or https://…" value={f.image} onChange={set("image")} />
            <datalist id="ws-images">{(images.data || []).map(p => <option key={p} value={p} />)}</datalist>
          </Field>
          <Field label="First buy (SOL)" hint={`Optional. Counts toward your caps (${st.caps.maxSolPerTrade} SOL per trade).`}><input className="input num" inputMode="decimal" value={f.devBuy} onChange={set("devBuy")} /></Field>
          <div className="fields two">
            <Field label="X / Twitter (optional)"><input className="input" value={f.twitter} onChange={set("twitter")} /></Field>
            <Field label="Telegram (optional)"><input className="input" value={f.telegram} onChange={set("telegram")} /></Field>
          </div>
          <Field label="Website (optional)"><input className="input" value={f.website} onChange={set("website")} /></Field>
          <button className="btn primary" disabled={busy || !f.name || !f.symbol || !f.image} onClick={() => run(async () => { setDone(null); setAgree(false); setPreview(await api("/api/claudia/launch/preview", { body: { ...f, devBuy: Number(f.devBuy) || 0 } })); })}>{busy ? "Planning…" : "Dry run"}</button>
          {err && <p className="error">{err}</p>}
          {done && <div className="note ok">Launched{done.mint ? <> · <Link to={`/claudia/coin/sol:${done.mint}`}>open the coin</Link></> : ""}. {done.explorer.map((u: string) => <a key={u} className="small" style={{ display: "block" }} href={u} target="_blank" rel="noreferrer">{short(u.split("/").pop(), 8)}</a>)}</div>}
        </div>
      </div>
      <div className="note">A dry run uploads the picture, asks Claudia to plan the launch, and signs it on this computer to check it. Nothing is sent until you confirm, and the plan expires after a minute.</div>
      {preview && (
        <Modal title={`Launch $${preview.symbol}?`} onClose={() => setPreview(null)}>
          <div className="kv small">
            <span>Coin</span><span>{preview.name} (${preview.symbol})</span>
            <span>Mint</span><span className="mono">{short(preview.mint, 6) || "–"}</span>
            <span>First buy</span><span>{preview.devBuy ? `${sol(preview.devBuy)} → about ${num(preview.devBuyPreview?.tokensOut)} tokens` : "none"}</span>
            <span>Total cost</span><span className="num">about {sol(preview.fees.totalNative)}</span>
            <span>Creator fees</span><span>{preview.split.creatorPct}% to your agent wallet · {preview.split.platformPct}% to Claudia</span>
            <span>Network</span><span>{preview.network === "mainnet" ? <strong className="sell">mainnet, real SOL</strong> : "devnet (test SOL)"}</span>
            <span>Simulation</span><span>{!preview.simulation ? "not run" : preview.simulation.ok ? <span className="buy">passed</span> : <span className="sell">{preview.simulation.error || "failed"}</span>}</span>
          </div>
          {preview.warnings.map((w: string, i: number) => <div key={i} className="note warn small mt-8">{w}</div>)}
          <label className="row mt-16 small"><input type="checkbox" checked={agree} onChange={e => setAgree(e.target.checked)} /> I understand this spends real SOL and can't be undone.</label>
          {err && <p className="error mt-8">{err}</p>}
          <div className="row mt-16">
            <button className="btn ghost" onClick={() => setPreview(null)}>Cancel</button>
            <button className="btn primary grow" disabled={!agree || busy || !preview.liveTrading || preview.overCap || preview.simulation?.ok === false} onClick={() => run(async () => { const r = await api("/api/claudia/launch/confirm", { body: { previewId: preview.id, confirm: true } }); setDone(r); setPreview(null); reload(); })}>{busy ? "Launching…" : "Confirm launch"}</button>
          </div>
          {!preview.liveTrading && <p className="tiny muted mt-8">Live trading is off, so this dry run can't be sent.</p>}
        </Modal>
      )}
    </div>
  );
}
