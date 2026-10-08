// Socials: approvals, composer, calendar, inbox, campaigns, connections, analytics, and the kill switch.
// Each tab lives in pages/socials/. Nothing publishes without your approval here.
import { useCallback, useEffect, useState } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { api, errText } from "../lib";
import { Modal, PageHead, Switch, useToast } from "../ui";
import { useStudioEvents, type StudioStatus } from "../studio";
import { NotInstalled } from "../studio-ui";
import Approvals from "./socials/Approvals";
import Composer from "./socials/Composer";
import Calendar from "./socials/Calendar";
import Inbox from "./socials/Inbox";
import Campaigns from "./socials/Campaigns";
import Connections from "./socials/Connections";
import Analytics from "./socials/Analytics";

import { SocialCtx, type Net, type SocialState } from "./socials/ctx";

export default function Socials() {
  const toast = useToast();
  const [st, setSt] = useState<StudioStatus | null>(null);
  const [net, setNet] = useState<Net | null>(null);
  const [err, setErr] = useState("");
  const [askKill, setAskKill] = useState(false);
  const [alsoDrafts, setAlsoDrafts] = useState(false);
  const reload = useCallback(() => {
    api<StudioStatus>("/api/studio/status").then(s => {
      setSt(s);
      if (s.social.installed) api<Net>("/api/social/networks").then(n => { setNet(n); setErr(""); }).catch(e => setErr(errText(e)));
    }).catch(e => setErr(errText(e)));
  }, []);
  useEffect(() => { reload(); }, [reload]);
  useStudioEvents(e => { if (e.topic === "account" || e.topic === "kill") reload(); });

  const setKill = async (posting: boolean, drafts = false) => {
    try { await api("/api/social/kill", { body: { posting, drafts } }); toast(posting ? "All posting stopped" : "Posting resumed", posting ? "bad" : "ok"); setAskKill(false); reload(); } catch (e) { toast(errText(e), "bad"); }
  };
  const kill = st?.killSwitch;
  const ctx: SocialState | null = net ? {
    ...net, reload,
    netName: (id) => net.networks.find(n => n.id === id)?.name || id,
    accountLabel: (id) => { const a = net.accounts.find(x => x.id === id); return a ? `${net.networks.find(n => n.id === a.network)?.name || a.network} ${a.handle}` : id; },
  } : null;

  return (
    <>
      <PageHead title="Socials" sub="Write once, check how it looks on every network, approve, and let it go out on time. Drafts from your agent wait here for you.">
        {st?.social.installed && !kill?.posting && <button className="btn stop" onClick={() => setAskKill(true)}>Stop all posting</button>}
      </PageHead>
      {kill?.posting && (
        <div className="kill" role="alert">
          <div className="grow"><strong>All posting is stopped.</strong> <span className="soft small">Nothing publishes, scheduled posts wait{kill.drafts ? ", and the agent and MCP apps can't draft" : ""}.</span></div>
          <button className="btn" onClick={() => setKill(false)}>Resume posting</button>
        </div>
      )}
      <nav className="tabs">
        <NavLink to="/socials" end>Approvals</NavLink>
        <NavLink to="/socials/compose">Compose</NavLink>
        <NavLink to="/socials/calendar">Calendar</NavLink>
        <NavLink to="/socials/inbox">Inbox</NavLink>
        <NavLink to="/socials/campaigns">Campaigns</NavLink>
        <NavLink to="/socials/connections">Connections</NavLink>
        <NavLink to="/socials/analytics">Analytics</NavLink>
      </nav>
      {err && <div className="note bad">{err}</div>}
      {st && !st.social.installed ? <NotInstalled pkg={st.social} what="Socials" /> : ctx ? (
        <SocialCtx.Provider value={ctx}>
          <Routes>
            <Route index element={<Approvals />} />
            <Route path="compose" element={<Composer />} />
            <Route path="calendar" element={<Calendar />} />
            <Route path="inbox" element={<Inbox />} />
            <Route path="campaigns" element={<Campaigns />} />
            <Route path="connections" element={<Connections />} />
            <Route path="analytics" element={<Analytics />} />
          </Routes>
        </SocialCtx.Provider>
      ) : !err ? <div className="empty">Loading…</div> : null}
      {askKill && (
        <Modal title="Stop all posting?" onClose={() => setAskKill(false)}>
          <p className="soft">Nothing will publish until you resume: not approved posts, not scheduled ones, not replies. Drafts stay where they are.</p>
          <div className="mt-12"><Switch checked={alsoDrafts} onChange={setAlsoDrafts} label="Also stop the agent and MCP apps from drafting" /></div>
          <div className="row mt-16"><button className="btn ghost" onClick={() => setAskKill(false)}>Cancel</button><button className="btn stop grow" onClick={() => setKill(true, alsoDrafts)}>Stop all posting</button></div>
        </Modal>
      )}
    </>
  );
}
