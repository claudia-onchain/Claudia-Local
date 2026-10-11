// Settings → Claudia: who this app is connected as, and one-click connect when it isn't.
import { Link } from "react-router-dom";
import { api } from "../../lib";
import { useAsync } from "../../ui";
import OneClick from "./OneClick";

export default function ClaudiaCard() {
  const st = useAsync(() => api("/api/claudia/status"));
  const s = st.data;
  return (
    <div className="card" id="claudia">
      <div className="card-head"><h2>Claudia</h2><p>Your agent on {(s?.baseUrl || "https://useclaudia.xyz").replace(/^https?:\/\//, "")}.</p></div>
      {s?.connected ? (
        <div className="row"><span className="grow small">Connected as <strong>{s.agent?.name || "your agent"}</strong>{s.agent?.slug ? ` (@${s.agent.slug})` : ""}.</span><Link className="btn sm" to="/claudia/agent">Manage</Link></div>
      ) : s ? (
        <>
          <OneClick baseUrl={s.baseUrl} onConnected={() => st.reload()} />
          <p className="tiny muted mt-8">Prefer to paste keys? <Link to="/claudia/agent">Connect manually</Link>.</p>
        </>
      ) : null}
    </div>
  );
}
