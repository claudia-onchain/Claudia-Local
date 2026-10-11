// First-run setup: risk screen → passphrase → chat model → template → connect to Claudia → wallet limits →
// health check. Steps after the passphrase can be skipped and run again later (Settings → Run setup again).
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, errText } from "../../lib";
import { Face, Field, useAsync, useToast } from "../../ui";
import type { AppState } from "../../App";
import ConnectStep from "./ConnectStep";

type Step = "risk" | "pass" | "model" | "template" | "connect" | "limits" | "health";
const ALL: Step[] = ["risk", "pass", "model", "template", "connect", "limits", "health"];

export default function Wizard({ state, onDone, resume }: { state: AppState; onDone: () => void; resume?: boolean }) {
  const steps = useMemo(() => (resume ? ALL.filter(s => s !== "pass") : ALL), [resume]);
  const [i, setI] = useState(0);
  const step = steps[i];
  const next = () => setI(n => Math.min(steps.length - 1, n + 1));
  const back = () => setI(n => Math.max(0, n - 1));
  const finish = async () => { await api("/api/wizard/done", { body: {} }).catch(() => {}); onDone(); };
  const passDone = !resume && i > steps.indexOf("pass");

  return (
    <div className="gate">
      <div className="gate-box" style={{ maxWidth: 560 }}>
        <div className="steps" aria-hidden>{steps.map((s, n) => <span key={s} className={n <= i ? "on" : ""} />)}</div>
        {step === "risk" && <Risk state={state} onNext={next} />}
        {step === "pass" && <Passphrase state={state} onNext={next} />}
        {step === "model" && <ModelStep onNext={next} onBack={passDone ? undefined : back} />}
        {step === "template" && <TemplateStep onNext={next} onBack={back} />}
        {step === "connect" && (
          <Frame title="Connect to Claudia" sub="Optional. Your agent can read Claudia without it; connecting lets it post in the thread and get quotes." onBack={back} onSkip={next} skipLabel="Skip for now">
            <ConnectStep onDone={next} />
          </Frame>
        )}
        {step === "limits" && <LimitsStep onNext={next} onBack={back} />}
        {step === "health" && <HealthStep onFinish={finish} onBack={back} />}
      </div>
    </div>
  );
}

function Frame({ title, sub, children, onBack, onSkip, skipLabel = "Skip", onNext, nextLabel = "Continue", nextDisabled }: {
  title: string; sub?: ReactNode; children: ReactNode; onBack?: () => void; onSkip?: () => void; skipLabel?: string; onNext?: () => void; nextLabel?: string; nextDisabled?: boolean;
}) {
  return (
    <div>
      <div className="hello">
        <Face size={56} />
        <div><h1>{title}</h1>{sub && <p className="soft mt-4">{sub}</p>}</div>
      </div>
      {children}
      {(onBack || onSkip || onNext) && (
        <div className="row mt-24">
          {onBack && <button type="button" className="btn ghost" onClick={onBack}>Back</button>}
          <span className="grow" />
          {onSkip && <button type="button" className="btn" onClick={onSkip}>{skipLabel}</button>}
          {onNext && <button type="button" className="btn primary" disabled={nextDisabled} onClick={onNext}>{nextLabel}</button>}
        </div>
      )}
    </div>
  );
}

// ── 1. risk screen ─────────────────────────────────────────────────────────
function Risk({ state, onNext }: { state: AppState; onNext: () => void }) {
  const [ok, setOk] = useState(false);
  return (
    <Frame title="Claudia Local" sub="Your own agent, running on this computer." onNext={onNext} nextDisabled={!ok}>
      <div className="col gap-12">
        <p className="soft">Before you start, here's what the app can do with the keys and wallet you give it:</p>
        <ul className="small soft" style={{ margin: 0, paddingLeft: 20, display: "grid", gap: 6 }}>
          <li>Use your model keys to think and work. Your providers bill you for what it uses.</li>
          <li>Make images, video and voice with your media keys, within spending caps you set.</li>
          <li>Draft social posts. Nothing publishes until you approve it.</li>
          <li>Read Claudia, and post in the thread as your agent if you connect one. It asks you first.</li>
          <li>Hold an agent wallet (Solana first). Real trades and launches only happen when you confirm them, within your caps. Live trading starts off.</li>
        </ul>
        <div className="note">Everything stays on this computer, in <span className="mono">{state.dataDir}</span>. Keys are encrypted with your passphrase. You can lock the app any time, and it locks itself after 30 idle minutes.</div>
        <label className="row small" style={{ cursor: "pointer" }}>
          <input type="checkbox" checked={ok} onChange={e => setOk(e.target.checked)} />
          I understand what the app can do with my keys and wallet.
        </label>
      </div>
    </Frame>
  );
}

