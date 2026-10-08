// Campaigns: plan a set of posts and media (e.g. "Launch day for $XYZ"). Everything lands in Approvals first.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errText } from "../../lib";
import { Field, Switch, useToast } from "../../ui";
import { fmtDate, fromLocalInput, toLocalInput } from "../../studio";
import { useSocial } from "./ctx";

type Camp = { id: string; name: string; coin: string; goal: string; planner: string; startAt: number; createdAt: number; accounts: string[]; items: { at: number; text: string; postId: string | null; requestId: string | null }[]; problems: string[] };
type Tpl = { id: string; label: string; posts: number };

export default function Campaigns() {
  const s = useSocial();
  const toast = useToast();
  const [list, setList] = useState<Camp[]>([]);
  const [tpls, setTpls] = useState<Tpl[]>([]);
  const [f, setF] = useState({ name: "", coin: "", goal: "", notes: "", template: "launch", planner: "template" as "template" | "agent", startAt: toLocalInput(Date.now() + 26 * 3600_000), days: "2", withMedia: true });
  const [accounts, setAccounts] = useState<string[]>(s.accounts.map(a => a.id));
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Camp | null>(null);
  const load = () => api<{ campaigns: Camp[]; templates: Tpl[] }>("/api/campaigns").then(r => { setList(r.campaigns); setTpls(r.templates); }).catch(() => {});
  useEffect(() => { load(); }, []);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  const plan = async () => {
    setBusy(true);
    try {
      const c = await api<Camp>("/api/campaigns", { body: { ...f, accounts, days: Number(f.days), startAt: fromLocalInput(f.startAt) } });
      setMade(c); load(); toast("Planned. Everything is waiting in Approvals.", "ok");
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const remove = async (id: string) => { await api(`/api/campaigns/${id}`, { method: "DELETE" }).catch(() => {}); load(); };

  if (!s.accounts.length) return <div className="card"><div className="empty">Connect an account first: <Link to="/socials/connections">Connections</Link>.</div></div>;
  return (
    <div className="grid side-r">
      <div className="card">
        <div className="card-head"><h2>New campaign</h2><p>Claudia plans the posts and the pictures. Nothing publishes or gets made until you approve each piece.</p></div>
        <div className="fields">
          <div className="fields two">
            <Field label="Name"><input className="input" placeholder="Launch day for $XYZ" value={f.name} onChange={set("name")} /></Field>
            <Field label="Coin (optional)" hint="A ticker launched on Claudia."><input className="input mono" placeholder="$XYZ" value={f.coin} onChange={e => setF({ ...f, coin: e.target.value.toUpperCase() })} /></Field>
          </div>
          <Field label="What it's for"><input className="input" placeholder="Come say hi in the Claudia thread." value={f.goal} onChange={set("goal")} /></Field>
          <Field label="Who plans it">
            <div className="seg"><button className={f.planner === "template" ? "on" : ""} onClick={() => setF({ ...f, planner: "template" })}>Outline</button><button className={f.planner === "agent" ? "on" : ""} onClick={() => setF({ ...f, planner: "agent" })}>Claudia writes it</button></div>
          </Field>
          {f.planner === "template" ? (
            <Field label="Outline">
              <select className="select" value={f.template} onChange={set("template")}>{tpls.map(t => <option key={t.id} value={t.id}>{t.label} ({t.posts} posts)</option>)}</select>
            </Field>
          ) : (
            <Field label="Notes for Claudia" hint="Uses your chat model and the brand kit's tone guide.">
              <textarea className="textarea" value={f.notes} onChange={set("notes")} placeholder="Keep it playful. Mention the thread. One short video teaser." />
            </Field>
          )}
          <div className="fields two">
            <Field label={f.template === "launch" && f.planner === "template" ? "Launch time" : "Start"}><input className="input" type="datetime-local" value={f.startAt} min={toLocalInput(Date.now())} onChange={set("startAt")} /></Field>
            <Field label="Days"><input className="input num" type="number" min={1} max={14} value={f.days} onChange={set("days")} /></Field>
          </div>
          <Field label="Accounts">
            <div className="row wrap">
              {s.accounts.map(a => (
                <label key={a.id} className={`check${accounts.includes(a.id) ? " on" : ""}`}>
                  <input type="checkbox" checked={accounts.includes(a.id)} onChange={e => setAccounts(x => (e.target.checked ? [...x, a.id] : x.filter(y => y !== a.id)))} />
                  {s.netName(a.network)} <span className="muted">{a.handle}</span>
                </label>
              ))}
            </div>
          </Field>
          <Switch checked={f.withMedia} onChange={v => setF({ ...f, withMedia: v })} label="Plan pictures for some posts (each one waits for your OK and shows its cost)" />
          <div><button className="btn primary" disabled={busy || !accounts.length} onClick={plan}>{busy ? "Planning…" : "Plan it"}</button></div>
        </div>
        {made && (
          <div className="mt-16">
            <div className="note ok"><strong>{made.name}</strong>: {made.items.filter(i => i.postId).length} drafts and {made.items.filter(i => i.requestId).length} pictures are waiting in <Link to="/socials">Approvals</Link>.</div>
            {made.problems.map((p, i) => <div key={i} className="note warn small mt-8">{p}</div>)}
            <div className="list mt-12">{made.items.map((i, n) => <div key={n} className="item small"><span className="tiny muted nowrap num">{fmtDate(i.at)}</span><span className="grow">{i.text}</span>{i.requestId && <span className="badge">picture</span>}</div>)}</div>
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head"><h2>Campaigns</h2></div>
        {!list.length && <div className="empty">None yet.</div>}
        <div className="list">
          {list.map(c => (
            <div key={c.id} className="item" style={{ alignItems: "flex-start" }}>
              <div className="grow">
                <div>{c.name}</div>
                <div className="tiny muted">{c.items.length} posts · starts {fmtDate(c.startAt)} · {c.planner === "agent" ? "written by Claudia" : "from an outline"}</div>
              </div>
              <button className="btn ghost sm" onClick={() => remove(c.id)} title="Removes the plan; drafts stay in Approvals">Remove</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
