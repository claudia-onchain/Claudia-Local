import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Link } from "react-router-dom";
import { agent, useAgent, type Item } from "../agent";
import { api, bus } from "../lib";
import { Markdown } from "../md";
import { Face } from "../ui";

type ChatRow = { id: string; title: string; updatedAt: number; count: number };

const TOOL_LABEL: Record<string, string> = {
  read_file: "Read a file", write_file: "Wrote a file", list_dir: "Listed a folder", search_files: "Searched files",
  memory_save: "Saved to memory", memory_search: "Searched memory",
  claudia_overview: "Checked Claudia", claudia_coins: "Looked up coins", claudia_coin: "Read a coin page", claudia_thread: "Read the thread",
  claudia_agent: "Looked up an agent", claudia_my_agent: "Checked your agent", claudia_post: "Post in the thread",
  paper_trade: "Paper trade", paper_portfolio: "Checked the paper account", claudia_quote: "Got a quote", trading_limits: "Checked your limits",
  wallet_info: "Checked the wallet", propose_trade: "Suggested a trade", delegate: "Asked a helper", ask_user: "Asked you",
  generate_media: "Asked for media", get_media_job: "Checked a media job", list_media: "Looked at the library",
  draft_post: "Drafted a post", preview_post: "Previewed a post", list_posts: "Looked at posts", inbox: "Read the inbox",
};
const argHint = (a: any) => (!a ? "" : a.path || a.query || a.pattern || a.token || a.room || a.role || a.slug || "");

const newId = () => "c_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const SUGGEST = [
  "What's new with $CLAUDIA today?",
  "Sum up the Claudia thread for me",
  "Make a notes file for today with three goals",
  "Ask the security helper to look at $CLAUDIA",
];

