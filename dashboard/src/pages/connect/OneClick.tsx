// One-click connect to a Claudia agent: opens useclaudia.xyz, you approve there, and the key comes back
// through a one-time code exchange (no key in any URL). The manual flow stays available next to it.
import { useEffect, useRef, useState } from "react";
import { api, bus, errText } from "../../lib";

type Props = { baseUrl?: string; suggestedName?: string; onConnected?: (agentName: string) => void; compact?: boolean };

export default function OneClick({ baseUrl, suggestedName, onConnected, compact }: Props) {
  const [state, setState] = useState<"idle" | "waiting" | "done">("idle");
  const [err, setErr] = useState("");
  const [agent, setAgent] = useState("");
  const [url, setUrl] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const site = (baseUrl || "https://useclaudia.xyz").replace(/^https?:\/\//, "").replace(/\/+$/, "");

  useEffect(() => () => window.clearInterval(timer.current), []);

  const start = async () => {
    setErr("");
    try {
      const r = await api<{ url: string; expiresAt: number }>("/api/claudia/connect/one-click", { body: { name: suggestedName || "" } });
      setUrl(r.url);
      window.open(r.url, "_blank", "noopener,noreferrer");
      setState("waiting");
      window.clearInterval(timer.current);
      timer.current = window.setInterval(async () => {
        if (Date.now() > r.expiresAt) { window.clearInterval(timer.current); setState("idle"); setErr("The connect link expired. Start again."); return; }
        try {
          const st = await api("/api/claudia/status");
          if (st.connected && st.source === "one-click") {
            window.clearInterval(timer.current);
            const name = st.agent?.name || "your agent";
            setAgent(name); setState("done");
            bus.dispatchEvent(new Event("claudia"));
            onConnected?.(name);
          }
        } catch { /* keep waiting */ }
      }, 2000);
    } catch (e) { setErr(errText(e)); }
  };

  if (state === "done") return <div className="note ok">Connected as <strong>{agent}</strong>.</div>;
  return (
    <div className="fields">
      {!compact && <p className="small soft">Opens {site}. Sign in with your wallet, pick an agent or create one, and approve. Claudia Local gets its key back directly; nothing to copy.</p>}
      <div className="row wrap">
        <button className="btn primary" onClick={start}>{state === "waiting" ? "Open Claudia again" : "Connect with Claudia"}</button>
        {state === "waiting" && <button className="btn ghost" onClick={() => { window.clearInterval(timer.current); setState("idle"); }}>Cancel</button>}
      </div>
      {state === "waiting" && <p className="small muted">Waiting for you to approve on {site}. This page updates by itself. {url && <a href={url} target="_blank" rel="noreferrer">Open the link</a>}</p>}
      {err && <p className="error">{err}</p>}
    </div>
  );
}
