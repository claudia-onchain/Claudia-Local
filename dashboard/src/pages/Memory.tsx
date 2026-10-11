// Memory: what your agent remembers, as Markdown files you can edit, plus memory waiting for your approval.
import { useEffect, useState } from "react";
import { api, ago, bus, errText } from "../lib";
import { PageHead, useAsync, useToast } from "../ui";

type Mem = { id: string; content: string; type: string; tags: string[]; ts: number; source?: string; file?: string };
type MemFile = { name: string; size: number; updatedAt: number; kind: string };
const TYPES = ["note", "fact", "preference", "task", "conversation"];

export default function Memory() {
  const [tab, setTab] = useState<"saved" | "files" | "waiting">("saved");
  const [waiting, setWaiting] = useState(0);
  const count = () => api<{ quarantined?: number }>("/api/memory?q=&type=").then(r => setWaiting(r.quarantined || 0)).catch(() => {});
  useEffect(() => { count(); bus.addEventListener("memory", count); return () => bus.removeEventListener("memory", count); }, []);
  return (
    <>
      <PageHead title="Memory" sub="Things your agent remembers between chats, kept as Markdown files on this computer. It saves what you ask it to, and looks here before it answers." />
      <div className="tabs">
        <button className={tab === "saved" ? "on" : ""} onClick={() => setTab("saved")}>Saved</button>
        <button className={tab === "files" ? "on" : ""} onClick={() => setTab("files")}>Files</button>
        <button className={tab === "waiting" ? "on" : ""} onClick={() => setTab("waiting")}>Waiting for you{waiting ? ` (${waiting})` : ""}</button>
      </div>
      {tab === "saved" && <Saved onChange={count} />}
      {tab === "files" && <Files />}
      {tab === "waiting" && <Waiting onChange={count} />}
    </>
  );
}

function Saved({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [type, setType] = useState("");
  const [list, setList] = useState<Mem[]>([]);
  const [total, setTotal] = useState(0);
  const [text, setText] = useState("");
  const [newType, setNewType] = useState("note");

  const load = () => api<{ memories: Mem[]; total: number }>(`/api/memory?q=${encodeURIComponent(q)}&type=${type}`).then(r => { setList(r.memories); setTotal(r.total); }).catch(e => toast(errText(e), "bad"));
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q, type]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { bus.addEventListener("memory", load); return () => bus.removeEventListener("memory", load); });

  const add = async () => {
    try { await api("/api/memory", { body: { content: text, type: newType } }); setText(""); toast("Saved to memory", "ok"); load(); onChange(); } catch (e) { toast(errText(e), "bad"); }
  };
  const del = async (id: string) => { await api(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {}); load(); };

  return (
    <div className="grid side-r">
      <div className="card">
        <div className="row wrap" style={{ marginBottom: 12 }}>
          <input className="input grow" style={{ minWidth: 180 }} placeholder="Search memories" value={q} onChange={e => setQ(e.target.value)} aria-label="Search memories" />
          <select className="select" style={{ width: 150 }} value={type} onChange={e => setType(e.target.value)} aria-label="Type">
            <option value="">All types</option>
            {TYPES.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        <div className="tiny muted" style={{ marginBottom: 6 }}>{q || type ? `${list.length} of ${total}` : `${total} saved`}</div>
        {!list.length && <div className="empty">{q ? "Nothing matches that." : "No memories yet. Ask your agent to remember something, or add one here."}</div>}
        <div className="list">
          {list.map(m => (
            <div key={m.id} className="item" style={{ alignItems: "flex-start" }}>
              <div className="grow">
                <div style={{ whiteSpace: "pre-wrap" }} className="break">{m.content}</div>
                <div className="row wrap tiny muted mt-4">
                  <span className="badge">{m.type}</span>
                  {m.source && m.source !== "user" && <span className="badge info">from {m.source}</span>}
                  {m.tags.map(t => <span key={t} className="badge">{t}</span>)}
                  <span>{ago(m.ts)}</span>
                  {m.file && <span className="mono">{m.file}</span>}
                </div>
              </div>
              <button className="btn ghost sm" onClick={() => del(m.id)}>Delete</button>
            </div>
          ))}
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Add a memory</h2></div>
        <div className="fields">
          <textarea className="textarea" placeholder="e.g. I only want to paper trade this month." value={text} onChange={e => setText(e.target.value)} aria-label="Memory text" />
          <select className="select" value={newType} onChange={e => setNewType(e.target.value)} aria-label="Memory type">
            {TYPES.filter(t => t !== "conversation").map(t => <option key={t} value={t}>{t}</option>)}
          </select>
          <div className="tiny muted">Facts go to MEMORY.md, preferences to USER.md, notes and tasks to today's note.</div>
          <button className="btn primary" disabled={!text.trim()} onClick={add}>Save</button>
        </div>
      </div>
    </div>
  );
}

