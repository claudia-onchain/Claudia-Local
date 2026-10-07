import { useEffect, useState } from "react";
import { agent, useAgent } from "../agent";
import { api, ago, bus, errText } from "../lib";
import { Markdown } from "../md";
import { PageHead, useAsync, useToast } from "../ui";

type Helper = { role: string; label: string; about: string; tools: string[]; model: string; modelLabel: string };

export default function Helpers() {
  const { data, reload } = useAsync(() => api<{ helpers: Helper[] }>("/api/helpers"));
  const a = useAgent();
  const toast = useToast();
  const [role, setRole] = useState("research");
  const [task, setTask] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<{ role: string; summary: string } | null>(null);

  useEffect(() => {
    const on = (e: Event) => { const d = (e as CustomEvent).detail; setRunning(false); setResult({ role: d.role, summary: d.result?.summary || "" }); };
    bus.addEventListener("helper_result", on);
    return () => bus.removeEventListener("helper_result", on);
  }, []);

  const run = () => {
    if (!task.trim()) return;
    setResult(null);
    if (agent.runHelper(role, task.trim())) setRunning(true);
    else toast("Not connected to the app yet. Try again in a moment.", "bad");
  };
  const saveModel = async (r: string, model: string) => {
    try { await api("/api/config", { body: { roleModels: { [r]: model } } }); toast("Saved"); reload(); } catch (e) { toast(errText(e), "bad"); }
  };

  return (
    <>
      <PageHead title="Helpers" sub="Specialist agents your main agent can hand work to. Each one only gets the tools it needs. You can also ask one directly." />
      <div className="grid side-r">
        <div className="col gap-12">
          {(data?.helpers || []).map(h => <HelperCard key={h.role} h={h} onSave={m => saveModel(h.role, m)} onPick={() => setRole(h.role)} />)}
        </div>
        <div className="col gap-16">
          <div className="card">
            <div className="card-head"><h2>Ask a helper</h2></div>
            <div className="fields">
              <select className="select" value={role} onChange={e => setRole(e.target.value)} aria-label="Helper">
                {(data?.helpers || []).map(h => <option key={h.role} value={h.role}>{h.label}</option>)}
              </select>
              <textarea className="textarea" placeholder="What should it look into?" value={task} onChange={e => setTask(e.target.value)} />
              <button className="btn primary" disabled={!task.trim() || running} onClick={run}>{running ? "Working…" : "Ask"}</button>
            </div>
            {result && <div className="mt-16"><div className="label">What the {result.role} helper found</div><div className="mt-8"><Markdown text={result.summary} /></div></div>}
          </div>
          <div className="card">
            <div className="card-head"><h2>Recent helper work</h2></div>
            {!a.helpers.length && <p className="muted small">Nothing yet in this session.</p>}
            <div className="list">
              {a.helpers.slice(0, 12).map(h => (
                <div key={h.id} className="item" style={{ alignItems: "flex-start" }}>
                  <span className={`dot ${h.status === "done" ? "ok" : h.status === "failed" ? "bad" : "warn"}`} style={{ marginTop: 7 }} />
                  <div className="grow">
                    <div className="small"><strong style={{ textTransform: "capitalize" }}>{h.role}</strong> <span className="muted">· {ago(h.ts)}</span></div>
                    <div className="small soft trunc">{h.task}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function HelperCard({ h, onSave, onPick }: { h: Helper; onSave: (m: string) => void; onPick: () => void }) {
  const [model, setModel] = useState(h.model);
  useEffect(() => setModel(h.model), [h.model]);
  return (
    <div className="card">
      <div className="row top">
        <div className="grow">
          <h2>{h.label}</h2>
          <p className="soft small mt-4">{h.about}</p>
        </div>
        <button className="btn sm" onClick={onPick}>Ask</button>
      </div>
      <div className="row wrap mt-12 gap-4">{h.tools.map(t => <span key={t} className="badge mono">{t}</span>)}</div>
      <div className="row mt-12">
        <input className="input mono" style={{ maxWidth: 360 }} placeholder="Same model as chat" value={model} onChange={e => setModel(e.target.value)} aria-label={`${h.label} model`} />
        <button className="btn sm" disabled={model === h.model} onClick={() => onSave(model.trim())}>Save model</button>
      </div>
    </div>
  );
}
