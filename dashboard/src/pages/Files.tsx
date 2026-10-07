import { useEffect, useState } from "react";
import { api, bus, errText } from "../lib";
import { Markdown } from "../md";
import { PageHead, useToast } from "../ui";

type Entry = { name: string; path: string; isDirectory: boolean; size: number; modified: number };
type Open = { path: string; content: string; size: number; binary: boolean };

const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

export default function Files() {
  const toast = useToast();
  const [dir, setDir] = useState("/");
  const [items, setItems] = useState<Entry[]>([]);
  const [open, setOpen] = useState<Open | null>(null);
  const [draft, setDraft] = useState("");
  const [preview, setPreview] = useState(false);
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<{ path: string; line: number; content: string }[] | null>(null);
  const [root, setRoot] = useState("");

  const load = (d = dir) => api<{ items: Entry[] }>(`/api/files?path=${encodeURIComponent(d)}`).then(r => setItems(r.items)).catch(e => { toast(errText(e), "bad"); setItems([]); });
  useEffect(() => { load(dir); }, [dir]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api("/api/config").then(c => setRoot(c.workspaceDir)).catch(() => {}); }, []);
  useEffect(() => { const f = () => load(); bus.addEventListener("files", f); return () => bus.removeEventListener("files", f); });

  const openFile = async (p: string) => {
    try { const f = await api<Open>(`/api/files?path=${encodeURIComponent(p)}`); setOpen(f); setDraft(f.content); setPreview(/\.md$/i.test(p)); } catch (e) { toast(errText(e), "bad"); }
  };
  const save = async () => {
    if (!open) return;
    try { await api("/api/files", { body: { path: open.path, content: draft } }); setOpen({ ...open, content: draft }); toast("Saved", "ok"); load(); } catch (e) { toast(errText(e), "bad"); }
  };
  const create = async (folder: boolean) => {
    const name = prompt(folder ? "Folder name" : "File name (e.g. notes.md)");
    if (!name) return;
    const p = (dir === "/" ? "" : dir) + "/" + name.replace(/^\/+/, "");
    try {
      if (folder) { await api("/api/files", { body: { path: p, type: "folder" } }); load(); }
      else { await api("/api/files", { body: { path: p, content: "" } }); await load(); openFile(p); }
    } catch (e) { toast(errText(e), "bad"); }
  };
  const del = async (p: string) => {
    if (!confirm(`Delete ${p}?`)) return;
    try { await api(`/api/files?path=${encodeURIComponent(p)}`, { method: "DELETE" }); if (open?.path === p) setOpen(null); load(); } catch (e) { toast(errText(e), "bad"); }
  };
  const runSearch = async () => {
    if (!search.trim()) { setHits(null); return; }
    try { setHits((await api(`/api/files?path=/&search=${encodeURIComponent(search)}`)).results); } catch (e) { toast(errText(e), "bad"); }
  };

  const parts = dir.split("/").filter(Boolean);
  const dirty = open && draft !== open.content;

  return (
    <>
      <PageHead title="Files" sub={<>Your agent's workspace. It can only see this folder, nothing else on your computer.{root && <> <span className="mono tiny break">{root}</span></>}</>} />
      <div className="files">
        <div className="card">
          <div className="crumbs" style={{ marginBottom: 10 }}>
            <button onClick={() => setDir("/")}>workspace</button>
            {parts.map((p, i) => <span key={i} className="row gap-4">/<button onClick={() => setDir("/" + parts.slice(0, i + 1).join("/"))}>{p}</button></span>)}
          </div>
          <div className="row" style={{ marginBottom: 10 }}>
            <button className="btn sm" onClick={() => create(false)}>New file</button>
            <button className="btn sm" onClick={() => create(true)}>New folder</button>
          </div>
          <div className="list">
            {dir !== "/" && <a className="item" href="#" onClick={e => { e.preventDefault(); setDir("/" + parts.slice(0, -1).join("/")); }}><span className="muted">..</span></a>}
            {items.map(i => (
              <div key={i.path} className="item" style={{ padding: "8px 4px" }}>
                <button className="linkbtn grow trunc" style={{ textAlign: "left", color: i.isDirectory ? "var(--text)" : "var(--text-2)" }} onClick={() => (i.isDirectory ? setDir(i.path) : openFile(i.path))}>
                  {i.name}{i.isDirectory ? "/" : ""}
                </button>
                {!i.isDirectory && <span className="tiny muted nowrap">{size(i.size)}</span>}
                <button className="btn ghost sm" onClick={() => del(i.path)} aria-label={`Delete ${i.name}`}>Delete</button>
              </div>
            ))}
            {!items.length && <div className="empty">This folder is empty.</div>}
          </div>
          <hr className="hr" />
          <div className="row">
            <input className="input" placeholder="Search in files" value={search} onChange={e => setSearch(e.target.value)} onKeyDown={e => e.key === "Enter" && runSearch()} aria-label="Search in files" />
            <button className="btn sm" onClick={runSearch}>Search</button>
          </div>
          {hits && (
            <div className="list mt-8">
              {!hits.length && <div className="tiny muted">No matches.</div>}
              {hits.slice(0, 30).map((h, i) => (
                <button key={i} className="item linkbtn" style={{ textAlign: "left", display: "block", padding: "6px 0" }} onClick={() => openFile(h.path)}>
                  <div className="mono tiny">{h.path}{h.line ? `:${h.line}` : ""}</div>
                  <div className="small soft trunc">{h.content}</div>
                </button>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          {!open && <div className="empty">Open a file to read or edit it.</div>}
          {open && (
            <>
              <div className="row wrap" style={{ marginBottom: 10 }}>
                <span className="mono small grow break">{open.path}</span>
                {/\.md$/i.test(open.path) && <div className="seg"><button className={!preview ? "on" : ""} onClick={() => setPreview(false)}>Edit</button><button className={preview ? "on" : ""} onClick={() => setPreview(true)}>Preview</button></div>}
                <button className="btn primary sm" disabled={!dirty || open.binary} onClick={save}>{dirty ? "Save" : "Saved"}</button>
              </div>
              {open.binary ? <div className="empty">This is a binary file ({size(open.size)}). It can't be edited here.</div>
                : preview ? <div style={{ minHeight: 300 }}><Markdown text={draft} /></div>
                : <textarea className="editor" spellCheck={false} value={draft} onChange={e => setDraft(e.target.value)} aria-label="File contents" />}
            </>
          )}
        </div>
      </div>
    </>
  );
}