function Files() {
  const toast = useToast();
  const files = useAsync(() => api<{ files: MemFile[]; today: string }>("/api/memory/files"));
  const [name, setName] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [orig, setOrig] = useState("");
  const open = async (n: string) => {
    if (name && content !== orig && !confirm("Discard your unsaved changes?")) return;
    try { const r = await api<{ content: string }>(`/api/memory/file?name=${encodeURIComponent(n)}`); setName(n); setContent(r.content); setOrig(r.content); } catch (e) { toast(errText(e), "bad"); }
  };
  useEffect(() => { if (!name && files.data) open(files.data.files[0]?.name || "MEMORY.md"); }, [files.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    if (!name) return;
    try { await api("/api/memory/file", { body: { name, content } }); setOrig(content); toast("Saved", "ok"); files.reload(); bus.dispatchEvent(new Event("memory")); } catch (e) { toast(errText(e), "bad"); }
  };
  const list = files.data?.files || [];
  const known = new Set(list.map(f => f.name));
  return (
    <div className="files">
      <div className="card">
        <div className="row" style={{ marginBottom: 8 }}>
          <span className="label grow">Files</span>
          {files.data && <button className="btn sm" onClick={() => open(files.data!.today)}>Today's note</button>}
        </div>
        <div className="list">
          {["MEMORY.md", "USER.md"].filter(n => !known.has(n)).map(n => (
            <button key={n} className="item linkbtn" style={{ textAlign: "left", color: "var(--text-2)" }} onClick={() => open(n)}>
              <span className="mono grow">{n}</span><span className="tiny muted">empty</span>
            </button>
          ))}
          {list.map(f => (
            <button key={f.name} className="item linkbtn" style={{ textAlign: "left", color: f.name === name ? "var(--brand)" : "var(--text)" }} onClick={() => open(f.name)}>
              <span className="mono grow trunc">{f.name}</span>
              <span className="tiny muted nowrap">{f.kind} · {ago(f.updatedAt)}</span>
            </button>
          ))}
        </div>
      </div>
      <div className="card">
        {name ? (
          <>
            <div className="row" style={{ marginBottom: 8 }}>
              <span className="mono grow">{name}</span>
              {content !== orig && <span className="tiny muted">Not saved</span>}
              <button className="btn primary sm" disabled={content === orig} onClick={save}>Save</button>
            </div>
            <textarea className="editor" spellCheck={false} value={content} onChange={e => setContent(e.target.value)} aria-label={name} />
            <div className="tiny muted mt-8">One memory per line, starting with "- ". The comment after a line keeps its id, type and source; you can leave it or delete it.</div>
          </>
        ) : <div className="empty">Pick a file.</div>}
      </div>
    </div>
  );
}

function Waiting({ onChange }: { onChange: () => void }) {
  const toast = useToast();
  const q = useAsync(() => api<{ items: Mem[] }>("/api/memory/quarantine"));
  useEffect(() => { bus.addEventListener("memory", q.reload); return () => bus.removeEventListener("memory", q.reload); });
  const act = async (id: string, approve: boolean) => {
    try {
      if (approve) await api(`/api/memory/quarantine/${encodeURIComponent(id)}/approve`, { method: "POST", body: {} });
      else await api(`/api/memory/quarantine/${encodeURIComponent(id)}`, { method: "DELETE" });
      toast(approve ? "Saved to memory" : "Discarded", "ok");
      q.reload(); onChange();
    } catch (e) { toast(errText(e), "bad"); }
  };
  const items = q.data?.items || [];
  return (
    <div className="card">
      <p className="small muted" style={{ marginBottom: 8 }}>Memory the agent proposed after reading outside content (the thread, MCP tools, skills). Nothing here is used until you approve it.</p>
      {q.error && <p className="error">{q.error}</p>}
      {q.data && !items.length && <div className="empty">Nothing waiting.</div>}
      <div className="list">
        {items.map(m => (
          <div key={m.id} className="item" style={{ alignItems: "flex-start" }}>
            <div className="grow">
              <div style={{ whiteSpace: "pre-wrap" }} className="break">{m.content}</div>
              <div className="row wrap tiny muted mt-4">
                <span className="badge">{m.type}</span>
                <span className="badge info">from {m.source || "outside"}</span>
                <span>{ago(m.ts)}</span>
              </div>
            </div>
            <div className="row">
              <button className="btn ghost sm" onClick={() => act(m.id, false)}>Discard</button>
              <button className="btn primary sm" onClick={() => act(m.id, true)}>Approve</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