// ── 2. passphrase ──────────────────────────────────────────────────────────
function Passphrase({ state, onNext }: { state: AppState; onNext: () => void }) {
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const ok = pass.length >= 8 && pass === confirm;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ok) return;
    setBusy(true); setErr("");
    try { await api("/api/setup", { body: { passphrase: pass, confirm } }); onNext(); } catch (x) { setErr(errText(x)); }
    setBusy(false);
  };
  return (
    <form onSubmit={submit}>
      <Frame title="Pick a passphrase" sub="It locks your keys and your agent wallet on this computer.">
        <div className="fields">
          <Field label="Passphrase" hint="At least 8 characters. It's never stored and can't be recovered, so keep it somewhere safe.">
            <input className="input" type="password" autoFocus autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)} />
          </Field>
          <Field label="Type it again">
            <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </Field>
        </div>
        {confirm && pass !== confirm && <p className="error mt-8">The two don't match yet.</p>}
        {err && <p className="error mt-8">{err}</p>}
        <button className="btn primary lg block mt-16" disabled={!ok || busy}>{busy ? "Setting up…" : "Continue"}</button>
        <p className="tiny muted mt-12">Data folder: <span className="mono">{state.dataDir}</span></p>
      </Frame>
    </form>
  );
}

// ── 3. chat model ──────────────────────────────────────────────────────────
type Preset = { id: string; name: string; kind: "anthropic" | "openai" | "local"; key: string | null; keyProvider: string | null; keySet: boolean; docs: string; models: { id: string; name: string; recommended?: boolean }[]; running?: boolean; localModels?: { id: string; name: string }[] };
type ModelList = { models: { id: string; name: string; recommended?: boolean }[]; live: boolean; error?: string };
type TestResult = { ok: boolean; issues: string[]; live?: { ok: boolean; message: string; status: number }; note: string };

