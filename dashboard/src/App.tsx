import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { api, bus } from "./lib";
import { connect, disconnect, useAgent } from "./agent";
import { Face } from "./ui";
import Gate from "./pages/Gate";
import Chat from "./pages/Chat";
import Helpers from "./pages/Helpers";
import Memory from "./pages/Memory";
import Files from "./pages/Files";
import Skills from "./pages/Skills";
import Activity from "./pages/Activity";
import Claudia from "./pages/Claudia";
import Settings from "./pages/Settings";
import Generate from "./pages/Generate";
import Socials from "./pages/Socials";
import { useStudioEvents } from "./studio";

export type AppState = { name: string; version: string; setup: boolean; unlocked: boolean; dataDir: string };

const NAV: { to: string; label: string; group?: string }[] = [
  { to: "/chat", label: "Chat", group: "Agent" },
  { to: "/helpers", label: "Helpers" },
  { to: "/memory", label: "Memory" },
  { to: "/files", label: "Files" },
  { to: "/skills", label: "Skills" },
  { to: "/generate", label: "Generate", group: "Studio" },
  { to: "/socials", label: "Socials" },
  { to: "/claudia", label: "Overview", group: "Claudia" },
  { to: "/claudia/coins", label: "Coins" },
  { to: "/claudia/thread", label: "Thread" },
  { to: "/claudia/paper", label: "Paper trading" },
  { to: "/claudia/agent", label: "Your agent" },
  { to: "/activity", label: "Activity", group: "You" },
  { to: "/settings", label: "Settings" },
];

export default function App() {
  const [st, setSt] = useState<AppState | null>(null);
  const [err, setErr] = useState("");
  const load = useCallback(() => api<AppState>("/api/state").then(s => { setSt(s); setErr(""); }).catch(e => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    const onLocked = () => { disconnect(); load(); };
    bus.addEventListener("locked", onLocked);
    return () => bus.removeEventListener("locked", onLocked);
  }, [load]);
  useEffect(() => { if (st?.unlocked) connect(); }, [st?.unlocked]);

  if (err) return <div className="gate"><div className="gate-box"><p className="error">Can't reach Claudia Local: {err}</p><button className="btn mt-12" onClick={load}>Try again</button></div></div>;
  if (!st) return null;
  if (!st.unlocked) return <Gate state={st} onDone={load} />;
  return <Shell state={st} />;
}

