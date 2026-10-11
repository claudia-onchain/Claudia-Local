// Health: checks on this install (network, Node, lock, MCP, keys, skills, risky settings, version).
import { useState } from "react";
import { api, errText } from "../lib";
import { PageHead, useAsync, useToast } from "../ui";

type Check = { id: string; label: string; status: "ok" | "warn" | "bad" | "info"; detail: string; fix?: { id: string; label: string } };
type Report = { checks: Check[]; summary: { bad: number; warn: number; worst: string } };

export default function Health() {
  const toast = useToast();
  const r = useAsync(() => api<Report>("/api/health/report"));
  const [busy, setBusy] = useState("");
  const fix = async (id: string) => {
    setBusy(id);
    try { r.setData(await api<Report>("/api/health/fix", { body: { id } })); toast("Fixed", "ok"); } catch (e) { toast(errText(e), "bad"); }
    setBusy("");
  };
  const s = r.data?.summary;
  return (
    <>
      <PageHead title="Health" sub="Checks on this install. Fix buttons only make things stricter.">
        <button className="btn sm" disabled={r.loading} onClick={() => r.reload()}>{r.loading ? "Checking…" : "Check again"}</button>
      </PageHead>
      {r.error && <p className="error">{r.error}</p>}
      {s && <div className={`note ${s.bad ? "bad" : s.warn ? "warn" : "ok"}`} style={{ marginBottom: 16 }}>{s.bad ? `${s.bad} problem${s.bad > 1 ? "s" : ""}` : "No problems"}{s.warn ? `, ${s.warn} warning${s.warn > 1 ? "s" : ""}` : ""}.</div>}
      <div className="card">
        <div className="list">
          {(r.data?.checks || []).map(c => (
            <div key={c.id} className="item" style={{ alignItems: "flex-start" }}>
              <span className={`dot ${c.status === "info" ? "" : c.status}`} style={{ marginTop: 7 }} />
              <div className="grow">
                <div>{c.label}</div>
                <div className="small muted break">{c.detail}</div>
              </div>
              {c.fix && <button className="btn sm" disabled={!!busy} onClick={() => fix(c.fix!.id)}>{busy === c.fix.id ? "Fixing…" : c.fix.label}</button>}
            </div>
          ))}
        </div>
      </div>
      <p className="tiny muted mt-12">The same checks run in a terminal with <span className="mono">claudia-local doctor</span>.</p>
    </>
  );
}
