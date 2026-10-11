// Settings → Chat model: the provider your agent thinks with, a model per role (main, helpers, scheduled
// tasks) kept per provider, a fallback model, and this month's estimated spend with optional caps.
import { useEffect, useState } from "react";
import { api, errText } from "../../lib";
import { Field, useAsync, useToast } from "../../ui";

type Cfg = {
  modelLabel: string; vision: boolean; temperature: number; maxTokens: number; tone: string;
  chat: {
    provider: string; providerName: string; baseUrl: string; models: Record<string, string>;
    roleModels: Record<string, { helpers?: string; tasks?: string }>; helperModels: Record<string, Record<string, string>>;
    fallback: { provider: string; model: string }; caps: Record<string, number>;
  };
};
type Preset = { id: string; name: string; kind: "anthropic" | "openai" | "local"; baseUrl: string; key: string | null; keyProvider: string | null; keySet: boolean; models: M[]; listModels: boolean; modelHint: string; docs: string; running?: boolean; localModels?: M[] };
type M = { id: string; name: string; recommended?: boolean; promptPerM?: number; completionPerM?: number; tools?: boolean; vision?: boolean };
type ModelList = { models: M[]; live: boolean; error?: string };
type Spend = { month: string; estimate: boolean; totalUsd: number; providers: { id: string; name: string; usd: number; input: number; output: number; calls: number; unpriced: number; cap: number }[] };

const usd = (n: number) => (n > 0 && n < 0.01 ? "< $0.01" : `$${n.toFixed(2)}`);
const tokens = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const usable = (p: Preset) => (p.kind === "local" ? !!p.running : p.keySet);

function useModels(provider: string, reloadKey = 0) {
  const [list, setList] = useState<ModelList | null>(null);
  useEffect(() => {
    if (!provider) { setList(null); return; }
    let live = true;
    setList(null);
    api<ModelList>(`/api/models?provider=${encodeURIComponent(provider)}`).then(r => { if (live) setList(r); }).catch(e => { if (live) setList({ models: [], live: false, error: errText(e) }); });
    return () => { live = false; };
  }, [provider, reloadKey]);
  return list;
}

