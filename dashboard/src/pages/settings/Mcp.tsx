// Settings → Local MCP: let Claude Code, Claude Desktop, Cursor and other MCP apps use the studio on this computer.
import { useState } from "react";
import { api, copy, errText } from "../../lib";
import { Field, Switch, useAsync, useToast } from "../../ui";

type Info = { enabled: boolean; port: number; running: boolean; error: string; url: string; tokenSet: boolean; tokenHint: string; tools: string[] };

export default function Mcp() {
  const toast = useToast();
  const r = useAsync(() => api<Info>("/api/mcp"));
  const [token, setToken] = useState("");
  const [port, setPort] = useState("");
  const [app, setApp] = useState<"code" | "desktop" | "cursor">("code");
  const i = r.data;
  if (!i) return null;
  const set = async (patch: Partial<Info>) => {
    try { const x = await api<Info>("/api/mcp", { body: patch }); r.setData(x); setPort(""); if (x.error) toast(x.error, "bad"); else toast(x.enabled ? `Local MCP on at ${x.url}` : "Local MCP off", "ok"); } catch (e) { toast(errText(e), "bad"); }
  };
  const make = async () => {
    if (i.tokenSet && !confirm("Make a new token? Apps using the old one stop working until you update them.")) return;
    try { const x = await api<Info & { token: string }>("/api/mcp/token", { body: {} }); setToken(x.token); r.setData(x); } catch (e) { toast(errText(e), "bad"); }
  };
  const tok = token || "<your token>";
  const snippets = {
    code: `claude mcp add --transport http claudia-local ${i.url} --header "Authorization: Bearer ${tok}"`,
    desktop: JSON.stringify({ mcpServers: { "claudia-local": { command: "npx", args: ["-y", "mcp-remote", i.url, "--header", `Authorization: Bearer ${tok}`] } } }, null, 2),
    cursor: JSON.stringify({ mcpServers: { "claudia-local": { url: i.url, headers: { Authorization: `Bearer ${tok}` } } } }, null, 2),
  };
  const where = { code: "Run in a terminal.", desktop: "Claude Desktop → Settings → Developer → Edit config (claude_desktop_config.json), then restart Claude Desktop. Needs Node.js for npx.", cursor: "Cursor → Settings → MCP → Add new global MCP server (~/.cursor/mcp.json)." };

  return (
    <div className="card">
      <div className="card-head"><h2 className="grow">Local MCP</h2><Switch checked={i.enabled} onChange={v => set({ enabled: v })} /></div>
      <p className="small muted" style={{ marginTop: -6 }}>Off by default. When on, MCP apps on this computer can make media and draft posts with your keys. Publishing still needs your approval here; there's no publish tool.</p>
      <div className="kv mt-12 small">
        <span>Address</span><span className="mono">{i.url}</span>
        <span>Status</span><span>{i.running ? <span className="buy">Running</span> : i.enabled ? <span className="sell">{i.error || "Not running"}</span> : "Off"}</span>
        <span>Token</span><span>{i.tokenSet ? `Set (ends ${i.tokenHint})` : "None yet"}</span>
        <span>Tools</span><span className="mono tiny">{i.tools.join(", ")}</span>
      </div>
      <div className="fields mt-16">
        <div className="row wrap">
          <Field label="Port"><input className="input num" style={{ width: 110 }} inputMode="numeric" placeholder={String(i.port)} value={port} onChange={e => setPort(e.target.value)} /></Field>
          <button className="btn sm" style={{ alignSelf: "flex-end", marginBottom: 4 }} disabled={!port || Number(port) === i.port} onClick={() => set({ port: Number(port) })}>Change port</button>
          <button className="btn sm right" style={{ alignSelf: "flex-end", marginBottom: 4 }} onClick={make}>{i.tokenSet ? "Make a new token" : "Make a token"}</button>
        </div>
        {token && (
          <div className="note brand">
            <div className="small"><strong>Copy it now.</strong> It's shown once; only a fingerprint is kept.</div>
            <div className="row mt-8"><span className="mono small break grow">{token}</span><button className="btn sm" onClick={() => { copy(token); toast("Copied", "ok"); }}>Copy</button></div>
          </div>
        )}
        <div>
          <div className="seg">{([["code", "Claude Code"], ["desktop", "Claude Desktop"], ["cursor", "Cursor"]] as const).map(([v, l]) => <button key={v} className={app === v ? "on" : ""} onClick={() => setApp(v)}>{l}</button>)}</div>
          <div className="small muted mt-8">{where[app]}</div>
          <pre className="code mt-8">{snippets[app]}</pre>
          <div className="row mt-8"><button className="btn sm" onClick={() => { copy(snippets[app]); toast("Copied", "ok"); }}>Copy</button>{!token && <span className="tiny muted">Make a token to fill it in.</span>}</div>
        </div>
      </div>
    </div>
  );
}
