import { useState } from "react";
import { api, ago, num } from "../lib";
import { PageHead, useAsync } from "../ui";

type Analytics = { days: { date: string; calls: number; tokens: number }[]; totals: { calls: number; prompt: number; completion: number }; models: { model: string; calls: number }[] };
type Act = { id: string; type: string; text: string; ts: number };

export default function Activity() {
  const an = useAsync(() => api<Analytics>("/api/analytics"));
  const act = useAsync(() => api<{ activity: Act[] }>("/api/activity?limit=150"));
  const [metric, setMetric] = useState<"calls" | "tokens">("calls");
  const [asTable, setAsTable] = useState(false);
  const [filter, setFilter] = useState("");
  const days = an.data?.days || [];
  const max = Math.max(1, ...days.map(d => d[metric]));
  const t = an.data?.totals;
  const types = [...new Set((act.data?.activity || []).map(a => a.type))];
  const rows = (act.data?.activity || []).filter(a => !filter || a.type === filter);

  return (
    <>
      <PageHead title="Activity" sub="What your agent did and how much it used the model. Counted on this computer only." />
      <div className="col gap-16">
        <div className="card">
          <div className="stats">
            <div className="stat"><span className="k">Model calls</span><span className="v">{num(t?.calls ?? 0)}</span></div>
            <div className="stat"><span className="k">Tokens in</span><span className="v">{num(t?.prompt ?? 0)}</span></div>
            <div className="stat"><span className="k">Tokens out</span><span className="v">{num(t?.completion ?? 0)}</span></div>
            <div className="stat"><span className="k">Models used</span><span className="v">{an.data?.models.length ?? 0}</span></div>
          </div>
        </div>
        <div className="grid side-r">
          <div className="card">
            <div className="card-head">
              <h2 className="grow">{metric === "calls" ? "Model calls" : "Tokens"} per day, last 14 days</h2>
              <div className="seg"><button className={metric === "calls" ? "on" : ""} onClick={() => setMetric("calls")}>Calls</button><button className={metric === "tokens" ? "on" : ""} onClick={() => setMetric("tokens")}>Tokens</button></div>
              <button className="btn ghost sm" onClick={() => setAsTable(v => !v)}>{asTable ? "Chart" : "Table"}</button>
            </div>
            {asTable ? (
              <table className="table"><thead><tr><th>Day</th><th className="r">Calls</th><th className="r">Tokens</th></tr></thead>
                <tbody>{[...days].reverse().map(d => <tr key={d.date}><td className="num">{d.date}</td><td className="r num">{d.calls}</td><td className="r num">{num(d.tokens)}</td></tr>)}</tbody></table>
            ) : (
              <div className="bars" role="img" aria-label={`${metric} per day`}>
                {days.map(d => (
                  <div key={d.date} className="b" title={`${d.date}: ${num(d[metric])} ${metric}`}>
                    <div className={`fill${d[metric] ? "" : " zero"}`} style={{ height: `${(d[metric] / max) * 100}%` }} />
                    <span className="d">{d.date.slice(8)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div className="card">
            <div className="card-head"><h2>By model</h2></div>
            {!an.data?.models.length && <p className="muted small">No model calls yet.</p>}
            <table className="table"><tbody>{(an.data?.models || []).map(m => <tr key={m.model}><td className="mono small break">{m.model}</td><td className="r num">{m.calls}</td></tr>)}</tbody></table>
          </div>
        </div>
        <div className="card">
          <div className="card-head">
            <h2 className="grow">Recent activity</h2>
            <select className="select" style={{ width: 150 }} value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter">
              <option value="">Everything</option>
              {types.map(x => <option key={x} value={x}>{x}</option>)}
            </select>
            <button className="btn sm" onClick={() => { act.reload(); an.reload(); }}>Refresh</button>
          </div>
          {!rows.length && <div className="empty">Nothing yet.</div>}
          <div className="list">
            {rows.map(a => (
              <div key={a.id} className="item">
                <span className="badge" style={{ minWidth: 64, justifyContent: "center" }}>{a.type}</span>
                <span className="grow small break">{a.text}</span>
                <span className="tiny muted nowrap">{ago(a.ts)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </>
  );
}
