// Tasks: the agent works on its own on a schedule. Tabs: tasks, watchers, templates, heartbeat and limits.
// Everything runs only while Claudia Local is open and unlocked; posts and trades wait in Approvals.
import { useCallback, useEffect, useState } from "react";
import { Link, NavLink, Route, Routes } from "react-router-dom";
import { api, errText } from "../../lib";
import { Field, Modal, PageHead, Switch, useAsync, useToast } from "../../ui";
import { fmtTime, RUN_STATUS, runTone, useAutoEvents, type Run, type RunEntry, type Task, type TasksData } from "./auto";
import Watchers from "./Watchers";
import Templates from "./Templates";
import Limits from "./Limits";

export default function Tasks() {
  const toast = useToast();
  const [d, setD] = useState<TasksData | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => api<TasksData>("/api/tasks").then(x => { setD(x); setErr(""); }).catch(e => setErr(errText(e))), []);
  useEffect(() => { load(); }, [load]);
  useAutoEvents(e => { if (["task", "run", "run_started", "autonomy"].includes(e.topic)) load(); });
  const a = d?.autonomy;
  const stop = async (on: boolean) => {
    try { await api(on ? "/api/autonomy/stop" : "/api/autonomy/resume", { body: {} }); toast(on ? "Everything on its own is paused" : "Resumed", on ? "bad" : "ok"); load(); } catch (e) { toast(errText(e), "bad"); }
  };

  return (
    <>
      <PageHead title="Tasks" sub="Tasks run while Claudia Local is open and unlocked. Posts and trades wait for you in Approvals.">
        {a && !a.stopped && <button className="btn stop" onClick={() => stop(true)}>Stop everything</button>}
      </PageHead>
      {a?.stopped && (
        <div className="kill" role="alert">
          <div className="grow"><strong>Everything on its own is paused.</strong> <span className="soft small">No task, watcher or heartbeat starts{a.stopFile ? <>, because the file <span className="mono">{a.stopFilePath}</span> exists</> : ""}.</span></div>
          <button className="btn" onClick={() => stop(false)}>{a.stopFile ? "Remove the STOP file and resume" : "Resume"}</button>
        </div>
      )}
      <nav className="tabs">
        <NavLink to="/tasks" end>Tasks</NavLink>
        <NavLink to="/tasks/watchers">Watchers</NavLink>
        <NavLink to="/tasks/templates">Templates</NavLink>
        <NavLink to="/tasks/limits">Heartbeat and limits</NavLink>
      </nav>
      {err && <div className="note bad">{err}</div>}
      {d && (
        <Routes>
          <Route index element={<TaskList d={d} reload={load} />} />
          <Route path="watchers" element={<Watchers tasks={d.tasks} />} />
          <Route path="templates" element={<Templates onApplied={load} />} />
          <Route path="limits" element={<Limits a={d.autonomy} reload={load} />} />
        </Routes>
      )}
    </>
  );
}

