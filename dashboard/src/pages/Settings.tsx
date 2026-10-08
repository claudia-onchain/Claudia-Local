import { useEffect, useMemo, useState } from "react";
import { api, errText } from "../lib";
import { Field, PageHead, Switch, useAsync, useToast } from "../ui";
import type { AppState } from "../App";
import Keys from "./settings/Keys";
import Mcp from "./settings/Mcp";
import Safety from "./settings/Safety";

type Cfg = {
  model: string; modelLabel: string; usingDefaultModel: boolean; temperature: number; maxTokens: number; tone: string;
  autoLockMinutes: number; showImages: boolean; openrouterKey: { set: boolean; hint: string }; dataDir: string; workspaceDir: string;
  chat: { provider: string; providerName: string; baseUrl: string; models: Record<string, string> };
};
type Model = { id: string; name: string; context: number | null; noCost: boolean; promptPerM: number | null; completionPerM: number | null; tools: boolean | null };

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
        <AiCard c={c} setData={setData} save={save} />
        <Keys />
        <Safety />
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
          <div className="small muted mt-12">Claudia Local only connects to your chat provider, the Claudia address you set, your Solana RPC, and the services you add keys for (only when you use them). The OAuth and media relays on useclaudia.xyz are used only for networks that need them. Nothing else leaves this computer.</div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Data</h2></div>
          <div className="kv">
            <span>Data folder</span><span className="mono small">{c.dataDir}</span>
            <span>Workspace</span><span className="mono small">{c.workspaceDir}</span>
            <span>Version</span><span>{state.version}</span>
          </div>
          <div className="row mt-16">
            <button className="btn danger sm" onClick={async () => { if (confirm("Delete all chats, usage numbers and the activity log? Memories, files and keys stay.")) { await api("/api/history", { method: "DELETE" }); toast("History cleared", "ok"); } }}>Clear chat history</button>
          </div>
        </div>
      </div>
    </>
  );
}

type Preset = { id: string; name: string; baseUrl: string; key: string; modelHint: string; keySet: boolean };

