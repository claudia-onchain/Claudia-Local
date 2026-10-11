// Generate: images, video, speech and music, avatars, with your own provider keys. Library and spending.
import { useEffect, useMemo, useState } from "react";
import { Link, NavLink, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { api, errText } from "../lib";
import { Field, Modal, PageHead, Switch, useAsync, useToast } from "../ui";
import { fmtDate, KIND_LABEL, money, useStudioEvents, type Estimate, type Job, type Limits, type MediaKind, type ModelInfo, type Spend, type StudioStatus } from "../studio";
import { DryRunView, Dropzone, JobRow, MediaView, NotInstalled, SpendMeter, useJobs } from "../studio-ui";

export default function Generate() {
  const st = useAsync(() => api<StudioStatus>("/api/studio/status"));
  return (
    <>
      <PageHead title="Generate" sub="Images, video, voice, music and avatars for Claudia, made with your own provider keys. You pay each provider directly; your caps keep it in check." />
      <nav className="tabs">
        <NavLink to="/generate" end>Create</NavLink>
        <NavLink to="/generate/library">Library</NavLink>
        <NavLink to="/generate/spending">Spending and caps</NavLink>
      </nav>
      {st.data && !st.data.media.installed ? <NotInstalled pkg={st.data.media} what="The media studio" /> : st.data ? (
        <Routes>
          <Route index element={<Create />} />
          <Route path="library" element={<Library />} />
          <Route path="spending" element={<Spending />} />
        </Routes>
      ) : st.error ? <div className="note bad">{st.error}</div> : null}
    </>
  );
}

// ── create ─────────────────────────────────────────────────────────────────
type Tab = "image" | "video" | "audio" | "avatar";
const TABS: [Tab, string][] = [["image", "Image"], ["video", "Video"], ["audio", "Speech and music"], ["avatar", "Avatar"]];
const ASPECTS = ["1:1", "16:9", "9:16", "4:5", "3:2", "2:3"];

function useSpend() {
  const s = useAsync(() => api<{ spend: Spend; limits: Limits }>("/api/studio/spend"));
  useStudioEvents(e => { if (e.topic === "job" && ["succeeded", "failed"].includes(e.data.status)) s.reload(); });
  return s;
}

function Create() {
  const toast = useToast();
  const [params] = useSearchParams();
  const [tab, setTab] = useState<Tab>("image");
  const [audio, setAudio] = useState<"speech" | "music" | "sfx">("speech");
  const kind: MediaKind = tab === "audio" ? audio : tab;
  const models = useAsync(() => api<{ models: ModelInfo[] }>(`/api/studio/models?kind=${kind}`), [kind]);
  const list = (models.data?.models || []).filter(m => !m.retired);
  const [modelId, setModelId] = useState("");
  const model = list.find(m => m.id === modelId) || list[0];
  useEffect(() => { setModelId(""); }, [kind]);

  const [prompt, setPrompt] = useState("");
  const [negative, setNegative] = useState("");
  const [text, setText] = useState("");
  const [voice, setVoice] = useState("");
  const [aspect, setAspect] = useState("1:1");
  const [duration, setDuration] = useState("");
  const [resolution, setResolution] = useState("");
  const [n, setN] = useState(1);
  const [brand, setBrand] = useState(true);
  const [refs, setRefs] = useState<{ path: string; mime: string }[]>(() => (params.get("ref") ? [{ path: params.get("ref")!, mime: "" }] : []));
  const [est, setEst] = useState<Estimate | null>(null);
  const [estErr, setEstErr] = useState("");
  const [dry, setDry] = useState<any>(null);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const spend = useSpend();
  const { jobs, upsert } = useJobs(30);

  const caps = model?.caps || {};
  const aspects: string[] = (caps.aspects || caps.aspect || (kind === "image" ? ASPECTS.slice(0, 4) : ["16:9", "9:16"])).filter((a: string) => ASPECTS.includes(a));
  const durations: number[] = caps.durations || caps.durationSec || [];
  const range = Array.isArray(caps.durationRange) ? (caps.durationRange as [number, number]) : null;
  const maxN: number = typeof caps.n === "number" ? caps.n : 4;
  const resolutions: string[] = caps.resolutions || [];
  const maxRefs: number = caps.maxRefs ?? caps.refs ?? (kind === "image" || kind === "video" || kind === "avatar" ? 4 : 0);
  const visual = kind === "image" || kind === "video" || kind === "avatar";
  const spoken = kind === "speech" || kind === "avatar";
  useEffect(() => { if (aspects.length && !aspects.includes(aspect)) setAspect(aspects[0]); }, [model?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDuration(durations.length ? String(durations[0]) : ""); setResolution(resolutions[0] || ""); setN(1); }, [model?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const request = useMemo(() => ({
    kind, model: model?.id, prompt: kind === "speech" ? undefined : prompt || undefined, text: spoken ? text || undefined : undefined,
    negativePrompt: visual && negative ? negative : undefined, voice: spoken && voice ? voice : undefined,
    aspect: visual && aspects.length ? aspect : undefined, durationSec: duration ? Number(duration) : undefined, resolution: resolution || undefined,
    n: kind === "image" ? n : undefined, refs: refs.length ? refs.map(r => r.path) : undefined, brand,
  }), [kind, model?.id, prompt, text, negative, voice, aspect, duration, resolution, n, refs, brand, visual, spoken, aspects.length]);
  const ready = !!model && (kind === "speech" ? !!text.trim() : !!prompt.trim() || (kind === "avatar" && !!text.trim()));

  // Live cost estimate before you submit.
  useEffect(() => {
    if (!model) { setEst(null); return; }
    const t = setTimeout(() => {
      api<Estimate>("/api/studio/estimate", { body: { request: { ...request, prompt: request.prompt || (kind === "speech" ? undefined : "estimate"), text: request.text || (spoken ? text || "estimate" : undefined) } } })
        .then(e => { setEst(e); setEstErr(""); }).catch(e => { setEst(null); setEstErr(errText(e)); });
    }, 350);
    return () => clearTimeout(t);
  }, [request]); // eslint-disable-line react-hooks/exhaustive-deps

  const approveLine = spend.data?.limits.approveAboveUsd ?? 0;
  const needsOk = !!est && est.usd > approveLine;
  const go = async (opts: { dryRun?: boolean; approve?: boolean }) => {
    setBusy(true);
    try {
      const r = await api<any>("/api/studio/generate", { body: { request, ...opts } });
      if (r.dryRun) setDry(r);
      else { upsert(r as Job); toast(r.status === "needs_approval" ? "Waiting for your OK (see the list)" : "Started", "ok"); }
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false); setConfirm(false);
  };

  return (
    <div className="grid side-r">
      <div className="card">
        <div className="seg" role="tablist" aria-label="What to make">
          {TABS.map(([v, l]) => <button key={v} className={tab === v ? "on" : ""} onClick={() => setTab(v)}>{l}</button>)}
        </div>
        {tab === "audio" && (
          <div className="seg mt-12" aria-label="Kind of audio">
            {(["speech", "music", "sfx"] as const).map(v => <button key={v} className={audio === v ? "on" : ""} onClick={() => setAudio(v)}>{KIND_LABEL[v]}</button>)}
          </div>
        )}
        <div className="fields mt-16">
          <Field label="Model" hint={model ? `${model.provider}${model.priceHint ? ` · ${model.priceHint}` : ""}${typeof caps.note === "string" ? ` · ${caps.note}` : ""}` : models.loading ? "Loading…" : "No models for this yet. Add a provider key in Settings."}>
            <select className="select" value={model?.id || ""} onChange={e => setModelId(e.target.value)} disabled={!list.length}>
              {list.map(m => <option key={m.id} value={m.id}>{m.label} ({m.provider}){(m as any).unverified ? " · unverified" : ""}</option>)}
            </select>
          </Field>
          {kind !== "speech" && (
            <Field label={kind === "music" ? "Describe the music" : kind === "sfx" ? "Describe the sound" : kind === "avatar" ? "Scene and look (optional)" : "Prompt"}>
              <textarea className="textarea" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={4000}
                placeholder={kind === "image" ? "Claudia on a rose-pink stage, waving at the crowd" : kind === "video" ? "Claudia turns to the camera and smiles, slow push-in" : kind === "music" ? "Upbeat synth-pop, 100 bpm, no vocals" : kind === "sfx" ? "A soft coin chime" : "Claudia at her desk, warm light"} />
            </Field>
          )}
          {spoken && (
            <Field label={kind === "avatar" ? "What she says" : "Text to speak"} hint={`${text.length} characters`}>
              <textarea className="textarea" value={text} onChange={e => setText(e.target.value)} maxLength={5000} placeholder="gm. Here's what's new on Claudia today…" />
            </Field>
          )}
          {spoken && (
            <Field label="Voice" hint={brand ? "Empty uses the voice from your brand kit. Use your own voice id: ElevenLabs' premade voices stop working on 2026-12-31." : "Your voice id from the provider."}>
              <input className="input mono" value={voice} onChange={e => setVoice(e.target.value)} placeholder={brand ? "Brand kit voice" : "voice id"} />
            </Field>
          )}
          {visual && aspects.length > 0 && (
            <Field label="Shape">
              <div className="seg">{aspects.map(a => <button key={a} className={aspect === a ? "on" : ""} onClick={() => setAspect(a)}>{a}</button>)}</div>
            </Field>
          )}
          {(durations.length > 0 || range || resolutions.length > 0 || kind === "image") && (
            <div className="fields two">
              {range && !durations.length && (
                <Field label="Length (seconds)" hint={`${range[0]}–${range[1]} s`}>
                  <input className="input num" type="number" min={range[0]} max={range[1]} step={0.5} value={duration} placeholder="auto" onChange={e => setDuration(e.target.value)} />
                </Field>
              )}
              {durations.length > 0 && (
                <Field label="Length">
                  <select className="select" value={duration} onChange={e => setDuration(e.target.value)}>{durations.map(d => <option key={d} value={d}>{d} seconds</option>)}</select>
                </Field>
              )}
              {resolutions.length > 0 && (
                <Field label="Resolution">
                  <select className="select" value={resolution} onChange={e => setResolution(e.target.value)}>{resolutions.map(r => <option key={r}>{r}</option>)}</select>
                </Field>
              )}
              {kind === "image" && (
                <Field label="How many">
                  <select className="select" value={n} onChange={e => setN(Number(e.target.value))}>{Array.from({ length: Math.max(1, Math.min(4, maxN)) }, (_, i) => i + 1).map(x => <option key={x} value={x}>{x}</option>)}</select>
                </Field>
              )}
            </div>
          )}
          {maxRefs > 0 && (
            <Field label="References" hint={`Up to ${maxRefs}. Pictures or clips the model should follow.`}>
              {refs.length > 0 && (
                <div className="thumbs">
                  {refs.map(r => <div key={r.path} className="thumb"><MediaView path={r.path} mime={r.mime} /><button className="x" onClick={() => setRefs(x => x.filter(y => y.path !== r.path))}>Remove</button></div>)}
                </div>
              )}
              {refs.length < maxRefs && <Dropzone accept="image/*,video/*" onDone={f => setRefs(x => [...x, ...f].slice(0, maxRefs))} />}
            </Field>
          )}
          {visual && (
            <details className="more">
              <summary>Leave out (negative prompt)</summary>
              <textarea className="textarea mt-8" value={negative} onChange={e => setNegative(e.target.value)} placeholder="text, watermark, extra fingers" />
            </details>
          )}
          <div className="row">
            <Switch checked={brand} onChange={setBrand} label="Use your brand kit" />
            <Link to="/brand" className="small right">Edit brand kit</Link>
          </div>
        </div>
        <hr className="hr" />
        <div className="row wrap">
          <div className="grow">
            {est ? <div><span className="num" style={{ fontSize: 18 }}>{money(est.usd)}</span>{est.low !== undefined && est.high !== undefined && <span className="small muted"> ({money(est.low)}–{money(est.high)})</span>}<div className="tiny muted">{est.confidence === "exact" ? "Exact price" : est.confidence === "list" ? "List price" : "Estimate"} · {est.basis}</div></div>
              : estErr ? <div className="tiny error">{estErr}</div> : <div className="tiny muted">The cost shows here before you make anything.</div>}
          </div>
          <button className="btn" disabled={!ready || busy} onClick={() => go({ dryRun: true })}>Dry run</button>
          <button className="btn primary" disabled={!ready || busy} onClick={() => (needsOk ? setConfirm(true) : go({}))}>{busy ? "Working…" : needsOk ? "Review and make" : "Make it"}</button>
        </div>
        {needsOk && <div className="tiny muted mt-8">Above your {money(approveLine)} approval line, so you'll confirm it first.</div>}
      </div>

      <div className="col gap-16">
        <div className="card">
          <div className="card-head"><h2 className="grow">Spending</h2><Link to="/generate/spending" className="small">Caps</Link></div>
          <SpendMeter spend={spend.data?.spend || null} limits={spend.data?.limits || null} />
        </div>
        <div className="card">
          <div className="card-head"><h2 className="grow">Jobs</h2><Link to="/generate/library" className="small">Library</Link></div>
          {!jobs?.length && <div className="empty">Nothing yet.</div>}
          <div className="list">{(jobs || []).slice(0, 8).map(j => <JobRow key={j.id} j={j} onChange={upsert} />)}</div>
        </div>
      </div>

      {dry && <Modal title="Dry run" onClose={() => setDry(null)} wide><DryRunView data={dry} /></Modal>}
      {confirm && est && (
        <Modal title={`Make this for about ${money(est.usd)}?`} onClose={() => setConfirm(false)}>
          <div className="kv">
            <span>Model</span><span>{model?.label} ({model?.provider})</span>
            <span>Estimate</span><span className="num">{money(est.usd)} <span className="muted">({est.basis})</span></span>
            <span>Today so far</span><span className="num">{money(spend.data?.spend.today)} of {spend.data?.limits.perDayUsd ? money(spend.data.limits.perDayUsd) : "no cap"}</span>
          </div>
          <p className="small muted mt-12">Your provider bills your account. The caps still apply.</p>
          <div className="row mt-16"><button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary grow" disabled={busy} onClick={() => go({ approve: true })}>Make it</button></div>
        </Modal>
      )}
    </div>
  );
}

// ── library ────────────────────────────────────────────────────────────────
function Library() {
  const nav = useNavigate();
  const { jobs, upsert } = useJobs(500);
  const [kind, setKind] = useState<string>("");
  const [open, setOpen] = useState<{ job: Job; i: number } | null>(null);
  const done = (jobs || []).filter(j => j.status === "succeeded" && j.outputs?.length && (!kind || j.request?.kind === kind || (kind === "audio" && ["speech", "music", "sfx"].includes(j.request?.kind))));
  const other = (jobs || []).filter(j => j.status !== "succeeded");
  const o = open ? open.job.outputs[open.i] : null;
  return (
    <div className="col gap-16">
      <div className="row wrap">
        <div className="seg">{[["", "All"], ["image", "Images"], ["video", "Video"], ["audio", "Audio"], ["avatar", "Avatars"]].map(([v, l]) => <button key={v} className={kind === v ? "on" : ""} onClick={() => setKind(v)}>{l}</button>)}</div>
        <span className="tiny muted right">Saved on this computer under media/library</span>
      </div>
      {!done.length && <div className="card"><div className="empty">Nothing here yet. <Link to="/generate">Make something</Link>.</div></div>}
      <div className="gallery">
        {done.flatMap(j => j.outputs.map((out, i) => (
          <button key={out.path} className="tile" onClick={() => setOpen({ job: j, i })}>
            <div className="media"><MediaView path={out.path} mime={out.mime} /></div>
            <div className="cap"><span className="small trunc">{j.request?.prompt || j.request?.text || KIND_LABEL[j.request?.kind as MediaKind]}</span><span className="tiny muted trunc">{j.model} · {fmtDate(j.updatedAt)}</span></div>
          </button>
        )))}
      </div>
      {other.length > 0 && (
        <div className="card">
          <div className="card-head"><h2>Other jobs</h2></div>
          <div className="list">{other.slice(0, 30).map(j => <JobRow key={j.id} j={j} onChange={upsert} />)}</div>
        </div>
      )}
      {open && o && (
        <Modal title={KIND_LABEL[open.job.request?.kind as MediaKind] || "Media"} onClose={() => setOpen(null)} wide>
          <MediaView path={o.path} mime={o.mime} big />
          <div className="row wrap mt-12">
            <button className="btn primary" onClick={() => nav(`/socials/compose?media=${encodeURIComponent(o.path)}`)}>Use in post</button>
            {(open.job.request?.kind === "image") && <button className="btn" onClick={() => nav(`/generate?ref=${encodeURIComponent(o.path)}`)}>Use as reference</button>}
            <a className="btn ghost" href={`/api/studio/file?path=${encodeURIComponent(o.path)}`} target="_blank" rel="noreferrer">Open file</a>
          </div>
          <div className="label mt-16">Provenance</div>
          <div className="kv mt-8 small">
            <span>Prompt</span><span>{open.job.provenance?.prompt || open.job.request?.prompt || open.job.request?.text || "–"}</span>
            <span>Model</span><span className="mono">{open.job.provenance?.model || open.job.model}</span>
            <span>Provider</span><span>{open.job.provenance?.provider || open.job.provider}</span>
            <span>Cost</span><span className="num">{money(open.job.provenance?.costUsd ?? open.job.estimate?.usd)}{open.job.provenance?.costUsd === undefined ? " (estimate)" : ""}</span>
            <span>Made</span><span>{fmtDate(open.job.provenance?.at || open.job.updatedAt)}</span>
            {open.job.provenance?.watermark && <><span>Watermark</span><span>{open.job.provenance.watermark}</span></>}
            {open.job.provenance?.terms && <><span>Terms</span><span>{open.job.provenance.terms}</span></>}
            {open.job.request?.brand && <><span>Brand kit</span><span>Yes</span></>}
            <span>File</span><span className="mono tiny">{o.mime} · {Math.round(o.bytes / 1024)} KB{o.width ? ` · ${o.width}×${o.height}` : ""}{o.durationSec ? ` · ${o.durationSec} s` : ""}</span>
            <span>SHA-256</span><span className="mono tiny">{o.sha256}</span>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── spending and caps ──────────────────────────────────────────────────────
function Spending() {
  const toast = useToast();
  const spend = useSpend();
  const provs = useAsync(() => api<{ providers: { id: string; name: string; kinds: string[]; configured: boolean; docs: string }[] }>("/api/studio/providers"));
  const st = useAsync(() => api<StudioStatus>("/api/studio/status"));
  const [L, setL] = useState<Record<string, string>>({});
  useEffect(() => { if (spend.data) setL(Object.fromEntries(Object.entries(spend.data.limits).map(([k, v]) => [k, String(v)]))); }, [spend.data?.limits]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch: Record<string, unknown>) => {
    try { await api("/api/studio/settings", { body: patch }); toast("Saved", "ok"); spend.reload(); st.reload(); } catch (e) { toast(errText(e), "bad"); }
  };
  const changed = spend.data && Object.entries(spend.data.limits).some(([k, v]) => String(v) !== L[k]);
  const by = Object.entries(spend.data?.spend.byProvider || {});
  return (
    <div className="grid two">
      <div className="col gap-16">
        <div className="card">
          <div className="card-head"><h2>Spent with your keys</h2></div>
          <SpendMeter spend={spend.data?.spend || null} limits={spend.data?.limits || null} />
          {by.length > 0 && (
            <table className="table mt-16"><thead><tr><th>Provider</th><th className="r">Today</th><th className="r">This month</th></tr></thead>
              <tbody>{by.map(([p, v]) => <tr key={p}><td>{p}</td><td className="r num">{money(v.today)}</td><td className="r num">{money(v.month)}</td></tr>)}</tbody></table>
          )}
          <p className="tiny muted mt-12">Counted from the jobs on this computer. Your provider's own dashboard is the final word.</p>
        </div>
        <div className="card">
          <div className="card-head"><h2>Providers</h2><p>Keys live in Settings, encrypted.</p></div>
          <div className="list">
            {(provs.data?.providers || []).map(p => (
              <div key={p.id} className="item">
                <span className={`dot ${p.configured ? "ok" : ""}`} />
                <div className="grow"><div>{p.name}</div><div className="tiny muted">{p.kinds.map(k => KIND_LABEL[k as MediaKind] || k).join(", ")}</div></div>
                {p.configured ? <span className="badge ok">Key set</span> : <Link className="btn sm" to="/settings#keys">Add key</Link>}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="card">
        <div className="card-head"><h2>Caps</h2><p>In US dollars. 0 means no cap.</p></div>
        <div className="fields">
          <div className="fields two">
            <Field label="Per job"><input className="input num" inputMode="decimal" value={L.perJobUsd ?? ""} onChange={e => setL({ ...L, perJobUsd: e.target.value })} /></Field>
            <Field label="Ask me above" hint="Jobs that cost more wait for your OK."><input className="input num" inputMode="decimal" value={L.approveAboveUsd ?? ""} onChange={e => setL({ ...L, approveAboveUsd: e.target.value })} /></Field>
            <Field label="Per day"><input className="input num" inputMode="decimal" value={L.perDayUsd ?? ""} onChange={e => setL({ ...L, perDayUsd: e.target.value })} /></Field>
            <Field label="Per month"><input className="input num" inputMode="decimal" value={L.perMonthUsd ?? ""} onChange={e => setL({ ...L, perMonthUsd: e.target.value })} /></Field>
          </div>
          <div><button className="btn primary" disabled={!changed} onClick={() => save({ limits: Object.fromEntries(Object.entries(L).map(([k, v]) => [k, Number(v)])) })}>Save caps</button></div>
          <hr className="hr" style={{ margin: "4px 0" }} />
          <div className="row top">
            <div className="grow"><div>Ask me before the agent makes anything</div><div className="small muted">Media your agent, a campaign or an MCP app asks for waits in Socials → Approvals, whatever it costs. Recommended.</div></div>
            <Switch checked={!!st.data?.askBeforeAgentMedia} onChange={v => save({ askBeforeAgentMedia: v })} />
          </div>
        </div>
      </div>
    </div>
  );
}