function Shell({ state }: { state: AppState }) {
  const loc = useLocation();
  const [menu, setMenu] = useState(false);
  const [claudia, setClaudia] = useState<any>(null);
  const a = useAgent();
  const waiting = useWaiting();
  useEffect(() => { setMenu(false); }, [loc.pathname]);
  const loadClaudia = useCallback(() => { api("/api/claudia/status").then(setClaudia).catch(() => {}); }, []);
  useEffect(() => {
    loadClaudia();
    bus.addEventListener("claudia", loadClaudia);
    return () => bus.removeEventListener("claudia", loadClaudia);
  }, [loadClaudia]);

  const lock = async () => { await api("/api/lock", { method: "POST", body: {} }).catch(() => {}); disconnect(); location.assign("/"); };
  const current = [...NAV].sort((x, y) => y.to.length - x.to.length).find(n => loc.pathname === n.to || loc.pathname.startsWith(n.to + "/"));
  const title = current ? (current.to.startsWith("/claudia") && current.to !== "/claudia" ? current.label : current.to === "/claudia" ? "Claudia" : current.label) : "Claudia Local";

  const nav = (
    <nav className="nav">
      {NAV.map(n => (
        <div key={n.to}>
          {n.group && <div className="nav-label">{n.group}</div>}
          <NavLink to={n.to} end={n.to === "/claudia"} className={({ isActive }) => (isActive ? "active" : "")}>
            {n.label}
            {n.to === "/chat" && a.pendingApprovals > 0 && <span className="count" title="Waiting for your answer">{a.pendingApprovals}</span>}
            {n.to === "/socials" && waiting > 0 && <span className="count" title="Waiting for your approval">{waiting}</span>}
          </NavLink>
        </div>
      ))}
    </nav>
  );
  const foot = (
    <div className="side-foot">
      <div className="row small" title={a.conn === "open" ? "Connected to the local server" : "Reconnecting to the local server"}>
        <span className={`dot ${a.conn === "open" ? "ok" : a.conn === "connecting" ? "warn" : "bad"}`} />
        <span className="soft trunc">{a.conn === "open" ? "Running on this computer" : "Reconnecting…"}</span>
      </div>
      <div className="row small">
        <span className={`dot ${claudia?.connected ? "ok" : ""}`} />
        <span className="soft trunc">{claudia?.connected ? `Claudia: ${claudia.agent?.name || "connected"}` : "Claudia: not connected"}</span>
      </div>
      <div className="row">
        <button className="btn sm" onClick={lock}>Lock</button>
        <span className="tiny muted right">v{state.version}</span>
      </div>
    </div>
  );

  return (
    <div className="shell">
      <aside className="side">
        <Link to="/chat" className="brandmark"><Face size={34} /><span className="wordmark">Claudia <em>Local</em></span></Link>
        {nav}
        {foot}
      </aside>
      <div className="main">
        <header className="topbar">
          <Face size={30} />
          <span className="title grow trunc">{title}</span>
          <button className="btn sm" onClick={() => setMenu(true)} aria-label="Open menu">Menu</button>
        </header>
        {menu && (
          <div className="sheet">
            <div className="topbar"><Face size={30} /><span className="title grow">Claudia <em className="brand">Local</em></span><button className="btn sm" onClick={() => setMenu(false)}>Close</button></div>
            <div style={{ padding: "4px 12px", overflowY: "auto", flex: 1 }}>{nav}</div>
            <div style={{ padding: "0 16px 20px" }}>{foot}</div>
          </div>
        )}
        <Routes>
          <Route path="/" element={<Navigate to="/chat" replace />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/helpers" element={<Page><Helpers /></Page>} />
          <Route path="/memory" element={<Page><Memory /></Page>} />
          <Route path="/files" element={<Page><Files /></Page>} />
          <Route path="/skills" element={<Page narrow><Skills /></Page>} />
          <Route path="/activity" element={<Page><Activity /></Page>} />
          <Route path="/generate/*" element={<Page><Generate /></Page>} />
          <Route path="/socials/*" element={<Page><Socials /></Page>} />
          <Route path="/claudia/*" element={<Page><Claudia status={claudia} reloadStatus={loadClaudia} /></Page>} />
          <Route path="/settings" element={<Page narrow><Settings state={state} /></Page>} />
          <Route path="*" element={<Navigate to="/chat" replace />} />
        </Routes>
        <nav className="tabbar">
          <NavLink to="/chat">Chat{a.pendingApprovals > 0 ? ` (${a.pendingApprovals})` : ""}</NavLink>
          <NavLink to="/generate">Generate</NavLink>
          <NavLink to="/socials">Socials{waiting > 0 ? ` (${waiting})` : ""}</NavLink>
          <NavLink to="/claudia">Claudia</NavLink>
        </nav>
      </div>
    </div>
  );
}

/** Posts and media waiting for approval (sidebar count). Quietly 0 when the studio packages aren't installed. */
function useWaiting() {
  const [n, setN] = useState(0);
  const load = useCallback(() => {
    Promise.all([
      api<{ posts: unknown[] }>("/api/social/posts?status=pending_approval&limit=500").then(r => r.posts.length).catch(() => 0),
      api<{ requests: { status: string }[] }>("/api/studio/requests").then(r => r.requests.filter(x => x.status === "pending").length).catch(() => 0),
      api<{ jobs: unknown[] }>("/api/studio/jobs?status=needs_approval").then(r => r.jobs.length).catch(() => 0),
    ]).then(x => setN(x.reduce((a, b) => a + b, 0)));
  }, []);
  useEffect(() => { load(); }, [load]);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useStudioEvents(e => {
    if (e.topic === "account" || (e.topic === "job" && ["running", "downloading"].includes(e.data?.status))) return; // progress ticks
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(load, 800);
  });
  return n;
}

function Page({ children, narrow }: { children: ReactNode; narrow?: boolean }) {
  return <main className={`page${narrow ? " narrow" : ""}`}><div className="inner">{children}</div></main>;
}