function TaskList({ d, reload }: { d: TasksData; reload: () => void }) {
  const toast = useToast();
  const [edit, setEdit] = useState<Task | "new" | null>(null);
  const [history, setHistory] = useState<Task | null>(null);
  const act = async (fn: () => Promise<unknown>, ok: string) => { try { await fn(); toast(ok, "ok"); reload(); } catch (e) { toast(errText(e), "bad"); } };
  const u = d.autonomy.used, b = d.autonomy.budgets;
  return (
    <div className="col gap-16">
      {d.pending > 0 && <div className="note brand">{d.pending} item{d.pending === 1 ? " is" : "s are"} waiting for you. <Link to="/approvals">Open Approvals</Link></div>}
      <div className="card">
        <div className="card-head"><h2 className="grow">Your tasks</h2><button className="btn primary sm" onClick={() => setEdit("new")}>New task</button></div>
        {!d.tasks.length && <div className="empty">No tasks yet. Write one, or start from a <Link to="/tasks/templates">template</Link>.</div>}
        <div className="list">
          {d.tasks.map(t => (
            <div key={t.id} className="item stack" style={{ alignItems: "flex-start" }}>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="row wrap gap-4">
                  <strong className="trunc">{t.name}</strong>
                  {t.running ? <span className="badge info">Running</span> : t.enabled ? <span className="badge ok">On</span> : <span className="badge">Paused</span>}
                  {t.allowPost && <span className="badge copper">Posts without asking</span>}
                </div>
                <div className="small soft mt-4">{t.scheduleLabel}{t.enabled && t.nextRun ? ` · next ${fmtTime(t.nextRun)}` : ""}</div>
                {t.scheduleError && <div className="tiny error mt-4">{t.scheduleError}</div>}
                {t.lastRun && <div className="tiny muted mt-4 trunc">Last run {fmtTime(t.lastRun.at)}: <span className={`badge ${runTone(t.lastRun.status)}`}>{RUN_STATUS[t.lastRun.status] || t.lastRun.status}</span> {t.lastRun.summary}</div>}
              </div>
              <div className="row wrap gap-4" style={{ justifyContent: "flex-end" }}>
                <button className="btn sm" disabled={t.running} onClick={() => act(() => api(`/api/tasks/${t.id}/run`, { body: {} }), "Started")}>Run now</button>
                <button className="btn sm" onClick={() => act(() => api(`/api/tasks/${t.id}/pause`, { body: { paused: t.enabled } }), t.enabled ? "Paused" : "Switched on")}>{t.enabled ? "Pause" : "Switch on"}</button>
                <button className="btn ghost sm" onClick={() => setEdit(t)}>Edit</button>
                <button className="btn ghost sm" onClick={() => setHistory(t)}>History</button>
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="small muted">Today: {u.runs}{b.runsPerDay ? ` of ${b.runsPerDay}` : ""} runs, {u.toolCalls}{b.toolCallsPerDay ? ` of ${b.toolCallsPerDay}` : ""} tool calls, {u.posts} of {b.postsPerDay} posts on its own, {u.tokens.toLocaleString()} tokens. <Link to="/tasks/limits">Change the limits</Link></div>
      <RecentRuns />
      {edit && <TaskEditor task={edit === "new" ? null : edit} defaults={d.defaults.tools} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {history && <History task={history} onClose={() => setHistory(null)} />}
    </div>
  );
}

function RecentRuns() {
  const r = useAsync(() => api<{ runs: RunEntry[] }>("/api/tasks/runs?limit=15"));
  const [open, setOpen] = useState<string | null>(null);
  useAutoEvents(e => { if (e.topic === "run") r.reload(); });
  if (!r.data?.runs.length) return null;
  return (
    <div className="card">
      <div className="card-head"><h2>Recent runs</h2></div>
      <RunRows runs={r.data.runs} onOpen={setOpen} />
      {open && <RunLog id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function RunRows({ runs, onOpen }: { runs: RunEntry[]; onOpen: (id: string) => void }) {
  return (
    <div className="list">
      {runs.map(x => (
        <button key={x.id} className="item linkbtn" style={{ textAlign: "left", color: "var(--text)", width: "100%" }} onClick={() => onOpen(x.id)}>
          <span className={`badge ${runTone(x.status)}`}>{RUN_STATUS[x.status] || x.status}</span>
          <span className="grow small trunc"><strong>{x.name}</strong> · {x.summary}</span>
          {x.approvals > 0 && <span className="badge brand">{x.approvals} waiting</span>}
          <span className="tiny muted nowrap hide-phone">{fmtTime(x.startedAt)}</span>
        </button>
      ))}
    </div>
  );
}

function History({ task, onClose }: { task: Task; onClose: () => void }) {
  const r = useAsync(() => api<{ runs: RunEntry[] }>(`/api/tasks/runs?taskId=${task.id}&limit=50`), [task.id]);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Modal title={`History: ${task.name}`} onClose={onClose} wide>
      {r.data && !r.data.runs.length && <div className="empty">It hasn't run yet.</div>}
      {r.data && <RunRows runs={r.data.runs} onOpen={setOpen} />}
      {open && <RunLog id={open} onClose={() => setOpen(null)} />}
    </Modal>
  );
}

export function RunLog({ id, onClose }: { id: string; onClose: () => void }) {
  const r = useAsync(() => api<Run>(`/api/tasks/runs/${id}`), [id]);
  const x = r.data;
  return (
    <Modal title={x ? `${x.name}: ${RUN_STATUS[x.status] || x.status}` : "Run"} onClose={onClose} wide>
      {r.error && <div className="note bad">{r.error}</div>}
      {x && (
        <div className="col gap-12">
          <div className="kv">
            <span>Started</span><span>{fmtTime(x.startedAt)} ({x.trigger}{x.origin !== "user" ? `, from outside content: ${x.origin}` : ""})</span>
            <span>Took</span><span>{Math.max(1, Math.round((x.endedAt - x.startedAt) / 1000))} s · {x.toolCalls} tool calls · {(x.usage.prompt + x.usage.completion).toLocaleString()} tokens</span>
            {x.delivered.length > 0 && <><span>Sent to</span><span>{x.delivered.join(", ")}</span></>}
          </div>
          <div className="card tight flat"><div className="small" style={{ whiteSpace: "pre-wrap" }}>{x.summary}</div></div>
          {x.approvals.length > 0 && <div className="note brand small">{x.approvals.length} item{x.approvals.length === 1 ? "" : "s"} from this run wait in <Link to="/approvals" onClick={onClose}>Approvals</Link>.</div>}
          <details className="more">
            <summary>Step by step ({x.events.length})</summary>
            <div className="list mt-8">
              {x.events.map((e, i) => (
                <div key={i} className="item" style={{ alignItems: "flex-start" }}>
                  <span className="tiny muted nowrap num">{new Date(e.t).toLocaleTimeString()}</span>
                  <div className="grow small break">
                    {e.type === "tool" && <><span className="mono">{e.name}</span> <span className="muted mono tiny">{e.args}</span></>}
                    {e.type === "result" && <span className={e.error ? "error" : "soft"}>{e.text}</span>}
                    {e.type === "text" && <span style={{ whiteSpace: "pre-wrap" }}>{e.text}</span>}
                    {e.type === "approval" && <span>Waiting for you: {e.text}</span>}
                    {(e.type === "error" || e.type === "notice") && <span className={e.type === "error" ? "error" : "muted"}>{e.text}</span>}
                  </div>
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </Modal>
  );
}

type ToolRow = { name: string; group: string; label: string; enabled: boolean; locked: boolean };

export function TaskEditor({ task, defaults, onClose, onSaved }: { task: Task | null; defaults: string[]; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const tools = useAsync(() => api<{ tools: ToolRow[] }>("/api/tools"));
  const [f, setF] = useState({
    name: task?.name || "", prompt: task?.prompt || "", schedule: task?.schedule || "daily at 09:00", model: task?.model || "",
    tools: task?.tools || [], skills: (task?.skills || []).join(", "), maxRounds: String(task?.budget.maxRounds ?? 6), maxToolCalls: String(task?.budget.maxToolCalls ?? 12),
    telegram: !!task?.delivery.telegram, file: task?.delivery.file || "", allowPost: !!task?.allowPost, enabled: task ? task.enabled : false,
  });
  const [custom, setCustom] = useState(!!task?.tools.length);
  const [pv, setPv] = useState<{ ok: boolean; label?: string; next?: number[]; error?: string } | null>(null);
  const set = (p: Partial<typeof f>) => setF(x => ({ ...x, ...p }));
  useEffect(() => {
    const t = setTimeout(() => { api("/api/tasks/schedule", { body: { schedule: f.schedule } }).then(setPv).catch(() => setPv(null)); }, 300);
    return () => clearTimeout(t);
  }, [f.schedule]);
  const chosen = custom ? f.tools : defaults;
  const toggle = (n: string) => set({ tools: chosen.includes(n) ? chosen.filter(x => x !== n) : [...chosen, n] });
  const groups = new Map<string, ToolRow[]>();
  for (const t of tools.data?.tools || []) groups.set(t.group, [...(groups.get(t.group) || []), t]);

  const save = async () => {
    const body = {
      name: f.name, prompt: f.prompt, schedule: f.schedule, model: f.model, tools: custom ? f.tools : [], skills: f.skills.split(",").map(s => s.trim()).filter(Boolean),
      budget: { maxRounds: Number(f.maxRounds), maxToolCalls: Number(f.maxToolCalls) }, delivery: { telegram: f.telegram, file: f.file }, allowPost: f.allowPost, enabled: f.enabled,
    };
    try { await api(task ? `/api/tasks/${task.id}` : "/api/tasks", { body }); toast(task ? "Task saved" : "Task created", "ok"); onSaved(); } catch (e) { toast(errText(e), "bad"); }
  };
  const del = async () => { if (!task || !confirm(`Delete "${task.name}" and stop its watchers?`)) return; try { await api(`/api/tasks/${task.id}`, { method: "DELETE" }); toast("Deleted", "ok"); onSaved(); } catch (e) { toast(errText(e), "bad"); } };

  return (
    <Modal title={task ? "Edit task" : "New task"} onClose={onClose} wide>
      <div className="fields">
        <Field label="Name"><input className="input" value={f.name} onChange={e => set({ name: e.target.value })} placeholder="Morning market read" /></Field>
        <Field label="What to do" hint="Write it like a message to your agent. It gets this every run, plus your brand kit and memories.">
          <textarea className="textarea" style={{ minHeight: 110 }} value={f.prompt} onChange={e => set({ prompt: e.target.value })} placeholder="Read the Claudia overview and write a short market read: what moved, volume and red flags." />
        </Field>
        <Field label="When" hint={<>Local time. Examples: <span className="mono">every 30 minutes</span>, <span className="mono">daily at 09:00</span>, <span className="mono">weekdays at 08:30</span>, <span className="mono">mon at 18:00</span>, or cron <span className="mono">0 9 * * 1-5</span>.</>}>
          <input className="input mono" value={f.schedule} onChange={e => set({ schedule: e.target.value })} />
          {pv && (pv.ok ? <div className="small soft">{pv.label}. Next: {(pv.next || []).map(t => fmtTime(t)).join(" · ")}</div> : <div className="small error">{pv.error}</div>)}
        </Field>
        <div className="fields two">
          <Field label="Model rounds per run" hint="1 to 20"><input className="input" type="number" min={1} max={20} value={f.maxRounds} onChange={e => set({ maxRounds: e.target.value })} /></Field>
          <Field label="Tool calls per run" hint="0 to 60"><input className="input" type="number" min={0} max={60} value={f.maxToolCalls} onChange={e => set({ maxToolCalls: e.target.value })} /></Field>
        </div>
        <Field label="Send the result to" hint="It's always in the run history here.">
          <div className="col gap-8">
            <Switch checked={f.telegram} onChange={v => set({ telegram: v })} label="Telegram (when paired, Settings → Channels)" />
            <input className="input mono" value={f.file} onChange={e => set({ file: e.target.value })} placeholder="Workspace file, e.g. /reports/{date}.md (optional)" />
          </div>
        </Field>
        <Field label="Tools">
          <div className="col gap-8">
            <div className="seg"><button className={!custom ? "on" : ""} onClick={() => setCustom(false)}>The usual set</button><button className={custom ? "on" : ""} onClick={() => { setCustom(true); if (!f.tools.length) set({ tools: defaults }); }}>Pick</button></div>
            {!custom && <div className="tiny muted">Reading Claudia, files, memory search, paper trading and drafts that wait for you.</div>}
            {custom && [...groups].map(([g, list]) => (
              <div key={g}>
                <div className="tiny muted">{g}</div>
                <div className="row wrap gap-4 mt-4">
                  {list.map(t => <label key={t.name} className={`check${chosen.includes(t.name) ? " on" : ""}`} title={t.enabled ? "" : "Switched off in Skills"}><input type="checkbox" checked={chosen.includes(t.name)} onChange={() => toggle(t.name)} />{t.label}{!t.enabled && " (off)"}</label>)}
                </div>
              </div>
            ))}
          </div>
        </Field>
        <details className="more">
          <summary>More</summary>
          <div className="fields mt-8">
            <Field label="Model" hint="Empty uses the tasks model from Settings, or the chat model."><input className="input mono" value={f.model} onChange={e => set({ model: e.target.value })} placeholder="provider/model" /></Field>
            <Field label="Skills" hint="Library skills this task should read, comma-separated slugs."><input className="input mono" value={f.skills} onChange={e => set({ skills: e.target.value })} placeholder="coin-research, rug-check" /></Field>
            <div className="item">
              <Switch checked={f.allowPost} onChange={v => set({ allowPost: v })} label="Let this task post without asking" />
              <div className="tiny muted mt-4">Thread posts and social drafts from this task go out on their own, inside the daily post limit, the kill switch and your banned phrases. Runs started by outside content (a watcher on the thread or inbox) still ask. Trades always ask.</div>
            </div>
          </div>
        </details>
        <Switch checked={f.enabled} onChange={v => set({ enabled: v })} label="On (runs on its schedule)" />
      </div>
      <div className="row mt-16">
        {task && <button className="btn danger" onClick={del}>Delete</button>}
        <button className="btn ghost right" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!f.name.trim() || !f.prompt.trim() || pv?.ok === false} onClick={save}>{task ? "Save" : "Create"}</button>
      </div>
    </Modal>
  );
}
