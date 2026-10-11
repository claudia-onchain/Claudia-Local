// Settings → MCP servers for your agent: Claudia Data and Claudia Trade built in, plus servers you add
// (a Streamable HTTP URL, or a program on this computer). Each tool can be switched off.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errText } from "../../lib";
import { Field, Switch, useAsync, useToast } from "../../ui";

type Tool = { name: string; title: string; description: string; agentName: string; enabled: boolean };
type Server = {
  id: string; name: string; kind: "http" | "stdio"; url: string; command: string; args: string[]; builtin: boolean; about: string;
  auth: "none" | "bearer" | "key"; tokenSet: boolean | null; enabled: boolean; status: string; error: string; tools: Tool[];
};

export default function McpClients() {
  const r = useAsync(() => api<{ servers: Server[] }>("/api/mcp-clients"));
  const update = (s: Server) => r.setData(d => d && { servers: d.servers.map(x => (x.id === s.id ? s : x)) });
  return (
    <div className="card" id="mcp-clients">
      <div className="card-head"><h2>MCP servers for your agent</h2></div>
      <p className="small muted" style={{ marginTop: -6 }}>Tools from these servers reach your agent as mcp__server__tool. Their results are treated as outside content.</p>
      {r.error && <p className="error mt-8">{r.error}</p>}
      <div className="mt-8">{(r.data?.servers || []).map(s => <Row key={s.id} s={s} onChange={update} onRemoved={r.reload} />)}</div>
      <Add onAdded={r.reload} />
    </div>
  );
}

