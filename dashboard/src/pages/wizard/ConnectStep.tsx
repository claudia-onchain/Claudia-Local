// Setup wizard → Connect to Claudia (optional). One click first (pages/connect/OneClick.tsx); under
// "Connect manually": import the claudia CLI setup, set up here (device key + agent wallet, then paste the
// API key), or enter keys.
import { useEffect, useState } from "react";
import { api, errText, short } from "../../lib";
import { Copyable, Field, useAsync, useToast } from "../../ui";
import OneClick from "../connect/OneClick";

type Status = { baseUrl: string; rpcUrl: string; connected: boolean; devicePublicKey: string | null; walletAddress: string | null; agent: { name: string; slug: string } | null };
type Home = { found: boolean; dir: string; baseUrl?: string; agent?: { name: string; slug: string } | null; hasApiKey?: boolean; devicePublicKey?: string; walletAddress?: string; encrypted?: boolean };

export default function ConnectStep({ onDone }: { onDone?: () => void }) {
  const toast = useToast();
  const st = useAsync(() => api<Status>("/api/claudia/status"));
  const home = useAsync(() => api<Home>("/api/claudia/home"));
  const [mode, setMode] = useState<"home" | "new" | "manual">("new");
  const [manual, setManual] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const s = st.data;
  const h = home.data;
  useEffect(() => { if (h?.found) setMode("home"); }, [h?.found]);
  const connected = async () => { toast("Connected", "ok"); await st.reload(); };
  const run = async (f: () => Promise<unknown>, ok: string) => {
    setBusy(true); setErr("");
    try { await f(); toast(ok, "ok"); await st.reload(); } catch (e) { setErr(errText(e)); }
    setBusy(false);
  };

  if (s?.connected) {
    return (
      <div className="col gap-12">
        <div className="note ok">Connected as <strong>{s.agent?.name || "your agent"}</strong>{s.agent?.slug ? ` (@${s.agent.slug})` : ""}.</div>
        {onDone && <button className="btn primary lg" onClick={onDone}>Continue</button>}
      </div>
    );
  }

  return (
    <div className="col gap-12">
      <OneClick baseUrl={s?.baseUrl} onConnected={connected} compact />
      <button className="linkbtn small" style={{ alignSelf: "flex-start" }} onClick={() => setManual(v => !v)} aria-expanded={manual}>{manual ? "Hide manual setup" : "Connect manually"}</button>
      {manual && <>
      <div className="tabs" style={{ marginBottom: 4 }}>
        <button className={mode === "home" ? "on" : ""} onClick={() => setMode("home")}>Use my claudia CLI setup</button>
        <button className={mode === "new" ? "on" : ""} onClick={() => setMode("new")}>Set up here</button>
        <button className={mode === "manual" ? "on" : ""} onClick={() => setMode("manual")}>Enter keys</button>
      </div>
      {mode === "home" && <FromHome h={h} busy={busy} onImport={(pass) => run(() => api("/api/claudia/import", { body: { passphrase: pass || undefined } }), "Imported")} />}
      {mode === "new" && <SetupHere s={s} busy={busy}
        onKeys={() => run(() => api("/api/claudia/generate-keys", { body: { device: !s?.devicePublicKey, wallet: !s?.walletAddress } }), "Keys created")}
        onConnect={(key) => run(async () => { const r = await api<{ meError?: string }>("/api/claudia/connect", { body: { apiKey: key } }); if (r.meError) throw new Error(r.meError); }, "Connected")} />}
      {mode === "manual" && <ManualKeys s={s} busy={busy} onSave={(body) => run(async () => { const r = await api<{ meError?: string }>("/api/claudia/connect", { body }); if (r.meError) throw new Error(r.meError); }, "Connected")} />}
      </>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}

function FromHome({ h, busy, onImport }: { h: Home | null; busy: boolean; onImport: (pass: string) => void }) {
  const [pass, setPass] = useState("");
  if (!h) return <p className="muted small">Looking for ~/.claudia…</p>;
  if (!h.found) return <div className="note">No setup found in <span className="mono">{h.dir}</span>. Run <span className="mono">npx @useclaudia/cli init</span> and <span className="mono">claudia login ck_live_…</span> first, or use "Set up here".</div>;
  return (
    <div className="fields">
      <p className="small soft">Found a <span className="mono">@useclaudia/cli</span> setup in <span className="mono">{h.dir}</span>. Claudia Local copies its keys into its own encrypted vault.</p>
      <div className="kv small">
        <span>Agent</span><span>{h.agent ? `${h.agent.name} (@${h.agent.slug})` : <span className="muted">not logged in yet</span>}</span>
        <span>API key</span><span>{h.hasApiKey ? "yes" : <span className="sell">missing (run claudia login)</span>}</span>
        <span>Agent wallet (Solana)</span><span className="mono">{short(h.walletAddress, 6) || "–"}</span>
      </div>
      {h.encrypted && <Field label="Passphrase for ~/.claudia"><input className="input" type="password" value={pass} onChange={e => setPass(e.target.value)} /></Field>}
      <div><button className="btn primary" disabled={busy} onClick={() => onImport(pass)}>{busy ? "Importing…" : "Import this setup"}</button></div>
    </div>
  );
}

function SetupHere({ s, busy, onKeys, onConnect }: { s: Status | null; busy: boolean; onKeys: () => void; onConnect: (key: string) => void }) {
  const [key, setKey] = useState("");
  const site = (s?.baseUrl || "https://useclaudia.xyz").replace(/\/+$/, "");
  return (
    <ol className="col gap-12" style={{ paddingLeft: 18, margin: 0 }}>
      <li>
        <div><strong>Create a device key and an agent wallet (Solana).</strong> <span className="soft small">Only the public halves are shown.</span></div>
        {s?.devicePublicKey && s?.walletAddress ? (
          <div className="kv small mt-8">
            <span>Device key</span><Copyable text={s.devicePublicKey} />
            <span>Agent wallet</span><Copyable text={s.walletAddress} />
          </div>
        ) : <button className="btn mt-8" disabled={busy} onClick={onKeys}>Create keys</button>}
      </li>
      <li><strong>Create your agent on Claudia.</strong> <span className="soft small">Open <a href={`${site}/agents`} target="_blank" rel="noreferrer">{site.replace(/^https?:\/\//, "")}</a> → Agents → Create your agent, choose External and paste the agent wallet address.</span></li>
      <li><strong>Register the device key.</strong> <span className="soft small">In the agent console: API keys → I have a public key → paste the device key. Copy the API key it shows.</span></li>
      <li>
        <strong>Paste the API key here.</strong>
        <div className="row mt-8">
          <input className="input mono" placeholder="ck_live_…" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} />
          <button className="btn primary" disabled={!key.trim() || busy || !s?.devicePublicKey} onClick={() => onConnect(key.trim())}>Connect</button>
        </div>
      </li>
    </ol>
  );
}

function ManualKeys({ s, busy, onSave }: { s: Status | null; busy: boolean; onSave: (body: Record<string, string>) => void }) {
  const [f, setF] = useState({ baseUrl: s?.baseUrl || "https://useclaudia.xyz", apiKey: "", deviceKey: "", walletKey: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="fields">
      <Field label="Claudia address"><input className="input mono" value={f.baseUrl} onChange={set("baseUrl")} /></Field>
      <Field label="API key"><input className="input mono" type="password" placeholder="ck_live_…" autoComplete="off" value={f.apiKey} onChange={set("apiKey")} /></Field>
      <Field label="Device key (secret, base58)" hint="Signs your agent's requests."><input className="input mono" type="password" autoComplete="off" value={f.deviceKey} onChange={set("deviceKey")} /></Field>
      <Field label="Agent wallet key (Solana, optional)" hint="Fund it only with what you're willing to lose."><input className="input mono" type="password" autoComplete="off" value={f.walletKey} onChange={set("walletKey")} /></Field>
      <div><button className="btn primary" disabled={busy || !f.apiKey.trim()} onClick={() => onSave(Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()])))}>{busy ? "Saving…" : "Save and connect"}</button></div>
    </div>
  );
}
