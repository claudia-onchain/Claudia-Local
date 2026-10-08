// UI pieces shared by Generate, Socials, the brand kit and Settings.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { api, errText } from "./lib";
import { Modal, useToast } from "./ui";
import { fileUrl, isAudio, isImage, isVideo, money, statusTone, STATUS_LABEL, KIND_LABEL, upload, useStudioEvents, type Job, type Limits, type PkgStatus, type Spend } from "./studio";

/** Shown instead of a page when its package isn't installed. */
export function NotInstalled({ pkg, what }: { pkg: PkgStatus; what: string }) {
  return (
    <div className="card">
      <div className="card-head"><h2>{what} isn't set up yet</h2></div>
      <p className="soft">This part of Claudia Local runs on <span className="mono">{pkg.package}</span>, which isn't installed in this copy of the app{pkg.error && pkg.error !== "Not installed." ? ` (${pkg.error})` : ""}.</p>
      <p className="small muted mt-8">In the Claudia Local folder, run:</p>
      <pre className="code mt-8">{pkg.install || `npm install ${pkg.package}`}{"\n"}npm start</pre>
      <p className="small muted mt-8">Developers: point <span className="mono">CLAUDIA_LOCAL_{pkg.package.endsWith("media") ? "MEDIA" : "SOCIAL"}_PKG</span> at a local build to try your own version.</p>
    </div>
  );
}

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${statusTone(status)}`}>{STATUS_LABEL[status] || status}</span>;
}

/** Image, video or audio preview of a library file. */
export function MediaView({ path, mime, big }: { path: string; mime?: string; big?: boolean }) {
  const src = fileUrl(path);
  if (isImage(mime, path)) return <img className={big ? "viewer" : undefined} src={src} alt="" loading="lazy" />;
  if (isVideo(mime, path)) return <video className={big ? "viewer" : undefined} src={src} controls={big} muted={!big} playsInline preload="metadata" />;
  if (isAudio(mime, path)) return big ? <audio src={src} controls style={{ width: "100%" }} /> : <span>Audio</span>;
  return <span>File</span>;
}

/** Spending today and this month against the caps. */
export function SpendMeter({ spend, limits }: { spend: Spend | null; limits: Limits | null }) {
  const row = (label: string, v: number, cap: number) => {
    const pct = cap > 0 ? Math.min(100, (v / cap) * 100) : 0;
    return (
      <div className="col gap-4">
        <div className="row small"><span className="soft">{label}</span><span className="right num">{money(v)} <span className="muted">of {cap > 0 ? money(cap) : "no cap"}</span></span></div>
        <div className={`meter${pct >= 100 ? " bad" : pct >= 80 ? " warn" : ""}`}><span style={{ width: `${pct}%` }} /></div>
      </div>
    );
  };
  return (
    <div className="col gap-12">
      {row("Today", spend?.today ?? 0, limits?.perDayUsd ?? 0)}
      {row("This month", spend?.month ?? 0, limits?.perMonthUsd ?? 0)}
      <div className="tiny muted">Jobs over {money(limits?.approveAboveUsd ?? 0)} wait for your OK. Single jobs are capped at {limits?.perJobUsd ? money(limits.perJobUsd) : "no limit"}. You pay your providers directly.</div>
    </div>
  );
}

/** One media job with progress and the approve / cancel buttons. */
export function JobRow({ j, onChange, onOpen }: { j: Job; onChange?: (j: Job) => void; onOpen?: (j: Job) => void }) {
  const toast = useToast();
  const act = async (a: "approve" | "cancel") => {
    try { const r = await api<Job>(`/api/studio/jobs/${encodeURIComponent(j.id)}/${a}`, { body: {} }); onChange?.(r); } catch (e) { toast(errText(e), "bad"); }
  };
  const live = ["queued", "running", "downloading"].includes(j.status);
  const out = j.outputs?.[0];
  return (
    <div className="item" style={{ alignItems: "flex-start" }}>
      <button className="thumb" style={{ cursor: out ? "pointer" : "default" }} onClick={() => out && onOpen?.(j)} aria-label="Open">
        {out ? <MediaView path={out.path} mime={out.mime} /> : <span>{KIND_LABEL[j.request?.kind as keyof typeof KIND_LABEL] || "Media"}</span>}
      </button>
      <div className="grow">
        <div className="row wrap gap-4"><Badge status={j.status} /><span className="tiny muted mono trunc">{j.model}</span></div>
        <div className="small soft mt-4 break" style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{j.request?.prompt || j.request?.text}</div>
        <div className="tiny muted mt-4">{j.provenance?.costUsd !== undefined ? `Cost ${money(j.provenance.costUsd)}` : `About ${money(j.estimate?.usd)}`}</div>
        {live && <div className="progress"><span style={{ width: `${Math.round((j.progress ?? 0.05) * 100)}%` }} /></div>}
        {j.error && <div className="tiny error mt-4">{j.error.message}{j.error.hint ? ` ${j.error.hint}` : ""}</div>}
        {(j.status === "needs_approval" || live) && (
          <div className="row mt-8">
            {j.status === "needs_approval" && <button className="btn primary sm" onClick={() => act("approve")}>Approve {money(j.estimate?.usd)}</button>}
            <button className="btn ghost sm" onClick={() => act("cancel")}>Cancel</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Live list of jobs (updates from the server's job events). */
export function useJobs(limit = 100) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const load = () => api<{ jobs: Job[] }>(`/api/studio/jobs?limit=${limit}`).then(r => setJobs(r.jobs)).catch(() => setJobs([]));
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useStudioEvents(e => {
    if (e.topic !== "job") return;
    setJobs(list => { const l = list || []; const i = l.findIndex(x => x.id === e.data.id); if (i < 0) return [e.data, ...l]; const c = [...l]; c[i] = { ...c[i], ...e.data }; return c; });
  });
  const upsert = (j: Job) => setJobs(l => { const x = l || []; const i = x.findIndex(y => y.id === j.id); if (i < 0) return [j, ...x]; const c = [...x]; c[i] = j; return c; });
  return { jobs, reload: load, upsert };
}

/** Exact request a dry run would send, secrets shown as ***. */
export function DryRunView({ data }: { data: any }) {
  const reqs = data?.requests || (data?.request ? [data.request] : []);
  return (
    <div className="col gap-8">
      <p className="small soft">Nothing was sent. This is exactly what Claudia Local would send{reqs.length > 1 ? ` (${reqs.length} requests)` : ""}, with secrets replaced by ***.</p>
      {data?.estimate && <div className="small">Estimate: <strong className="num">{money(data.estimate.usd)}</strong> <span className="muted">({data.estimate.basis}, {data.estimate.confidence})</span></div>}
      {reqs.map((r: any, i: number) => <pre key={i} className="code">{`${r.method} ${r.url}\n${Object.entries(r.headers || {}).map(([k, v]) => `${k}: ${v}`).join("\n")}${r.body !== undefined ? "\n\n" + (typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2)) : ""}`}</pre>)}
    </div>
  );
}

/** Drag-and-drop or click to upload. Calls onFiles with the saved files. */
export function Dropzone({ onDone, accept = "image/*,video/*,audio/*", to, label = "Drop files here or click to add", multiple = true }: { onDone: (f: { path: string; mime: string }[]) => void; accept?: string; to?: "brand"; label?: ReactNode; multiple?: boolean }) {
  const toast = useToast();
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const take = async (list: FileList | null) => {
    const files = Array.from(list || []).slice(0, 8);
    if (!files.length) return;
    setBusy(true);
    const out: { path: string; mime: string }[] = [];
    for (const f of files) { try { out.push(await upload(f, to)); } catch (e) { toast(`${f.name}: ${errText(e)}`, "bad"); } }
    setBusy(false);
    if (out.length) onDone(out);
  };
  return (
    <div className={`drop${over ? " on" : ""}`} role="button" tabIndex={0} onClick={() => ref.current?.click()} onKeyDown={e => (e.key === "Enter" || e.key === " ") && ref.current?.click()}
      onDragOver={e => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={e => { e.preventDefault(); setOver(false); take(e.dataTransfer.files); }}>
      {busy ? "Uploading…" : label}
      <input ref={ref} type="file" hidden accept={accept} multiple={multiple} onChange={e => { take(e.target.files); e.target.value = ""; }} />
    </div>
  );
}

/** Pick finished files from the library. */
export function LibraryPicker({ onPick, onClose, kinds }: { onPick: (o: { path: string; mime: string }) => void; onClose: () => void; kinds?: string[] }) {
  const { jobs } = useJobs(300);
  const outs = (jobs || []).filter(j => j.status === "succeeded" && (!kinds || kinds.includes(j.request?.kind))).flatMap(j => j.outputs.map(o => ({ ...o, job: j })));
  return (
    <Modal title="Pick from the library" onClose={onClose} wide>
      {!outs.length && <div className="empty">Nothing in the library yet. Make something on the Generate page.</div>}
      <div className="gallery">
        {outs.map(o => (
          <button key={o.path} className="tile" onClick={() => { onPick({ path: o.path, mime: o.mime }); onClose(); }}>
            <div className="media"><MediaView path={o.path} mime={o.mime} /></div>
            <div className="cap"><span className="tiny muted trunc">{o.job.model}</span></div>
          </button>
        ))}
      </div>
    </Modal>
  );
}
