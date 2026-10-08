// Approvals: everything waiting for you. Media the agent, MCP apps or campaigns asked for, and posts to approve.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errText } from "../../lib";
import { Field, Modal, useToast } from "../../ui";
import { fmtDate, fromLocalInput, KIND_LABEL, money, toLocalInput, useStudioEvents, when, type Job, type MediaKind, type MediaRequest, type Post, type Preview } from "../../studio";
import { Badge, DryRunView, JobRow, MediaView } from "../../studio-ui";
import { useSocial } from "./ctx";

const SOURCE: Record<string, string> = { agent: "From your agent", mcp: "From an MCP app", campaign: "From a campaign" };

export default function Approvals() {
  const s = useSocial();
  const [posts, setPosts] = useState<Post[] | null>(null);
  const [reqs, setReqs] = useState<MediaRequest[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const load = () => {
    api<{ posts: Post[] }>("/api/social/posts?limit=500").then(r => setPosts(r.posts)).catch(() => setPosts([]));
    api<{ requests: MediaRequest[] }>("/api/studio/requests").then(r => setReqs(r.requests)).catch(() => setReqs([]));
    api<{ jobs: Job[] }>("/api/studio/jobs?status=needs_approval").then(r => setJobs(r.jobs)).catch(() => setJobs([]));
  };
  useEffect(load, []);
  useStudioEvents(e => { if (["post", "request", "job"].includes(e.topic)) load(); });

  const pendingReqs = reqs.filter(r => r.status === "pending");
  const waiting = (posts || []).filter(p => p.status === "pending_approval");
  const drafts = (posts || []).filter(p => p.status === "draft");
  const next = (posts || []).filter(p => p.status === "approved" || p.status === "scheduled").sort((a, b) => (a.input.scheduleAt || 0) - (b.input.scheduleAt || 0));
  const nothing = !pendingReqs.length && !jobs.length && !waiting.length;

  return (
    <div className="col gap-16">
      {!s.accounts.length && <div className="note brand">No accounts connected yet. <Link to="/socials/connections">Connect one</Link> so drafts have somewhere to go.</div>}
      {nothing && posts && <div className="card"><div className="empty">Nothing waiting for you. Drafts from your agent, MCP apps and campaigns show up here. <Link to="/socials/compose">Write a post</Link></div></div>}

      {(pendingReqs.length > 0 || jobs.length > 0) && (
        <div className="card">
          <div className="card-head"><h2>Media to approve</h2><p>Nothing is made or paid for until you say yes.</p></div>
          <div className="list">
            {pendingReqs.map(r => <RequestRow key={r.id} r={r} onDone={load} />)}
            {jobs.map(j => <JobRow key={j.id} j={j} onChange={load} />)}
          </div>
        </div>
      )}

      {waiting.length > 0 && (
        <div className="col gap-12">
          <h2 style={{ fontSize: 15.5 }}>Posts waiting for you ({waiting.length})</h2>
          {waiting.map(p => <PostCard key={p.id} p={p} onDone={load} />)}
        </div>
      )}

      {next.length > 0 && (
        <div className="card">
          <div className="card-head"><h2 className="grow">Up next</h2><Link className="small" to="/socials/calendar">Calendar</Link></div>
          <div className="list">
            {next.slice(0, 10).map(p => (
              <div key={p.id} className="item">
                <Badge status={p.status} />
                <span className="grow small trunc">{p.input.text}</span>
                <span className="tiny muted nowrap">{p.input.scheduleAt ? `${fmtDate(p.input.scheduleAt)} (${when(p.input.scheduleAt)})` : "now"}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {drafts.length > 0 && (
        <details className="more card">
          <summary>Unsent drafts ({drafts.length})</summary>
          <div className="list mt-8">{drafts.map(p => <DraftRow key={p.id} p={p} onDone={load} />)}</div>
        </details>
      )}
    </div>
  );
}

function RequestRow({ r, onDone }: { r: MediaRequest; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const act = async (a: "approve" | "reject") => {
    setBusy(true);
    try { await api(`/api/studio/requests/${r.id}/${a}`, { body: {} }); toast(a === "approve" ? "Approved: making it now" : "Rejected", a === "approve" ? "ok" : undefined); onDone(); } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  return (
    <div className="item" style={{ alignItems: "flex-start" }}>
      <div className="grow">
        <div className="row wrap gap-4"><span className="badge brand">{KIND_LABEL[r.request.kind as MediaKind] || r.request.kind}</span><span className="badge">{SOURCE[r.source] || r.source}</span>{r.request.brand && <span className="badge">Brand kit</span>}</div>
        <div className="small mt-4 break">{r.request.prompt || r.request.text}</div>
        {r.note && <div className="tiny muted mt-4">{r.note}</div>}
        <div className="tiny muted mt-4">{r.request.model || "Default model"} · about <span className="num">{money(r.estimate?.usd)}</span>{r.estimate?.basis ? ` (${r.estimate.basis})` : ""}</div>
      </div>
      <div className="col gap-4" style={{ alignItems: "stretch" }}>
        <button className="btn primary sm" disabled={busy} onClick={() => act("approve")}>Approve {money(r.estimate?.usd)}</button>
        <button className="btn ghost sm" disabled={busy} onClick={() => act("reject")}>Reject</button>
      </div>
    </div>
  );
}

function PostCard({ p, onDone }: { p: Post; onDone: () => void }) {
  const s = useSocial();
  const toast = useToast();
  const [pv, setPv] = useState<Preview[] | null>(null);
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(p.input.text);
  const [at, setAt] = useState(toLocalInput(p.input.scheduleAt));
  const [sched, setSched] = useState(false);
  const [dry, setDry] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { api<{ previews: Preview[] }>(`/api/social/posts/${p.id}/preview`).then(r => setPv(r.previews)).catch(e => toast(errText(e), "bad")); }, [p.updatedAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const blocked = (pv || []).filter(x => x.blocked);
  const future = p.input.scheduleAt && p.input.scheduleAt > Date.now() + 30_000;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try { await fn(); toast(ok, "ok"); onDone(); } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const approve = (body: Record<string, unknown>, ok: string) => run(() => api(`/api/social/posts/${p.id}/approve`, { body }), ok);

  return (
    <div className="card">
      <div className="row wrap gap-4">
        <Badge status={p.status} />
        {p.input.targets.map(t => <span key={t.account} className="badge">{s.accountLabel(t.account)}</span>)}
        <span className="tiny muted right">{future ? `Goes out ${fmtDate(p.input.scheduleAt)} (${when(p.input.scheduleAt)})` : "Goes out when you approve"}</span>
      </div>
      <div className="mt-12" style={{ whiteSpace: "pre-wrap" }}>{p.input.text}</div>
      {!!p.input.media?.length && <div className="thumbs mt-12">{p.input.media.map(m => <div key={m.path} className="thumb"><MediaView path={m.path} mime={m.mime} /></div>)}</div>}
      {pv && (
        <details className="more mt-12">
          <summary>{pv.length} preview{pv.length === 1 ? "" : "s"}{blocked.length ? `, ${blocked.length} blocked` : ""}{pv.some(x => x.costUsd) ? `, X cost ${money(pv.reduce((n, x) => n + (x.costUsd || 0), 0))}` : ""}</summary>
          <div className="grid two mt-8">
            {pv.map(x => (
              <div key={x.account} className={`preview${x.blocked ? " blocked" : ""}`}>
                <div className="row"><strong className="small">{s.netName(x.network)}</strong><span className="tiny muted num right">{x.chars} chars</span></div>
                <div className="body small">{x.text}</div>
                {x.warnings.map((w, i) => <div key={i} className="note warn small">{w}</div>)}
                {x.blocked && <div className="note bad small">Blocked: {x.blocked}</div>}
              </div>
            ))}
          </div>
        </details>
      )}
      {blocked.length > 0 && <div className="note bad small mt-12">This can't be approved until it's fixed: {blocked.map(b => `${s.netName(b.network)}: ${b.blocked}`).join(" ")}</div>}
      <div className="row wrap mt-16">
        {future
          ? <button className="btn primary" disabled={busy || blocked.length > 0} onClick={() => approve({}, "Approved and scheduled")}>Approve for {fmtDate(p.input.scheduleAt)}</button>
          : <button className="btn primary" disabled={busy || blocked.length > 0 || s.killSwitch.posting} onClick={() => approve({ publishNow: true }, "Approved and published")}>Approve and publish</button>}
        <button className="btn" disabled={busy || blocked.length > 0} onClick={() => setSched(true)}>Schedule…</button>
        <button className="btn ghost" disabled={busy} onClick={() => setEdit(true)}>Edit</button>
        <button className="btn ghost" disabled={busy} onClick={async () => { try { setDry(await api(`/api/social/posts/${p.id}/publish`, { body: { dryRun: true } })); } catch (e) { toast(errText(e), "bad"); } }}>Dry run</button>
        <button className="btn danger right" disabled={busy} onClick={() => { const why = prompt("Reject this post? Optional: why (the agent sees this).") ; if (why !== null) run(() => api(`/api/social/posts/${p.id}/reject`, { body: { why } }), "Rejected"); }}>Reject</button>
      </div>
      {edit && (
        <Modal title="Edit post" onClose={() => setEdit(false)}>
          <div className="fields">
            <textarea className="textarea" style={{ minHeight: 160 }} value={text} onChange={e => setText(e.target.value)} />
            <Field label="Publish at"><input className="input" type="datetime-local" value={at} onChange={e => setAt(e.target.value)} /></Field>
            <p className="tiny muted">Per-network versions and media can be changed in the composer. It stays in Approvals.</p>
          </div>
          <div className="row mt-16"><button className="btn ghost" onClick={() => setEdit(false)}>Cancel</button><button className="btn primary grow" onClick={() => { setEdit(false); run(() => api(`/api/social/posts/${p.id}`, { body: { input: { text, scheduleAt: fromLocalInput(at) ?? null } } }), "Saved"); }}>Save</button></div>
        </Modal>
      )}
      {sched && (
        <Modal title="Approve and schedule" onClose={() => setSched(false)}>
          <Field label="Publish at"><input className="input" type="datetime-local" value={at} min={toLocalInput(Date.now())} onChange={e => setAt(e.target.value)} /></Field>
          <p className="tiny muted mt-8">It goes out while Claudia Local is running and unlocked. The kill switch holds it back.</p>
          <div className="row mt-16"><button className="btn ghost" onClick={() => setSched(false)}>Cancel</button><button className="btn primary grow" disabled={!at || (fromLocalInput(at) || 0) < Date.now()} onClick={() => { setSched(false); approve({ at: fromLocalInput(at) }, "Approved and scheduled"); }}>Approve for {at ? fmtDate(fromLocalInput(at)) : "…"}</button></div>
        </Modal>
      )}
      {dry && <Modal title="Dry run: what would be sent" onClose={() => setDry(null)} wide><DryRunView data={dry} /></Modal>}
    </div>
  );
}

function DraftRow({ p, onDone }: { p: Post; onDone: () => void }) {
  const toast = useToast();
  const act = async (a: "submit" | "reject") => { try { await api(`/api/social/posts/${p.id}/${a}`, { body: {} }); onDone(); } catch (e) { toast(errText(e), "bad"); } };
  return (
    <div className="item">
      <span className="grow small trunc">{p.input.text || "(no text)"}</span>
      <span className="tiny muted nowrap hide-phone">{fmtDate(p.updatedAt)}</span>
      <button className="btn sm" onClick={() => act("submit")}>Send to Approvals</button>
      <button className="btn ghost sm" onClick={() => act("reject")}>Discard</button>
    </div>
  );
}