function AiCard({ c, setData, save }: { c: Cfg; setData: (c: Cfg) => void; save: (p: Record<string, unknown>, m?: string) => void }) {
  const toast = useToast();
  const presets = useAsync(() => api<{ presets: Preset[] }>("/api/chat/presets"));
  const provider = c.chat?.provider || "openrouter";
  const preset = presets.data?.presets.find(p => p.id === provider);
  const isOR = provider === "openrouter";
  const [key, setKey] = useState("");
  const [custom, setCustom] = useState(!c.usingDefaultModel);
  const current = isOR ? c.model : c.chat?.models?.[provider] || "";
  const [model, setModel] = useState(current);
  const [base, setBase] = useState(c.chat?.baseUrl || "");
  const [models, setModels] = useState<Model[] | null>(null);
  const [mq, setMq] = useState("");
  const [temp, setTemp] = useState(String(c.temperature));
  const [maxT, setMaxT] = useState(String(c.maxTokens));
  useEffect(() => { setModel(current); setCustom(!c.usingDefaultModel); setModels(null); }, [current, c.usingDefaultModel, provider]);

  const saveKey = async (v: string) => {
    try {
      if (isOR) setData(await api<Cfg>("/api/secrets/openrouter", { body: { key: v } }));
      else if (preset) { if (v) await api(`/api/keys/${preset.key}`, { body: { fields: { key: v } } }); else await api(`/api/keys/${preset.key}`, { method: "DELETE" }); presets.reload(); }
      setKey(""); toast(v ? "Key saved (encrypted)" : "Key removed", "ok");
    } catch (e) { toast(errText(e), "bad"); }
  };
  const useModel = (id: string, label?: string) => save(isOR ? { model: id } : { chat: { models: { [provider]: id } } }, `Using ${label || id}`);
  const loadModels = async () => {
    try { const r = await api<{ models: Model[]; error?: string }>(`/api/models${isOR ? "" : `?provider=${provider}`}`); setModels(r.models); if (r.error) toast(r.error, "bad"); } catch (e) { toast(errText(e), "bad"); }
  };
  const shown = useMemo(() => (models || []).filter(m => !mq || (m.name + " " + m.id).toLowerCase().includes(mq.toLowerCase())).slice(0, 60), [models, mq]);
  const label = (id: string) => id.replace(/:free$/, "");
  const keyInfo = isOR ? c.openrouterKey : { set: !!preset?.keySet, hint: "" };

  return (
    <div className="card">
      <div className="card-head"><h2>Chat model</h2><p>Any OpenAI-compatible provider, with your own key.</p></div>
      <div className="fields">
        <Field label="Provider">
          <select className="select" value={provider} onChange={e => save({ chat: { provider: e.target.value } }, "Provider changed")}>
            {(presets.data?.presets || [{ id: "openrouter", name: "OpenRouter" } as Preset]).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </Field>
        {provider === "custom" && (
          <Field label="Server address" hint="The part before /chat/completions, e.g. https://my-server.example/v1 or http://localhost:11434/v1.">
            <div className="row">
              <input className="input mono" placeholder="https://…/v1" value={base} onChange={e => setBase(e.target.value)} />
              <button className="btn" disabled={base === (c.chat?.baseUrl || "")} onClick={() => save({ chat: { baseUrl: base } })}>Save</button>
            </div>
          </Field>
        )}
        <Field label={`${preset?.name || "OpenRouter"} key`} hint={keyInfo.set ? `Saved and encrypted${keyInfo.hint ? ` (ends ${keyInfo.hint.slice(-4)})` : ""}. Paste a new one to replace it.` : provider === "custom" ? "Only if your server needs one." : <>Not set. It's also under Keys and providers below.</>}>
          <div className="row">
            <input className="input mono" type="password" placeholder={keyInfo.set ? "••••••••" : isOR ? "sk-or-…" : "API key"} autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} />
            <button className="btn" disabled={!key.trim()} onClick={() => saveKey(key.trim())}>Save</button>
            {keyInfo.set && <button className="btn ghost" onClick={() => saveKey("")}>Remove</button>}
          </div>
        </Field>
        <div className="field">
          <span className="label">Model</span>
          {isOR && <label className="row"><input type="radio" checked={!custom} onChange={() => { setCustom(false); save({ model: "" }, "Using the default model"); }} /> Default model <span className="muted small">(OpenRouter picks one for you)</span></label>}
          {isOR && <label className="row"><input type="radio" checked={custom} onChange={() => setCustom(true)} /> Choose a model</label>}
          {(custom || !isOR) && (
            <div className="col" style={{ paddingLeft: isOR ? 24 : 0 }}>
              <div className="row">
                <input className="input mono" placeholder={preset?.modelHint || "model id"} value={label(model)} onChange={e => setModel(e.target.value === label(current) ? current : e.target.value)} aria-label="Model id" />
                <button className="btn" disabled={!model.trim() || model === current} onClick={() => useModel(model.trim())}>Use</button>
              </div>
              {provider !== "custom" && (!models ? <button className="linkbtn small" style={{ alignSelf: "flex-start" }} onClick={loadModels}>Browse {preset?.name || "OpenRouter"}'s models</button> : (
                <div className="card tight flat">
                  <input className="input" placeholder="Filter models" value={mq} onChange={e => setMq(e.target.value)} aria-label="Filter models" />
                  <div className="list mt-8" style={{ maxHeight: 300, overflowY: "auto" }}>
                    {!shown.length && <div className="empty">No models listed.</div>}
                    {shown.map(m => (
                      <button key={m.id} className="item linkbtn" style={{ textAlign: "left", color: "var(--text)" }} onClick={() => { setModel(m.id); useModel(m.id, m.name); }}>
                        <span className="grow trunc">{m.name || m.id}</span>
                        {m.tools === false && <span className="badge">no tools</span>}
                        {m.promptPerM !== null && m.promptPerM !== undefined && <span className="tiny muted nowrap num">{m.noCost ? "$0" : `$${m.promptPerM}/$${m.completionPerM} per 1M`}</span>}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="hint">Now using: {c.modelLabel}{!isOR ? ` on ${preset?.name || provider}` : ""}. Models without tool support can still chat, but can't use files, memory, Claudia or the studio. Claudia's persona never names the model.</div>
        </div>
        <div className="fields two">
          <Field label="Creativity (temperature)" hint="0 is steady, 1 is loose.">
            <input className="input" type="number" min={0} max={1.5} step={0.1} value={temp} onChange={e => setTemp(e.target.value)} onBlur={() => Number(temp) !== c.temperature && save({ temperature: Number(temp) })} />
          </Field>
          <Field label="Longest reply (tokens)">
            <input className="input" type="number" min={256} max={32768} step={256} value={maxT} onChange={e => setMaxT(e.target.value)} onBlur={() => Number(maxT) !== c.maxTokens && save({ maxTokens: Number(maxT) })} />
          </Field>
        </div>
        <Field label="How it talks">
          <div className="seg">
            {[["plain", "Plain"], ["friendly", "Friendly"], ["brief", "Brief"]].map(([v, l]) => <button key={v} className={c.tone === v ? "on" : ""} onClick={() => save({ tone: v })}>{l}</button>)}
          </div>
        </Field>
      </div>
    </div>
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
