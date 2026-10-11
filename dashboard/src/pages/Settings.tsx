import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errText } from "../lib";
import { Field, PageHead, Switch, useAsync, useToast } from "../ui";
import type { AppState } from "../App";
import Keys from "./settings/Keys";
import Models from "./settings/Models";
import Mcp from "./settings/Mcp";
import McpClients from "./settings/McpClients";
import Safety from "./settings/Safety";
import ClaudiaCard from "./connect/ClaudiaCard";
import Channels from "./auto/Channels";

type Cfg = {
  modelLabel: string; temperature: number; maxTokens: number; tone: string;
  autoLockMinutes: number; showImages: boolean; dataDir: string; workspaceDir: string;
};

export default function Settings({ state }: { state: AppState }) {
  const toast = useToast();
  const { data: c, setData } = useAsync(() => api<Cfg>("/api/config"));
  useEffect(() => { if (c && location.hash) setTimeout(() => document.querySelector(location.hash)?.scrollIntoView({ block: "start" }), 50); }, [!!c]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch: Record<string, unknown>, msg = "Saved") => {
    try { setData(await api<Cfg>("/api/config", { body: patch })); toast(msg, "ok"); } catch (e) { toast(errText(e), "bad"); }
  };
  if (!c) return null;
  return (
    <>
      <PageHead title="Settings" sub="Everything here is saved on this computer." />
      <div className="col gap-16">
        <Models />
        <Keys />
        <ClaudiaCard />
        <Safety />
        <Channels />
        <McpClients />
        <Mcp />
        <SecurityCard c={c} save={save} />
        <div className="card">
          <div className="card-head"><h2>Privacy</h2></div>
          <div className="list">
            <div className="item">
              <div className="grow"><div>Show coin pictures</div><div className="small muted">Pictures load from each coin's own image host, which can see your IP address. Off shows the ticker instead.</div></div>
              <Switch checked={c.showImages} onChange={v => save({ showImages: v })} />
            </div>
          </div>
          <div className="small muted mt-12">Claudia Local only connects to your chat provider, the Claudia address you set, your Solana and Robinhood Chain RPCs, and the services you add keys for (only when you use them). The OAuth and media relays on useclaudia.xyz are used only for networks that need them. Nothing else leaves this computer.</div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Data</h2></div>
          <div className="kv">
            <span>Data folder</span><span className="mono small">{c.dataDir}</span>
            <span>Workspace</span><span className="mono small">{c.workspaceDir}</span>
            <span>Version</span><span>{state.version}</span>
          </div>
          <div className="row wrap mt-16">
            <button className="btn sm" onClick={async () => { try { await api("/api/wizard/restart", { body: {} }); location.assign("/"); } catch (e) { toast(errText(e), "bad"); } }}>Run setup again</button>
            <Link className="btn sm" to="/health">Check health</Link>
            <button className="btn danger sm right" onClick={async () => { if (confirm("Delete all chats, usage numbers and the activity log? Memories, files and keys stay.")) { await api("/api/history", { method: "DELETE" }); toast("History cleared", "ok"); } }}>Clear chat history</button>
          </div>
        </div>
      </div>
    </>
  );
}

function SecurityCard({ c, save }: { c: Cfg; save: (p: Record<string, unknown>, m?: string) => void }) {
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [conf, setConf] = useState("");
  const [lockMin, setLockMin] = useState(String(c.autoLockMinutes));
  const change = async () => {
    try { await api("/api/passphrase", { body: { current: cur, next, confirm: conf } }); setCur(""); setNext(""); setConf(""); toast("Passphrase changed", "ok"); } catch (e) { toast(errText(e), "bad"); }
  };
  return (
    <div className="card">
      <div className="card-head"><h2>Lock and passphrase</h2><p>Your keys are encrypted with your passphrase (scrypt + AES-256-GCM).</p></div>
      <div className="fields">
        <Field label="Lock after this many idle minutes" hint="0 keeps it unlocked until you lock it or quit the app.">
          <div className="row">
            <input className="input" type="number" min={0} max={1440} style={{ maxWidth: 140 }} value={lockMin} onChange={e => setLockMin(e.target.value)} />
            <button className="btn" disabled={Number(lockMin) === c.autoLockMinutes} onClick={() => save({ autoLockMinutes: Number(lockMin) })}>Save</button>
          </div>
        </Field>
        <div className="label">Change passphrase</div>
        <div className="fields two">
          <input className="input" type="password" placeholder="Current passphrase" autoComplete="current-password" value={cur} onChange={e => setCur(e.target.value)} />
          <span className="hide-phone" />
          <input className="input" type="password" placeholder="New passphrase" autoComplete="new-password" value={next} onChange={e => setNext(e.target.value)} />
          <input className="input" type="password" placeholder="New passphrase again" autoComplete="new-password" value={conf} onChange={e => setConf(e.target.value)} />
        </div>
        <div><button className="btn" disabled={!cur || next.length < 8 || next !== conf} onClick={change}>Change passphrase</button></div>
      </div>
    </div>
  );
}
