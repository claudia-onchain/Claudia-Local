import { api, errText } from "../lib";
import { PageHead, Switch, useAsync, useToast } from "../ui";

type Tool = { name: string; group: string; label: string; about: string; locked: boolean; enabled: boolean };
type Data = { tools: Tool[]; askBeforePost: boolean };

export default function Skills() {
  const toast = useToast();
  const { data, setData } = useAsync(() => api<Data>("/api/tools"));
  const save = async (patch: { tools?: Record<string, boolean>; askBeforePost?: boolean }) => {
    try { setData(await api<Data>("/api/tools", { body: patch })); } catch (e) { toast(errText(e), "bad"); }
  };
  const groups = new Map<string, Tool[]>();
  for (const t of data?.tools || []) groups.set(t.group, [...(groups.get(t.group) || []), t]);

  return (
    <>
      <PageHead title="Skills" sub="Choose what your agent is allowed to do. Switched-off tools are not offered to the model at all. There is no shell and no access outside your workspace." />
      <div className="col gap-16">
        {[...groups].map(([g, tools]) => (
          <div key={g} className="card">
            <div className="card-head"><h2>{g}</h2></div>
            <div className="list">
              {tools.map(t => (
                <div key={t.name} className="item">
                  <div className="grow">
                    <div>{t.label} <span className="mono tiny muted">{t.name}</span></div>
                    <div className="small muted">{t.about}</div>
                  </div>
                  <Switch checked={t.enabled} disabled={t.locked} onChange={v => save({ tools: { [t.name]: v } })} />
                </div>
              ))}
              {g === "Claudia: posting" && (
                <div className="item">
                  <div className="grow">
                    <div>Ask me before every post</div>
                    <div className="small muted">Recommended. Posts are public and speak for your agent. When this is off, the agent can post on its own within Claudia's limits.</div>
                  </div>
                  <Switch checked={!!data?.askBeforePost} onChange={v => save({ askBeforePost: v })} />
                </div>
              )}
            </div>
          </div>
        ))}
        <div className="note">Real buys, sells and launches are never agent tools. The agent can only suggest them; you review, run a dry run, and confirm on the Claudia page.</div>
      </div>
    </>
  );
}
