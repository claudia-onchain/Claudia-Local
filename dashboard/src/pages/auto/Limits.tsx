// Tasks → Heartbeat and limits: the optional check-in, daily budgets and the kill switch file.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errText } from "../../lib";
import { Field, Switch, useToast } from "../../ui";
import { fmtTime, type Autonomy, type Budgets } from "./auto";

const ROWS: { k: keyof Budgets; label: string; hint: string }[] = [
  { k: "runsPerDay", label: "Task runs a day", hint: "Tasks, watcher starts and heartbeat check-ins. 0 means no limit." },
  { k: "toolCallsPerDay", label: "Tool calls a day", hint: "Across every run. 0 means no limit." },
  { k: "postsPerDay", label: "Posts on its own a day", hint: "Only tasks you let post without asking. 0 means never." },
  { k: "tokensPerDay", label: "Model tokens a day", hint: "Prompt plus reply tokens for runs. 0 means no limit." },
];

const USED: Record<string, keyof Autonomy["used"]> = { runsPerDay: "runs", toolCallsPerDay: "toolCalls", postsPerDay: "posts", tokensPerDay: "tokens" };

export default function Limits({ a, reload }: { a: Autonomy; reload: () => void }) {
  const toast = useToast();
  const [b, setB] = useState<Record<string, string>>({});
  const [every, setEvery] = useState(String(a.heartbeat.everyMinutes));
  useEffect(() => { setB(Object.fromEntries(Object.entries(a.budgets).map(([k, v]) => [k, String(v)]))); setEvery(String(a.heartbeat.everyMinutes)); }, [a]);
  const save = async (patch: Record<string, unknown>, msg = "Saved") => { try { await api("/api/autonomy", { body: patch }); toast(msg, "ok"); reload(); } catch (e) { toast(errText(e), "bad"); } };
  const dirty = Object.entries(a.budgets).some(([k, v]) => String(v) !== b[k]);
  const pct = (used: number, cap: number) => (cap > 0 ? Math.min(100, (used / cap) * 100) : 0);
  return (
    <div className="grid side-r">
      <div className="col gap-16">
        <div className="card">
          <div className="card-head"><h2>Heartbeat</h2><p>A short check-in on its own, every so often.</p></div>
          <div className="list">
            <div className="item">
              <div className="grow"><div>Check in on its own</div><div className="small muted">The agent reads <Link to="/files?path=/HEARTBEAT.md">HEARTBEAT.md</Link> in your workspace (a checklist you edit) and reports in a few lines.</div></div>
              <Switch checked={a.heartbeat.enabled} onChange={v => save({ heartbeat: { enabled: v } }, v ? "Heartbeat on" : "Heartbeat off")} />
            </div>
            <div className="item">
              <div className="grow"><div>Send check-ins to Telegram</div><div className="small muted">When a Telegram account is paired (Settings → Channels).</div></div>
              <Switch checked={a.heartbeat.telegram} onChange={v => save({ heartbeat: { telegram: v } })} />
            </div>
          </div>
          <div className="row mt-12">
            <Field label="Every (minutes)"><div className="row"><input className="input" type="number" min={5} max={1440} style={{ maxWidth: 120 }} value={every} onChange={e => setEvery(e.target.value)} /><button className="btn" disabled={Number(every) === a.heartbeat.everyMinutes} onClick={() => save({ heartbeat: { everyMinutes: Number(every) } })}>Save</button></div></Field>
          </div>
          <div className="row mt-12">
            <span className="small muted grow">{a.heartbeat.lastRun ? `Last check-in ${fmtTime(a.heartbeat.lastRun)}` : "No check-in yet"}{a.heartbeat.enabled && a.heartbeat.nextRun ? ` · next ${fmtTime(a.heartbeat.nextRun)}` : ""}</span>
            <button className="btn sm" disabled={a.heartbeat.running || a.stopped} onClick={() => api("/api/autonomy/heartbeat", { body: {} }).then(() => { toast("Checking in", "ok"); reload(); }).catch(e => toast(errText(e), "bad"))}>Check in now</button>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Daily limits</h2><p>Enforced by the app, whatever the agent says. They reset at midnight.</p></div>
          <div className="fields two">
            {ROWS.map(r => (
              <Field key={r.k} label={r.label} hint={r.hint}><input className="input" type="number" min={0} value={b[r.k] ?? ""} onChange={e => setB(x => ({ ...x, [r.k]: e.target.value }))} /></Field>
            ))}
            {a.spendEstimate && <Field label="Model spend a day (USD, estimate)" hint="0 means no cap."><input className="input" type="number" min={0} step={0.5} value={b.usdPerDay ?? ""} onChange={e => setB(x => ({ ...x, usdPerDay: e.target.value }))} /></Field>}
          </div>
          <div className="row mt-16"><button className="btn primary" disabled={!dirty} onClick={() => save({ budgets: Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Number(v)])) }, "Limits saved")}>Save limits</button></div>
        </div>
      </div>
      <div className="col gap-16">
        <div className="card">
          <div className="card-head"><h2>Today</h2></div>
          <div className="col gap-12">
            {ROWS.map(r => {
              const cap = a.budgets[r.k];
              const u = a.used[USED[r.k]] ?? 0;
              return (
                <div key={r.k} className="col gap-4">
                  <div className="row small"><span className="soft">{r.label}</span><span className="right num">{u.toLocaleString()} <span className="muted">of {cap > 0 ? cap.toLocaleString() : r.k === "postsPerDay" ? "0" : "no limit"}</span></span></div>
                  <div className={`meter${pct(u, cap) >= 100 ? " bad" : pct(u, cap) >= 80 ? " warn" : ""}`}><span style={{ width: `${pct(u, cap)}%` }} /></div>
                </div>
              );
            })}
            {a.spendToday !== null && <div className="small soft">Model spend today: about ${a.spendToday.toFixed(2)}</div>}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Kill switch</h2></div>
          <p className="small soft">The Stop button on this page pauses every task, watcher and the heartbeat at once. So does a file named <span className="mono">STOP</span> in the data folder:</p>
          <pre className="code mt-8">{navigator.userAgent.includes("Windows") ? `type nul > "${a.stopFilePath}"` : `touch ${a.stopFilePath}`}</pre>
          <p className="tiny muted mt-8">Delete the file (or press Resume) to start again. Chat and Telegram keep working.</p>
        </div>
      </div>
    </div>
  );
}
