// Tasks → Watchers: simple conditions that start a task (price or volume move, thread posts, the social inbox).
import { useState } from "react";
import { api, errText } from "../../lib";
import { Field, Modal, Switch, useAsync, useToast } from "../../ui";
import { fmtTime, type Task, type Watcher } from "./auto";

const TYPE: Record<Watcher["type"], string> = { price: "Price move", volume: "Volume change", thread: "New in the Claudia thread", inbox: "New in the social inbox" };

export default function Watchers({ tasks }: { tasks: Task[] }) {
  const toast = useToast();
  const r = useAsync(() => api<{ watchers: Watcher[] }>("/api/watchers"));
  const [edit, setEdit] = useState<Watcher | "new" | null>(null);
  const name = (id: string | null) => tasks.find(t => t.id === id)?.name || "no task";
  const toggle = async (w: Watcher) => { try { await api(`/api/watchers/${w.id}`, { body: { enabled: !w.enabled } }); r.reload(); } catch (e) { toast(errText(e), "bad"); } };
  return (
    <div className="col gap-16">
      <div className="card">
        <div className="card-head"><h2 className="grow">Watchers</h2><button className="btn primary sm" disabled={!tasks.length} onClick={() => setEdit("new")}>New watcher</button></div>
        <p className="small muted">A watcher checks something every few minutes and starts a task when it changes. What other people wrote reaches the task as outside content, so that run can't post or trade without you.</p>
        {!tasks.length && <div className="empty">Create a task first; a watcher starts one.</div>}
        {r.data && !r.data.watchers.length && tasks.length > 0 && <div className="empty">No watchers yet.</div>}
        <div className="list mt-8">
          {r.data?.watchers.map(w => (
            <div key={w.id} className="item" style={{ alignItems: "flex-start" }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap gap-4"><strong className="trunc">{w.name}</strong><span className="badge">{TYPE[w.type]}</span></div>
                <div className="small soft mt-4">
                  {w.type === "price" || w.type === "volume" ? `${w.token} moves ${w.thresholdPct}% or more` : w.type === "thread" ? `#${w.room}` : "Mentions, replies and DMs"} → starts “{name(w.taskId)}”. Checks every {w.everyMinutes} min, then waits {w.cooldownMinutes} min.
                </div>
                <div className="tiny muted mt-4">{w.lastCheck ? `Checked ${fmtTime(w.lastCheck)}` : "Not checked yet"}{w.lastFired ? ` · last fired ${fmtTime(w.lastFired)}` : ""}</div>
                {w.lastError && <div className="tiny error mt-4">{w.lastError}</div>}
              </div>
              <Switch checked={w.enabled} onChange={() => toggle(w)} />
              <button className="btn ghost sm" onClick={() => setEdit(w)}>Edit</button>
            </div>
          ))}
        </div>
      </div>
      {edit && <WatcherEditor w={edit === "new" ? null : edit} tasks={tasks} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); r.reload(); }} />}
    </div>
  );
}

function WatcherEditor({ w, tasks, onClose, onSaved }: { w: Watcher | null; tasks: Task[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [f, setF] = useState({ name: w?.name || "", type: w?.type || "price", token: w?.token || "$CLAUDIA", room: w?.room || "general", thresholdPct: String(w?.thresholdPct ?? 10), everyMinutes: String(w?.everyMinutes ?? 10), cooldownMinutes: String(w?.cooldownMinutes ?? 60), taskId: w?.taskId || tasks[0]?.id || "" });
  const set = (p: Partial<typeof f>) => setF(x => ({ ...x, ...p }));
  const coin = f.type === "price" || f.type === "volume";
  const save = async () => {
    const body = { name: f.name, type: f.type, taskId: f.taskId, everyMinutes: Number(f.everyMinutes), cooldownMinutes: Number(f.cooldownMinutes), ...(coin ? { token: f.token, thresholdPct: Number(f.thresholdPct) } : {}), ...(f.type === "thread" ? { room: f.room } : {}) };
    try { await api(w ? `/api/watchers/${w.id}` : "/api/watchers", { body }); toast("Watcher saved", "ok"); onSaved(); } catch (e) { toast(errText(e), "bad"); }
  };
  const del = async () => { if (!w) return; try { await api(`/api/watchers/${w.id}`, { method: "DELETE" }); onSaved(); } catch (e) { toast(errText(e), "bad"); } };
  return (
    <Modal title={w ? "Edit watcher" : "New watcher"} onClose={onClose}>
      <div className="fields">
        <Field label="Watch for">
          <select className="select" value={f.type} onChange={e => set({ type: e.target.value as Watcher["type"] })}>{Object.entries(TYPE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </Field>
        {coin && (
          <div className="fields two">
            <Field label="Coin" hint="$CLAUDIA or a mint launched on Claudia"><input className="input mono" value={f.token} onChange={e => set({ token: e.target.value })} /></Field>
            <Field label="Change (%)"><input className="input" type="number" min={1} max={1000} value={f.thresholdPct} onChange={e => set({ thresholdPct: e.target.value })} /></Field>
          </div>
        )}
        {f.type === "thread" && <Field label="Room"><input className="input mono" value={f.room} onChange={e => set({ room: e.target.value })} /></Field>}
        <Field label="Start this task">
          <select className="select" value={f.taskId} onChange={e => set({ taskId: e.target.value })}>{tasks.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
        </Field>
        <div className="fields two">
          <Field label="Check every (min)" hint={coin ? "5 at least" : "2 at least"}><input className="input" type="number" min={2} max={1440} value={f.everyMinutes} onChange={e => set({ everyMinutes: e.target.value })} /></Field>
          <Field label="Then wait (min)" hint="Before it can fire again"><input className="input" type="number" min={5} max={1440} value={f.cooldownMinutes} onChange={e => set({ cooldownMinutes: e.target.value })} /></Field>
        </div>
        <Field label="Name (optional)"><input className="input" value={f.name} onChange={e => set({ name: e.target.value })} placeholder={TYPE[f.type as Watcher["type"]]} /></Field>
      </div>
      <div className="row mt-16">
        {w && <button className="btn danger" onClick={del}>Delete</button>}
        <button className="btn ghost right" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!f.taskId} onClick={save}>Save</button>
      </div>
    </Modal>
  );
}