export default function Chat() {
  const a = useAgent();
  const [sid, setSid] = useState(() => { try { return localStorage.getItem("cl.chat") || newId(); } catch { return newId(); } });
  const [chats, setChats] = useState<ChatRow[]>([]);
  const [model, setModel] = useState("");
  const [text, setText] = useState("");
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const streamRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const s = a.sessions[sid];
  const items = s?.items || [];
  const busy = !!s?.busy;

  const loadChats = () => api<{ sessions: ChatRow[] }>("/api/sessions").then(r => setChats(r.sessions)).catch(() => {});
  useEffect(() => {
    loadChats();
    api("/api/config").then(c => setModel(c.modelLabel)).catch(() => {});
    bus.addEventListener("chats", loadChats);
    return () => bus.removeEventListener("chats", loadChats);
  }, []);
  useEffect(() => { try { localStorage.setItem("cl.chat", sid); } catch { /* */ } }, [sid]);
  // Load a saved chat once the socket is open.
  useEffect(() => { if (a.conn === "open" && !a.sessions[sid]) agent.load(sid); }, [a.conn, sid]); // eslint-disable-line react-hooks/exhaustive-deps
  // Follow the conversation while you're at the bottom; stop following when you scroll up to read.
  const stick = useRef(true);
  useEffect(() => {
    const el = streamRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);
  useEffect(() => { stick.current = true; const el = streamRef.current; if (el) el.scrollTop = el.scrollHeight; }, [sid]);

  const sendNow = (t = text) => {
    const body = t.trim();
    if (!body && !files.length) return;
    stick.current = true;
    agent.send(sid, body || "(see the attached file)", { attachments: files });
    setText(""); setFiles([]);
    setTimeout(() => { if (taRef.current) taRef.current.style.height = "auto"; }, 0);
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); sendNow(); }
  };
  const attach = async (list: FileList | null) => {
    const out: { name: string; text: string }[] = [];
    for (const f of Array.from(list || []).slice(0, 5)) {
      if (f.size > 500_000) continue;
      out.push({ name: f.name, text: await f.text() });
    }
    setFiles(x => [...x, ...out].slice(0, 5));
  };
  const remove = async (id: string) => {
    await api(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
    agent.forget(id);
    if (id === sid) setSid(newId());
    loadChats();
  };
  const current = useMemo(() => chats.find(c => c.id === sid), [chats, sid]);

  return (
    <div className="chat">
      <aside className="chat-list">
        <div className="head">
          <span className="label grow">Chats</span>
          <button className="btn sm" onClick={() => setSid(newId())}>New chat</button>
        </div>
        <div className="items">
          {!current && <div className="it on">New chat</div>}
          {chats.map(c => (
            <div key={c.id} className={`it${c.id === sid ? " on" : ""}`} onClick={() => setSid(c.id)} title={c.title}>
              <span className="trunc grow">{c.title}</span>
              <button className="btn ghost sm x" onClick={e => { e.stopPropagation(); remove(c.id); }} aria-label="Delete chat">Delete</button>
            </div>
          ))}
        </div>
      </aside>
      <section className="convo">
        <div className="convo-head">
          <div className="grow trunc hide-phone">
            <div className="trunc" style={{ fontWeight: 500 }}>{current?.title || "New chat"}</div>
            <div className="tiny muted trunc">{model}{a.conn !== "open" ? " · reconnecting…" : ""}</div>
          </div>
          <select className="select only-phone grow" style={{ minWidth: 0 }} value={current ? sid : ""} onChange={e => setSid(e.target.value || newId())} aria-label="Pick a chat">
            <option value="">New chat</option>
            {chats.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          <button className="btn sm only-phone" onClick={() => setSid(newId())}>New</button>
        </div>
        <div className="stream" ref={streamRef} onScroll={e => { const el = e.currentTarget; stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
          <div className="inner">
            {!items.length && (
              <div className="col" style={{ alignItems: "center", textAlign: "center", padding: "8vh 0 0", gap: 14 }}>
                <Face size={72} />
                <h2 className="serif" style={{ fontSize: 30 }}>What should we work on?</h2>
                <p className="muted small" style={{ maxWidth: 440 }}>Your agent can keep notes and memories, work in your files, read Claudia, paper trade, and bring in helpers. It runs on this computer.</p>
                <div className="suggest mt-8">{SUGGEST.map(q => <button key={q} onClick={() => sendNow(q)}>{q}</button>)}</div>
              </div>
            )}
            {items.map(it => <Row key={it.id} it={it} sid={sid} />)}
            {busy && !items.some(i => i.kind === "assistant" && i.streaming) && <div className="msg-notice">{s?.queued ? "Waiting for the current reply…" : "Working…"}</div>}
          </div>
        </div>
        <div className="composer">
          {files.length > 0 && (
            <div className="row wrap" style={{ maxWidth: 760, margin: "0 auto 8px" }}>
              {files.map((f, i) => <span key={i} className="badge">{f.name} <button className="linkbtn tiny" onClick={() => setFiles(x => x.filter((_, j) => j !== i))}>remove</button></span>)}
            </div>
          )}
          <div className="box">
            <textarea
              ref={taRef} rows={1} value={text} placeholder="Message your agent" aria-label="Message"
              onChange={e => { setText(e.target.value); e.target.style.height = "auto"; e.target.style.height = Math.min(220, e.target.scrollHeight) + "px"; }}
              onKeyDown={onKey}
            />
            <label className="btn ghost sm" title="Attach a text file">
              Attach<input type="file" hidden multiple accept=".txt,.md,.csv,.json,.log,.ts,.js,.py,text/*" onChange={e => { attach(e.target.files); e.target.value = ""; }} />
            </label>
            {busy ? <button className="btn sm" onClick={() => agent.stop(sid)}>Stop</button> : <button className="btn primary sm" disabled={!text.trim() && !files.length} onClick={() => sendNow()}>Send</button>}
          </div>
        </div>
      </section>
    </div>
  );
}

function Row({ it, sid }: { it: Item; sid: string }) {
  switch (it.kind) {
    case "user": return <div className="msg-user">{it.text}</div>;
    case "assistant":
      return (
        <div className="msg-ai">
          <Face size={28} />
          <div className={`body${it.streaming ? " caret" : ""}`}><Markdown text={it.text} /></div>
        </div>
      );
    case "tool":
      return (
        <details className="tool">
          <summary>
            <span className={`dot ${it.state === "running" ? "warn" : it.state === "error" ? "bad" : "ok"}`} />
            <span>{TOOL_LABEL[it.name] || it.name}</span>
            {argHint(it.args) && <span className="mono trunc muted">{String(argHint(it.args)).slice(0, 80)}</span>}
            <span className="right muted tiny">{it.state === "running" ? "working" : it.state === "error" ? "failed" : "details"}</span>
          </summary>
          {it.result !== undefined && <pre>{it.result}</pre>}
        </details>
      );
    case "helper":
      return (
        <div className="helper">
          <div className="row">
            <strong>{it.role.charAt(0).toUpperCase() + it.role.slice(1)} helper</strong>
            <span className={`badge ${it.status === "done" ? "ok" : it.status === "failed" ? "bad" : "info"}`}>{it.status === "working" ? "working" : it.status}</span>
            {it.steps.length > 0 && <span className="tiny muted trunc">used {it.steps.join(", ")}</span>}
          </div>
          <div className="small soft mt-4">{it.task}</div>
          {it.summary && <details className="mt-4"><summary className="small brand" style={{ cursor: "pointer" }}>What it found</summary><div className="mt-4 small"><Markdown text={it.summary} /></div></details>}
        </div>
      );
    case "approval": return <Approval it={it} sid={sid} />;
    case "error": return <div className="msg-error">{it.text}{/OpenRouter key|Settings/.test(it.text) && <> <Link to="/settings">Open Settings</Link></>}</div>;
    case "notice": return <div className="msg-notice">{it.text}</div>;
  }
}

function Approval({ it, sid }: { it: Extract<Item, { kind: "approval" }>; sid: string }) {
  const [custom, setCustom] = useState("");
  if (it.answered) {
    return <div className="approval" style={{ opacity: 0.75 }}><div className="small muted">{it.question}</div><div className="small mt-4">Your answer: <strong>{it.answered}</strong></div></div>;
  }
  return (
    <div className="approval" role="group" aria-label="Your agent is asking">
      <div className="tiny muted">Your agent is asking</div>
      <div style={{ fontWeight: 500 }} className="mt-4">{it.question}</div>
      {it.post && <blockquote>{it.post.content}</blockquote>}
      {it.post && <div className="tiny muted">This goes public in #{it.post.room} on Claudia, under your agent's name.</div>}
      <div className="row wrap mt-12">
        {it.options.map((o, i) => (
          <button key={o.label} className={`btn sm${i === 0 ? " primary" : ""}`} onClick={() => agent.answer(sid, it.id, [o.label])}>{o.label}</button>
        ))}
      </div>
      <div className="row mt-8">
        <input className="input" placeholder="Or type an answer" value={custom} onChange={e => setCustom(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && custom.trim()) agent.answer(sid, it.id, [], custom.trim()); }} />
        <button className="btn sm" disabled={!custom.trim()} onClick={() => agent.answer(sid, it.id, [], custom.trim())}>Answer</button>
      </div>
    </div>
  );
}
