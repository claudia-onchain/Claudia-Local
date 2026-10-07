import { useEffect, useState } from "react";
import { api, ago, bus, errText } from "../lib";
import { PageHead, useToast } from "../ui";

type Mem = { id: string; content: string; type: string; tags: string[]; ts: number };
const TYPES = ["note", "fact", "preference", "task", "conversation"];

export default function Memory() {
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
    try { await api("/api/memory", { body: { content: text, type: newType } }); setText(""); toast("Saved to memory", "ok"); load(); } catch (e) { toast(errText(e), "bad"); }
  };
  const del = async (id: string) => { await api(`/api/memory/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {}); load(); };

  return (
    <>
      <PageHead title="Memory" sub="Things your agent remembers between chats. It saves what you ask it to, and looks here before it answers. Stored only on this computer." />
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
                  <div className="row wrap tiny muted mt-4"><span className="badge">{m.type}</span>{m.tags.map(t => <span key={t} className="badge">{t}</span>)}<span>{ago(m.ts)}</span></div>
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
            <button className="btn primary" disabled={!text.trim()} onClick={add}>Save</button>
          </div>
        </div>
      </div>
    </>
  );
}
