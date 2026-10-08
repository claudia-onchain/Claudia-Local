// Calendar: scheduled, waiting and published posts by week or month. The server runs due posts every 30 s.
import { useEffect, useMemo, useState } from "react";
import { api } from "../../lib";
import { Modal } from "../../ui";
import { fmtDate, statusTone, useStudioEvents, type Post } from "../../studio";
import { Badge, MediaView } from "../../studio-ui";
import { useSocial } from "./ctx";

const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
const startOfWeek = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; };

/** When a post shows on the calendar: its schedule, else when it was published, else when it was last changed. */
const postTime = (p: Post) => p.input.scheduleAt || p.results.find(r => r.at)?.at || p.updatedAt;

export default function Calendar() {
  const s = useSocial();
  const [posts, setPosts] = useState<Post[]>([]);
  const [view, setView] = useState<"week" | "month">(() => (window.innerWidth < 760 ? "week" : "month"));
  const [anchor, setAnchor] = useState(() => new Date());
  const [open, setOpen] = useState<Post | null>(null);
  const load = () => api<{ posts: Post[] }>("/api/social/posts?limit=1000").then(r => setPosts(r.posts.filter(p => !["draft", "canceled"].includes(p.status)))).catch(() => {});
  useEffect(() => { load(); }, []);
  useStudioEvents(e => { if (e.topic === "post") load(); });

  const days = useMemo(() => {
    const first = view === "week" ? startOfWeek(anchor) : startOfWeek(new Date(anchor.getFullYear(), anchor.getMonth(), 1));
    const n = view === "week" ? 7 : 42;
    return Array.from({ length: n }, (_, i) => { const d = new Date(first); d.setDate(first.getDate() + i); return d; });
  }, [view, anchor]);
  const byDay = useMemo(() => {
    const m = new Map<string, Post[]>();
    for (const p of posts) { const k = dayKey(new Date(postTime(p))); m.set(k, [...(m.get(k) || []), p]); }
    for (const l of m.values()) l.sort((a, b) => postTime(a) - postTime(b));
    return m;
  }, [posts]);
  const move = (dir: number) => { const d = new Date(anchor); if (view === "week") d.setDate(d.getDate() + 7 * dir); else d.setMonth(d.getMonth() + dir); setAnchor(d); };
  const today = dayKey(new Date());
  const title = view === "week" ? `Week of ${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : anchor.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  return (
    <div className="col gap-12">
      <div className="row wrap">
        <h2 style={{ fontSize: 17, minWidth: 220 }} className="grow nowrap">{title}</h2>
        <div className="seg"><button className={view === "week" ? "on" : ""} onClick={() => setView("week")}>Week</button><button className={view === "month" ? "on" : ""} onClick={() => setView("month")}>Month</button></div>
        <button className="btn sm" onClick={() => move(-1)} aria-label="Previous">Back</button>
        <button className="btn sm" onClick={() => setAnchor(new Date())}>Today</button>
        <button className="btn sm" onClick={() => move(1)} aria-label="Next">Next</button>
      </div>
      <div className={`cal${view === "week" ? " week" : ""}`}>
        {DOW.map(d => <div key={d} className="dow">{d}</div>)}
        {days.map(d => {
          const list = byDay.get(dayKey(d)) || [];
          return (
            <div key={d.toISOString()} className={`day${view === "month" && d.getMonth() !== anchor.getMonth() ? " other" : ""}${dayKey(d) === today ? " today" : ""}`}>
              <span className="n">{view === "week" ? d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" }) : d.getDate()}</span>
              {list.slice(0, view === "week" ? 20 : 4).map(p => (
                <button key={p.id} className={`chip ${statusTone(p.status)}`} onClick={() => setOpen(p)} title={p.input.text}>
                  <span className="num">{new Date(postTime(p)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}</span> <span className="t">{p.input.text}</span>
                </button>
              ))}
              {view === "month" && list.length > 4 && <span className="tiny muted">+{list.length - 4} more</span>}
            </div>
          );
        })}
      </div>
      <div className="row wrap tiny muted"><span className="dot" style={{ background: "var(--brand)" }} /> waiting for you <span className="dot" style={{ background: "var(--info)" }} /> approved or scheduled <span className="dot ok" /> published <span className="dot bad" /> failed</div>
      {open && (
        <Modal title={fmtDate(postTime(open))} onClose={() => setOpen(null)}>
          <div className="row wrap gap-4"><Badge status={open.status} />{open.input.targets.map(t => <span key={t.account} className="badge">{s.accountLabel(t.account)}</span>)}</div>
          <div className="mt-12" style={{ whiteSpace: "pre-wrap" }}>{open.input.text}</div>
          {!!open.input.media?.length && <div className="thumbs mt-12">{open.input.media.map(m => <div key={m.path} className="thumb"><MediaView path={m.path} mime={m.mime} /></div>)}</div>}
          {open.results.length > 0 && (
            <div className="list mt-12">{open.results.map(r => <div key={r.account} className="item small"><span className="grow">{s.accountLabel(r.account)}</span><Badge status={r.status} />{r.url && <a href={r.url} target="_blank" rel="noreferrer">Open</a>}{r.error && <span className="error">{r.error}</span>}</div>)}</div>
          )}
        </Modal>
      )}
    </div>
  );
}
