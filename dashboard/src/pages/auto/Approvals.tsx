// Approvals: everything waiting for your answer, from chat questions to posts and trades tasks want to make.
// The same items show up in Telegram when it's paired; whoever answers first wins. Social drafts and media
// requests also have their own page under Socials → Approvals.
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, errText } from "../../lib";
import { PageHead, useToast } from "../../ui";
import { fmtTime, KIND, SOURCE, useAutoEvents, type Approval } from "./auto";

const DONE: Record<string, string> = { answered: "Answered", denied: "Denied", done: "Done", failed: "Failed", expired: "Expired", canceled: "Canceled" };
const tone = (s: string) => (s === "done" || s === "answered" ? "ok" : s === "failed" ? "bad" : s === "denied" || s === "expired" || s === "canceled" ? "" : "brand");

export default function Approvals() {
  const [items, setItems] = useState<Approval[] | null>(null);
  const load = useCallback(() => api<{ items: Approval[] }>("/api/approvals").then(r => setItems(r.items)).catch(() => setItems([])), []);
  useEffect(() => { load(); }, [load]);
  useAutoEvents(e => { if (e.topic === "approval") load(); });
  const open = (items || []).filter(x => x.status === "pending" || x.status === "confirm");
  const past = (items || []).filter(x => x.status !== "pending" && x.status !== "confirm").slice(0, 40);
  return (
    <>
      <PageHead title="Approvals" sub="What your agent, tasks and watchers want to do and need your yes for. Items expire after 24 hours." />
      <div className="col gap-16">
        {items && !open.length && <div className="card"><div className="empty">Nothing waiting for you. Social drafts and media requests are under <Link to="/socials">Socials → Approvals</Link>.</div></div>}
        {open.map(x => <Item key={x.id} x={x} onDone={load} />)}
        {past.length > 0 && (
          <details className="more card">
            <summary>Earlier ({past.length})</summary>
            <div className="list mt-8">
              {past.map(x => (
                <div key={x.id} className="item">
                  <span className={`badge ${tone(x.status)}`}>{DONE[x.status] || x.status}</span>
                  <span className="grow small trunc">{KIND[x.kind]}: {x.kind === "thread_post" ? x.detail?.content : x.question}{x.answer ? ` → ${x.answer.custom || x.answer.answers.join(", ")} (${x.answer.by})` : ""}{x.result ? ` · ${x.result}` : ""}</span>
                  <span className="tiny muted nowrap hide-phone">{fmtTime(x.createdAt)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>
    </>
  );
}

function Item({ x, onDone }: { x: Approval; onDone: () => void }) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [custom, setCustom] = useState("");
  const run = async (fn: () => Promise<{ item: Approval }>) => {
    setBusy(true);
    try { const r = await fn(); if (r.item.status === "failed") toast(r.item.result || "It failed.", "bad"); else toast(r.item.status === "confirm" ? "Dry run ready: check the numbers" : "Done", "ok"); onDone(); } catch (e) { toast(errText(e), "bad"); onDone(); }
    setBusy(false);
  };
  const answer = (answers: string[], c?: string) => run(() => api(`/api/approvals/${x.id}/answer`, { body: { answers, custom: c } }));
  const d = x.detail || {};
  return (
    <div className="card">
      <div className="row wrap gap-4">
        <span className="badge brand">{KIND[x.kind]}</span>
        <span className="badge">{SOURCE[x.source] || x.source}</span>
        {x.origin !== "user" && <span className="badge copper" title="This came from a run that read other people's words">Outside content</span>}
        <span className="tiny muted right">Expires {fmtTime(x.expiresAt)}</span>
      </div>
      {x.kind === "question" && <div className="mt-12">{x.question}</div>}
      {x.kind === "question" && d.kind === "post" && <div className="card tight flat mt-8 small" style={{ whiteSpace: "pre-wrap" }}>#{d.room}: {d.content}</div>}
      {x.kind === "thread_post" && <><div className="small soft mt-12">Post in #{d.room}:</div><div className="card tight flat mt-4" style={{ whiteSpace: "pre-wrap" }}>{d.content}</div></>}
      {x.kind === "social_post" && <><div className="small soft mt-12">Publish on {(d.targets || []).length || "your"} account{(d.targets || []).length === 1 ? "" : "s"}:</div><div className="card tight flat mt-4" style={{ whiteSpace: "pre-wrap" }}>{d.text}</div><div className="tiny muted mt-4">Previews and edits: <Link to="/socials">Socials → Approvals</Link>. Your banned phrases and daily caps are checked again when it goes out.</div></>}
      {x.kind === "trade" && (
        <div className="mt-12">
          <div>{x.question}</div>
          {d.reason && <div className="small soft mt-4">Why: {d.reason}</div>}
          {x.status === "confirm" && <pre className="code mt-8">{x.previewText}</pre>}
          {x.status === "pending" && <div className="tiny muted mt-4">Reviewing runs a dry run with your wallet and shows the numbers. Nothing is sent until you confirm.</div>}
        </div>
      )}
      <div className="row wrap mt-16">
        {x.status === "confirm" ? (
          <>
            <button className="btn primary" disabled={busy || x.preview?.liveTrading === false || x.preview?.simulation?.ok !== true} onClick={() => run(() => api(`/api/approvals/${x.id}/confirm`, { body: {} }))}>Confirm trade</button>
            <button className="btn ghost" disabled={busy} onClick={() => run(() => api(`/api/approvals/${x.id}/cancel`, { body: {} }))}>Cancel</button>
          </>
        ) : (
          <>
            {x.options.map((o, i) => <button key={o} className={`btn${i === 0 ? " primary" : ""}`} disabled={busy} onClick={() => answer([o])}>{o}</button>)}
            {x.allowCustom && (
              <span className="row grow" style={{ minWidth: 220 }}>
                <input className="input" placeholder={x.options.length ? "Or write an answer" : "Your answer"} value={custom} onChange={e => setCustom(e.target.value)} onKeyDown={e => e.key === "Enter" && custom.trim() && answer([], custom.trim())} />
                <button className="btn" disabled={busy || !custom.trim()} onClick={() => answer([], custom.trim())}>Send</button>
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}
