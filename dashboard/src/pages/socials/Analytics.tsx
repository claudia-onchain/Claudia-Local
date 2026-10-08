// Analytics: what went out, per network, with links. Counted from the posts on this computer.
import { api, ago, num } from "../../lib";
import { useAsync } from "../../ui";
import { STATUS_LABEL } from "../../studio";
import { useSocial } from "./ctx";

type A = { networks: { network: string; published: number; last7: number }[]; recent: { postId: string; network: string; account: string; url?: string; at: number; text: string }[]; counts: Record<string, number>; today: Record<string, number> };

export default function Analytics() {
  const s = useSocial();
  const a = useAsync(() => api<A>("/api/social/analytics"));
  const d = a.data;
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="stats">
          {Object.entries(d?.counts || {}).map(([k, v]) => <div key={k} className="stat"><span className="k">{STATUS_LABEL[k] || k}</span><span className="v">{num(v)}</span></div>)}
          {d && !Object.keys(d.counts).length && <span className="muted small">No posts yet.</span>}
        </div>
      </div>
      <div className="grid side-r">
        <div className="card">
          <div className="card-head"><h2 className="grow">Published</h2><button className="btn sm" onClick={a.reload}>Refresh</button></div>
          {!d?.recent.length && <div className="empty">Nothing published yet.</div>}
          <div className="list">
            {(d?.recent || []).map(r => (
              <div key={`${r.postId}-${r.account}`} className="item">
                <span className="badge">{s.netName(r.network)}</span>
                <span className="grow small trunc">{r.text}</span>
                <span className="tiny muted nowrap">{ago(r.at)}</span>
                {r.url && <a className="small" href={r.url} target="_blank" rel="noreferrer">Open</a>}
              </div>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Per network</h2></div>
          <table className="table">
            <thead><tr><th>Network</th><th className="r">Today</th><th className="r">7 days</th><th className="r">All</th></tr></thead>
            <tbody>
              {s.networks.filter(n => n.tier !== "skip" && n.tier !== "later").map(n => {
                const row = d?.networks.find(x => x.network === n.id);
                const cap = s.postCaps[n.id] || n.limits.perDay;
                return <tr key={n.id}><td>{n.name}</td><td className="r num">{d?.today[n.id] || 0}{cap ? <span className="muted">/{cap}</span> : ""}</td><td className="r num">{row?.last7 || 0}</td><td className="r num">{row?.published || 0}</td></tr>;
              })}
            </tbody>
          </table>
          <p className="tiny muted mt-8">Today shows your daily cap (or the network's own limit) after the slash.</p>
        </div>
      </div>
    </div>
  );
}