function Row({ s, onChange, onRemoved }: { s: Server; onChange: (s: Server) => void; onRemoved: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [token, setToken] = useState("");
  const call = async (f: () => Promise<Server>, ok?: string) => {
    setBusy(true);
    try { const x = await f(); onChange(x); if (x.status === "error" && x.error) toast(x.error, "bad"); else if (ok) toast(ok, "ok"); } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const patch = (body: Record<string, unknown>, ok?: string) => call(() => api<Server>(`/api/mcp-clients/${s.id}`, { body }), ok);
  const remove = async () => {
    if (!confirm(`Remove ${s.name}?`)) return;
    try { await api(`/api/mcp-clients/${s.id}`, { method: "DELETE" }); onRemoved(); } catch (e) { toast(errText(e), "bad"); }
  };
  const on = s.tools.filter(t => t.enabled).length;
  return (
    <div className="provider">
      <div className="row">
        <span className={`dot ${s.status === "ready" ? "ok" : s.status === "error" ? "bad" : s.status === "connecting" ? "warn" : ""}`} />
        <div className="grow">
          <div>{s.name} {s.kind === "stdio" && <span className="badge copper">program</span>}</div>
          <div className="tiny muted break">{s.about || (s.kind === "http" ? s.url : `${s.command} ${s.args.join(" ")}`)}</div>
        </div>
        <span className="tiny muted nowrap hide-phone">{s.status === "ready" ? `${on} of ${s.tools.length} tools` : s.status === "off" ? "Off" : s.status === "error" ? "Error" : s.status}</span>
        <Switch checked={s.enabled} disabled={busy} onChange={v => patch({ enabled: v }, v ? `${s.name} on` : `${s.name} off`)} />
      </div>
      {(s.enabled || !s.builtin || s.auth !== "none") && (
        <div className="col gap-8 mt-8" style={{ paddingLeft: 15 }}>
          {s.status === "error" && s.error && <div className="note bad small">{s.error}</div>}
          {s.auth === "key" && !s.tokenSet && <div className="small muted">Add your cmk_ key under <Link to="/settings#keys">Keys → Claudia</Link>.</div>}
          {s.auth === "key" && s.tokenSet && <div className="small muted">Key set. It only prepares trades and launches; you confirm them yourself.</div>}
          {s.auth === "bearer" && (
            <Field label="Bearer token" hint={s.tokenSet ? "Saved and encrypted. Type a new one to replace it." : "Only if the server needs one."}>
              <div className="row">
                <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder={s.tokenSet ? "••••••••" : "token"} value={token} onChange={e => setToken(e.target.value)} />
                <button className="btn sm" disabled={!token.trim() || busy} onClick={() => { patch({ token: token.trim() }, "Token saved"); setToken(""); }}>Save</button>
                {s.tokenSet && <button className="btn ghost sm" disabled={busy} onClick={() => patch({ token: "" }, "Token removed")}>Remove</button>}
              </div>
            </Field>
          )}
          {s.tools.length > 0 && (
            <details className="more">
              <summary>Tools ({on} of {s.tools.length} on)</summary>
              <div className="list mt-8">
                {s.tools.map(t => (
                  <div key={t.name} className="item">
                    <div className="grow">
                      <div className="small">{t.title || t.name} <span className="mono tiny muted">{t.agentName}</span></div>
                      {t.description && <div className="tiny muted">{t.description}</div>}
                    </div>
                    <Switch checked={t.enabled} disabled={busy} onChange={v => patch({ tools: { [t.name]: v } })} />
                  </div>
                ))}
              </div>
            </details>
          )}
          <div className="row">
            {s.enabled && <button className="btn sm" disabled={busy} onClick={() => call(() => api<Server>(`/api/mcp-clients/${s.id}/refresh`, { method: "POST", body: {} }), "Reconnected")}>{busy ? "Working…" : "Refresh"}</button>}
            {!s.builtin && <button className="btn danger sm right" onClick={remove}>Remove</button>}
          </div>
        </div>
      )}
    </div>
  );
}

function Add({ onAdded }: { onAdded: () => void }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<"http" | "stdio">("http");
  const [f, setF] = useState({ name: "", url: "", token: "", command: "", args: "" });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f, v: string) => setF({ ...f, [k]: v });
  const add = async () => {
    setBusy(true);
    try {
      await api("/api/mcp-clients", { body: kind === "http" ? { kind, name: f.name.trim(), url: f.url.trim(), token: f.token.trim() || undefined } : { kind, name: f.name.trim(), command: f.command.trim(), args: f.args.trim().split(/\s+/).filter(Boolean) } });
      toast("Added. Switch it on to connect.", "ok");
      setF({ name: "", url: "", token: "", command: "", args: "" }); setOpen(false); onAdded();
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  if (!open) return <button className="btn sm mt-12" onClick={() => setOpen(true)}>Add a server</button>;
  const ok = f.name.trim() && (kind === "http" ? f.url.trim() : f.command.trim());
  return (
    <div className="fields mt-16">
      <div className="seg">
        <button className={kind === "http" ? "on" : ""} onClick={() => setKind("http")}>Streamable HTTP</button>
        <button className={kind === "stdio" ? "on" : ""} onClick={() => setKind("stdio")}>Program on this computer</button>
      </div>
      <Field label="Name"><input className="input" value={f.name} onChange={e => set("name", e.target.value)} placeholder="e.g. My tools" /></Field>
      {kind === "http" ? (
        <>
          <Field label="URL"><input className="input mono" value={f.url} onChange={e => set("url", e.target.value)} placeholder="https://example.com/mcp" /></Field>
          <Field label="Bearer token (optional)"><input className="input mono" type="password" autoComplete="off" spellCheck={false} value={f.token} onChange={e => set("token", e.target.value)} /></Field>
        </>
      ) : (
        <>
          <div className="note warn small">This starts a program on your computer with your permissions. Only add programs you trust.</div>
          <Field label="Command"><input className="input mono" value={f.command} onChange={e => set("command", e.target.value)} placeholder="npx" /></Field>
          <Field label="Arguments" hint="Separated by spaces."><input className="input mono" value={f.args} onChange={e => set("args", e.target.value)} placeholder="-y some-mcp-server" /></Field>
        </>
      )}
      <div className="row">
        <button className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
        <button className="btn primary sm" disabled={!ok || busy} onClick={add}>{busy ? "Adding…" : "Add"}</button>
      </div>
    </div>
  );
}