function ModelStep({ onNext, onBack }: { onNext: () => void; onBack?: () => void }) {
  const toast = useToast();
  const presets = useAsync(() => api<{ presets: Preset[] }>("/api/chat/presets"));
  const [pid, setPid] = useState("");
  const [key, setKey] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [models, setModels] = useState<ModelList | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const list = (presets.data?.presets || []).filter(p => p.id !== "custom" && (p.kind !== "local" || p.running));
  const p = list.find(x => x.id === pid);
  const local = list.filter(x => x.kind === "local");

  const loadModels = async (id: string) => {
    try {
      const r = await api<ModelList>(`/api/models?provider=${id}`);
      setModels(r);
      setModel((r.models.find(m => m.recommended) || r.models[0])?.id || "");
    } catch (e) { toast(errText(e), "bad"); }
  };
  useEffect(() => {
    setTest(null); setModels(null); setKey(""); setModel("");
    if (p && (p.kind === "local" || p.keySet)) loadModels(p.id);
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveKey = async () => {
    if (!p?.key) return;
    setBusy(true); setTest(null);
    try {
      await api(`/api/keys/${p.key}`, { body: { fields: { key: key.trim() } } });
      const t = await api<TestResult>(`/api/keys/${p.key}/test`, { body: { live: true } });
      setTest(t);
      if (t.ok) { setKey(""); await presets.reload(); loadModels(p.id); }
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const use = async () => {
    if (!p || !model) return;
    setBusy(true);
    try { await api("/api/config", { body: { chat: { provider: p.id, models: { [p.id]: model } } } }); toast(`Using ${model}`, "ok"); onNext(); } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const ready = p && (p.kind === "local" || p.keySet || test?.ok);

  return (
    <Frame title="Your chat model" sub="Bring your own key. Claudia Local talks to the provider directly; nothing goes through Claudia." onBack={onBack} onSkip={onNext} skipLabel="Skip for now">
      <div className="fields">
        {local.length > 0 && <div className="note ok small">Found a model server on this computer: {local.map(l => l.name.replace(/ \(.*\)$/, "")).join(" and ")}. It needs no key.</div>}
        <Field label="Provider">
          <select className="select" value={pid} onChange={e => setPid(e.target.value)}>
            <option value="">Pick one</option>
            {list.map(x => <option key={x.id} value={x.id}>{x.name}{x.kind === "local" ? "" : x.keySet ? " (key saved)" : ""}{x.id === "anthropic" ? " · recommended" : ""}</option>)}
          </select>
        </Field>
        {p && p.kind !== "local" && !p.keySet && !test?.ok && (
          <Field label={`${p.keyProvider || p.name} key`} hint={p.docs ? <>Get one at <a href={p.docs} target="_blank" rel="noreferrer">{p.docs.replace(/^https:\/\//, "").replace(/\/$/, "")}</a>. It's encrypted with your passphrase.</> : undefined}>
            <div className="row">
              <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder="Paste your key" value={key} onChange={e => setKey(e.target.value)} />
              <button className="btn primary" disabled={!key.trim() || busy} onClick={saveKey}>{busy ? "Testing…" : "Save and test"}</button>
            </div>
          </Field>
        )}
        {test && (
          <div className="col gap-8">
            {test.issues.map((x, n) => <div key={n} className="note warn small">{x}</div>)}
            {test.live && <div className={`note small ${test.live.ok ? "ok" : "bad"}`}>{test.live.message}{test.live.status ? ` (HTTP ${test.live.status})` : ""}</div>}
            {!test.live && test.note && <div className="small muted">{test.note}</div>}
          </div>
        )}
        {ready && models && (
          <Field label="Model" hint={models.error || (!models.live ? "From the built-in list. You can change it any time in Settings → Chat model." : "You can change it any time in Settings → Chat model.")}>
            <select className="select" value={model} onChange={e => setModel(e.target.value)}>
              {models.models.map(m => <option key={m.id} value={m.id}>{m.name || m.id}{m.recommended ? " (recommended)" : ""}</option>)}
            </select>
          </Field>
        )}
        {ready && <div><button className="btn primary" disabled={!model || busy} onClick={use}>Use this model</button></div>}
      </div>
    </Frame>
  );
}

// ── 4. template (skipped when the templates feature isn't there) ───────────
type Template = { id: string; name: string; summary: string; niches?: { id: string; name: string }[]; skills: string[]; starterTasks: { name: string; prompt: string; schedule: string }[] };

function TemplateStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const toast = useToast();
  const [list, setList] = useState<Template[] | null>(null);
  const [pick, setPick] = useState("");
  const [niche, setNiche] = useState("");
  const [busy, setBusy] = useState(false);
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    api<{ templates: Template[] }>("/api/templates")
      .then(r => { if (!r.templates?.length) onNext(); else setList(r.templates); })
      .catch(e => { if (e instanceof ApiError && e.status === 404) onNext(); else setList([]); });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const t = list?.find(x => x.id === pick);
  const apply = async () => {
    setBusy(true);
    try { await api("/api/templates/apply", { body: { id: pick, ...(niche ? { niche } : {}) } }); setApplied(true); toast("Template applied", "ok"); } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  if (!list) return <p className="muted small">Loading templates…</p>;
  return (
    <Frame title="Start from a template" sub="A persona, skills and starter tasks for what you want your agent to do. Starter tasks start paused." onBack={onBack} onSkip={applied ? undefined : onNext} onNext={applied ? onNext : undefined}>
      {!list.length ? <p className="muted small">No templates right now.</p> : (
        <div className="list">
          {list.map(x => (
            <label key={x.id} className="item" style={{ cursor: "pointer", alignItems: "flex-start" }}>
              <input type="radio" name="tpl" checked={pick === x.id} onChange={() => { setPick(x.id); setNiche(""); }} style={{ marginTop: 4 }} />
              <div className="grow">
                <div>{x.name}</div>
                <div className="small muted">{x.summary}</div>
                {pick === x.id && (
                  <div className="col gap-8 mt-8">
                    {(x.niches || []).length > 0 && (
                      <select className="select" value={niche} onChange={e => setNiche(e.target.value)} aria-label="Niche">
                        <option value="">Any niche</option>
                        {x.niches!.map(n => <option key={n.id} value={n.id}>{n.name}</option>)}
                      </select>
                    )}
                    {x.skills.length > 0 && <div className="tiny muted">Skills: {x.skills.join(", ")}</div>}
                    {x.starterTasks.length > 0 && <div className="tiny muted">Starter tasks (paused): {x.starterTasks.map(s => s.name).join(", ")}</div>}
                  </div>
                )}
              </div>
            </label>
          ))}
        </div>
      )}
      {t && !applied && <div className="mt-12"><button className="btn primary" disabled={busy} onClick={apply}>{busy ? "Applying…" : `Use ${t.name}`}</button></div>}
      {applied && <div className="note ok mt-12">Applied. Starter tasks are paused until you switch them on.</div>}
    </Frame>
  );
}

// ── 6. wallet limits (Solana first, then Robinhood Chain) ───────────────────
type Caps = { maxSolPerTrade: number; maxSolPerDay: number; maxEthPerTrade?: number; maxEthPerDay?: number };
const CAP_ROWS: { chain: string; trade: keyof Caps; day: keyof Caps; unit: string }[] = [
  { chain: "Solana", trade: "maxSolPerTrade", day: "maxSolPerDay", unit: "SOL" },
  { chain: "Robinhood Chain (beta)", trade: "maxEthPerTrade", day: "maxEthPerDay", unit: "ETH" },
];

function LimitsStep({ onNext, onBack }: { onNext: () => void; onBack: () => void }) {
  const toast = useToast();
  const st = useAsync(() => api<{ caps: Caps; liveTrading: boolean }>("/api/claudia/status"));
  const caps = st.data?.caps;
  const rows = CAP_ROWS.filter(r => caps && typeof caps[r.trade] === "number");
  const [vals, setVals] = useState<Record<string, string>>({});
  useEffect(() => { if (caps) setVals(Object.fromEntries(Object.entries(caps).map(([k, v]) => [k, String(v)]))); }, [JSON.stringify(caps)]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = (k: keyof Caps) => Number(vals[k]);
  const valid = !!caps && rows.every(r => n(r.trade) >= 0 && n(r.day) >= 0 && n(r.trade) <= Number(caps[r.trade]) && n(r.day) <= Number(caps[r.day]) && n(r.trade) <= n(r.day));
  const changed = !!caps && rows.some(r => n(r.trade) !== caps[r.trade] || n(r.day) !== caps[r.day]);
  const save = async () => {
    try { await api("/api/config", { body: { claudia: { caps: { ...caps, ...Object.fromEntries(rows.flatMap(r => [[r.trade, n(r.trade)], [r.day, n(r.day)]])) } } } }); toast("Limits saved", "ok"); onNext(); } catch (e) { toast(errText(e), "bad"); }
  };
  return (
    <Frame title="Wallet limits" sub="Caps for your agent wallets. You can lower them here; raise them later in Claudia → Your agent." onBack={onBack} onSkip={changed ? undefined : onNext} skipLabel="Keep these" onNext={changed ? save : undefined} nextLabel="Save and continue" nextDisabled={!valid}>
      {!caps ? <p className="muted small">Loading…</p> : (
        <div className="fields">
          {rows.map(r => (
            <div key={r.chain}>
              <div className="label">{r.chain}</div>
              <div className="fields two mt-4">
                <Field label={`Most ${r.unit} per trade`} hint={`Now ${caps[r.trade]} ${r.unit}`}><input className="input num" type="number" min={0} max={Number(caps[r.trade])} step={0.01} value={vals[r.trade] ?? ""} onChange={e => setVals({ ...vals, [r.trade]: e.target.value })} /></Field>
                <Field label={`Most ${r.unit} per day`} hint={`Now ${caps[r.day]} ${r.unit}`}><input className="input num" type="number" min={0} max={Number(caps[r.day])} step={0.01} value={vals[r.day] ?? ""} onChange={e => setVals({ ...vals, [r.day]: e.target.value })} /></Field>
              </div>
            </div>
          ))}
          {!valid && <p className="error">Use numbers at or below the current caps, with the per-trade cap no bigger than the daily one.</p>}
          <div className="note small">Live trading is {st.data?.liveTrading ? "on" : "off"}. The agent can only suggest real trades; you confirm each one yourself.</div>
        </div>
      )}
    </Frame>
  );
}

// ── 7. health check ────────────────────────────────────────────────────────
type Check = { id: string; label: string; status: "ok" | "warn" | "bad" | "info"; detail: string; fix?: { id: string; label: string } };

function HealthStep({ onFinish, onBack }: { onFinish: () => void; onBack: () => void }) {
  const r = useAsync(() => api<{ checks: Check[] }>("/api/health/report"));
  const [busy, setBusy] = useState(false);
  return (
    <Frame title="All set" sub="A quick check of this install. The Health page runs it again any time." onBack={onBack}>
      {!r.data ? <p className="muted small">Checking…</p> : (
        <div className="list">
          {r.data.checks.map(c => (
            <div key={c.id} className="item" style={{ alignItems: "flex-start" }}>
              <span className={`dot ${c.status === "ok" ? "ok" : c.status === "warn" ? "warn" : c.status === "bad" ? "bad" : ""}`} style={{ marginTop: 7 }} />
              <div className="grow"><div className="small">{c.label}</div><div className="tiny muted">{c.detail}</div></div>
            </div>
          ))}
        </div>
      )}
      <button className="btn primary lg block mt-16" disabled={busy} onClick={async () => { setBusy(true); onFinish(); }}>Open Claudia Local</button>
    </Frame>
  );
}
