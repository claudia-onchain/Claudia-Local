// Settings → Safety: kill switch, approvals for agent media, the action log.
import { Link } from "react-router-dom";
import { api, errText } from "../../lib";
import { Switch, useAsync, useToast } from "../../ui";
import { useStudioEvents, type StudioStatus } from "../../studio";

export default function Safety() {
  const toast = useToast();
  const st = useAsync(() => api<StudioStatus>("/api/studio/status"));
  useStudioEvents(e => { if (e.topic === "kill") st.reload(); });
  const k = st.data?.killSwitch;
  const kill = async (patch: { posting?: boolean; drafts?: boolean }) => {
    try { await api("/api/social/kill", { body: patch }); st.reload(); } catch (e) { toast(errText(e), "bad"); }
  };
  const ask = async (v: boolean) => { try { await api("/api/studio/settings", { body: { askBeforeAgentMedia: v } }); st.reload(); } catch (e) { toast(errText(e), "bad"); } };
  return (
    <div className="card">
      <div className="card-head"><h2>Safety</h2><p>Nothing publishes without your approval. These are the brakes on top.</p></div>
      <div className="list">
        <div className="item">
          <div className="grow"><div>Stop all posting</div><div className="small muted">The kill switch. Approved and scheduled posts wait, replies are refused.</div></div>
          <Switch checked={!!k?.posting} disabled={!st.data?.social.installed} onChange={v => kill({ posting: v, ...(v ? {} : { drafts: false }) })} />
        </div>
        <div className="item">
          <div className="grow"><div>…and stop the agent from drafting</div><div className="small muted">While the kill switch is on, the agent and MCP apps can't create drafts either.</div></div>
          <Switch checked={!!k?.drafts} disabled={!k?.posting} onChange={v => kill({ drafts: v })} />
        </div>
        <div className="item">
          <div className="grow"><div>Ask me before the agent makes media</div><div className="small muted">Media from the agent, campaigns and MCP apps waits in Socials → Approvals, whatever it costs.</div></div>
          <Switch checked={!!st.data?.askBeforeAgentMedia} onChange={ask} />
        </div>
        <div className="item">
          <div className="grow"><div>Caps</div><div className="small muted">Spending caps are under <Link to="/generate/spending">Generate → Spending and caps</Link>; daily post caps per network under <Link to="/socials/connections">Socials → Connections</Link>.</div></div>
        </div>
        <div className="item">
          <div className="grow"><div>Action log</div><div className="small muted">Every key change, generation, approval, draft and publish, plus the social package's audit log. One JSON object per line. No secrets.</div></div>
          <a className="btn sm" href="/api/studio/log.jsonl" download>Export JSONL</a>
        </div>
      </div>
    </div>
  );
}