export default function Models({ onChange }: { onChange?: () => void }) {
  const toast = useToast();
  const cfgQ = useAsync(() => api<Cfg>("/api/config"));
  const presetsQ = useAsync(() => api<{ presets: Preset[] }>("/api/chat/presets"));
  const spendQ = useAsync(() => api<Spend>("/api/chat/spend"));
  const c = cfgQ.data;
  const provider = c?.chat.provider || "";
  const presets = presetsQ.data?.presets || [];
  const preset = presets.find(p => p.id === provider);
  const [reloadKey, setReloadKey] = useState(0);
  const list = useModels(provider, reloadKey);
  const [base, setBase] = useState("");
  const [temp, setTemp] = useState("");
  const [maxT, setMaxT] = useState("");
  useEffect(() => { if (c) { setBase(c.chat.baseUrl || ""); setTemp(String(c.temperature)); setMaxT(String(c.maxTokens)); } }, [c?.chat.baseUrl, c?.temperature, c?.maxTokens]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (patch: Record<string, unknown>, msg = "Saved") => {
    try { cfgQ.setData(await api<Cfg>("/api/config", { body: patch })); toast(msg, "ok"); onChange?.(); spendQ.reload(); } catch (e) { toast(errText(e), "bad"); }
  };
  if (!c) return null;

  const options = list?.models?.length ? list.models : preset?.kind === "local" ? preset.localModels || [] : preset?.models || [];
  const roles = c.chat.roleModels[provider] || {};
  const fb = c.chat.fallback || { provider: "", model: "" };

  return (
    <div className="card" id="model">
      <div className="card-head"><h2 className="grow">Chat model</h2><p>Your own key, or a model running on this computer.</p></div>
      <div className="fields">
        <Field label="Provider">
          <select className="select" value={provider} onChange={e => save({ chat: { provider: e.target.value } }, "Provider changed")}>
            {!provider && <option value="">Pick a provider</option>}
            {presets.map(p => (
              <option key={p.id} value={p.id}>
                {p.name}{p.kind === "local" ? (p.running ? " (running)" : " (not running)") : p.id !== "custom" && !p.keySet ? " (add a key)" : ""}
              </option>
            ))}
          </select>
        </Field>
        {!provider && <div className="note">Add a key below under Keys, or start Ollama or LM Studio on this computer.</div>}
        {preset && preset.kind !== "local" && !preset.keySet && preset.id !== "custom" && (
          <div className="note warn small"><a href="#keys" onClick={e => { e.preventDefault(); document.getElementById("keys")?.scrollIntoView({ block: "start" }); }}>Add your {preset.keyProvider || preset.name} key</a> to use {preset.name}.</div>
        )}
        {preset?.kind === "local" && !preset.running && <div className="note warn small">{preset.name.replace(/ \(.*\)$/, "")} isn't running. Start it, then <button className="linkbtn" onClick={() => { presetsQ.reload(); setReloadKey(k => k + 1); }}>check again</button>.</div>}
        {provider === "custom" && (
          <Field label="Server address" hint="The part before /chat/completions, e.g. https://my-server.example/v1 or http://localhost:8080/v1.">
            <div className="row">
              <input className="input mono" placeholder="https://…/v1" value={base} onChange={e => setBase(e.target.value)} />
              <button className="btn" disabled={base === (c.chat.baseUrl || "")} onClick={() => save({ chat: { baseUrl: base } })}>Save</button>
            </div>
          </Field>
        )}

        {provider && (
          <>
            <div className="label">Models</div>
            <RoleRow label="Main" hint="Chats with you." value={c.chat.models[provider] || ""} options={options} hintId={preset?.modelHint} onSave={id => save({ chat: { models: { [provider]: id } } }, id ? `Using ${id}` : "Saved")} />
            <RoleRow label="Helpers" hint="Research, market, risk and the other helpers." value={roles.helpers || ""} empty="Same as main" options={options} hintId={preset?.modelHint} onSave={id => save({ chat: { roleModels: { [provider]: { helpers: id } } } })} />
            <RoleRow label="Scheduled tasks" hint="Work that runs on a schedule." value={roles.tasks || ""} empty="Same as main" options={options} hintId={preset?.modelHint} onSave={id => save({ chat: { roleModels: { [provider]: { tasks: id } } } })} />
            <div className="tiny muted">
              {!list ? "Loading models…" : list.live ? "" : "From the built-in list. "}
              {list?.error ? list.error + " " : ""}
              Now using: {c.modelLabel}.{c.vision ? " It can see images." : " It can't see images."} Models without tool support can chat, but can't use files, memory, Claudia or the studio.
            </div>
          </>
        )}

        <Fallback c={c} presets={presets} fb={fb} save={save} />

        <SpendCard spend={spendQ.data} caps={c.chat.caps || {}} presets={presets} current={provider} save={save} />

        <div className="fields two">
          <Field label="Creativity (temperature)" hint="0 is steady, 1 is loose. Claude models use their own setting.">
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

/** A select from the model list, plus "Type a model id". Empty = `empty` label (or nothing picked). */
function ModelPicker({ value, options, empty, hintId, onSave }: { value: string; options: M[]; empty?: string; hintId?: string; onSave: (id: string) => void }) {
  const known = options.some(o => o.id === value);
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState(value);
  useEffect(() => { setText(value); }, [value]);
  const showInput = typing || (!options.length);
  return (
    <div className="col gap-4" style={{ minWidth: 0 }}>
      {options.length > 0 && (
        <select className="select" value={typing ? "__type" : value} onChange={e => {
          const v = e.target.value;
          if (v === "__type") { setTyping(true); return; }
          setTyping(false);
          if (v !== value) onSave(v);
        }}>
          <option value="">{empty || "Pick a model"}</option>
          {value && !known && <option value={value}>{value}</option>}
          {options.map(o => <option key={o.id} value={o.id}>{o.name && o.name !== o.id ? `${o.name} · ${o.id}` : o.id}{o.recommended ? " (recommended)" : ""}{o.tools === false ? " (no tools)" : ""}</option>)}
          <option value="__type">Type a model id…</option>
        </select>
      )}
      {showInput && (
        <div className="row">
          <input className="input mono" placeholder={empty ? `${empty} · or a model id` : hintId || "model id"} value={text} onChange={e => setText(e.target.value)} aria-label="Model id" />
          <button className="btn sm" disabled={text.trim() === value} onClick={() => { onSave(text.trim()); setTyping(false); }}>Use</button>
        </div>
      )}
    </div>
  );
}

function RoleRow({ label, hint, value, empty, options, hintId, onSave }: { label: string; hint: string; value: string; empty?: string; options: M[]; hintId?: string; onSave: (id: string) => void }) {
  return (
    <div className="row top wrap">
      <div style={{ width: 150, flex: "none" }}><div className="small">{label}</div><div className="tiny muted">{hint}</div></div>
      <div className="grow"><ModelPicker value={value} options={options} empty={empty} hintId={hintId} onSave={onSave} /></div>
    </div>
  );
}

function Fallback({ c, presets, fb, save }: { c: Cfg; presets: Preset[]; fb: { provider: string; model: string }; save: (p: Record<string, unknown>, m?: string) => void }) {
  const list = useModels(fb.provider);
  const fp = presets.find(p => p.id === fb.provider);
  const options = list?.models?.length ? list.models : fp?.kind === "local" ? fp.localModels || [] : fp?.models || [];
  const choices = presets.filter(p => usable(p) || p.id === fb.provider);
  return (
    <div className="col gap-8">
      <div className="label">Fallback model</div>
      <div className="tiny muted">Tried once when the main model fails after retries (rate limit, outage).</div>
      <div className="row top wrap">
        <select className="select" style={{ width: 220, flex: "none" }} value={fb.provider} onChange={e => save({ chat: { fallback: { provider: e.target.value, model: "" } } }, e.target.value ? "Fallback provider set" : "No fallback")}>
          <option value="">None</option>
          {choices.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {fb.provider && <div className="grow"><ModelPicker value={fb.model} options={options} hintId={fp?.modelHint} onSave={id => save({ chat: { fallback: { provider: fb.provider, model: id } } }, id ? `Fallback: ${id}` : "Saved")} /></div>}
      </div>
      {fb.provider && fb.provider === c.chat.provider && fb.model && fb.model === c.chat.models[c.chat.provider] && <div className="tiny muted">That's the same as the main model, so it won't be used.</div>}
    </div>
  );
}

function SpendCard({ spend, caps, presets, current, save }: { spend: Spend | null; caps: Record<string, number>; presets: Preset[]; current: string; save: (p: Record<string, unknown>, m?: string) => void }) {
  const ids = Array.from(new Set([...(spend?.providers || []).map(p => p.id), ...Object.keys(caps).filter(k => caps[k] > 0), ...(current ? [current] : [])]));
  const name = (id: string) => presets.find(p => p.id === id)?.name || spend?.providers.find(p => p.id === id)?.name || id;
  return (
    <div className="col gap-8">
      <div className="row"><span className="label grow">Spend this month</span>{spend && <span className="small num">≈ {usd(spend.totalUsd)} (estimate)</span>}</div>
      <div className="tiny muted">An estimate from token counts and a small price table. When a cap is reached, the agent pauses with a message until you raise it or the month ends.</div>
      {!ids.length ? <div className="small muted">Nothing used yet this month.</div> : (
        <div className="list">
          {ids.map(id => {
            const row = spend?.providers.find(p => p.id === id);
            return <CapRow key={id} name={name(id)} row={row} cap={caps[id] || 0} onSave={v => save({ chat: { caps: { [id]: v } } }, v ? `Cap set: $${v} a month` : "Cap removed")} />;
          })}
        </div>
      )}
    </div>
  );
}

function CapRow({ name, row, cap, onSave }: { name: string; row?: Spend["providers"][number]; cap: number; onSave: (v: number) => void }) {
  const [v, setV] = useState(String(cap));
  useEffect(() => setV(String(cap)), [cap]);
  return (
    <div className="item">
      <div className="grow">
        <div>{name}</div>
        <div className="tiny muted">
          {row ? `≈ ${usd(row.usd)} (estimate) · ${tokens(row.input)} in, ${tokens(row.output)} out · ${row.calls} call${row.calls === 1 ? "" : "s"}${row.unpriced ? ` · ${row.unpriced} without a known price` : ""}` : "Nothing used yet"}
          {cap > 0 && row ? ` · ${Math.min(100, Math.round((row.usd / cap) * 100))}% of the cap` : ""}
        </div>
      </div>
      <span className="tiny muted nowrap">Cap $</span>
      <input className="input num" style={{ width: 90 }} type="number" min={0} step={1} value={v} onChange={e => setV(e.target.value)} aria-label={`${name} monthly cap in dollars`} />
      <button className="btn sm" disabled={Number(v) === cap || !(Number(v) >= 0)} onClick={() => onSave(Number(v))}>Save</button>
    </div>
  );
}
