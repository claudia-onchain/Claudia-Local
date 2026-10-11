// Tasks → Templates: a persona, skills and a few starter tasks in one go. Starter tasks arrive paused.
import { useState } from "react";
import { api, errText } from "../../lib";
import { useAsync, useToast } from "../../ui";
import type { Template } from "./auto";

type Applied = { template: string; niche: string | null; persona: string; skills: { installed: string[]; pending: string[]; failed: string[] }; tasks: { id: string; name: string }[] };

export default function Templates({ onApplied }: { onApplied?: () => void }) {
  const toast = useToast();
  const r = useAsync(() => api<{ templates: Template[]; current: { id: string; niche: string | null } | null }>("/api/templates"));
  const [niche, setNiche] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [done, setDone] = useState<Applied | null>(null);
  const apply = async (t: Template) => {
    if (!confirm(`Apply ${t.name}? It sets the agent's role${t.skills.length ? ", adds its skills" : ""}${t.starterTasks.length ? ` and ${t.starterTasks.length} paused tasks` : ""}. Your brand kit and existing tasks stay.`)) return;
    setBusy(t.id);
    try {
      const x = await api<{ applied: Applied }>("/api/templates/apply", { body: { id: t.id, niche: t.niches ? niche[t.id] || t.niches[0].id : undefined } });
      setDone(x.applied); toast(`${t.name} applied`, "ok"); r.reload(); onApplied?.();
    } catch (e) { toast(errText(e), "bad"); }
    setBusy("");
  };
  return (
    <div className="col gap-16">
      {done && (
        <div className="note ok">
          Applied. {done.tasks.length ? `${done.tasks.length} task${done.tasks.length === 1 ? "" : "s"} added, paused: switch them on under Tasks. ` : ""}
          {done.skills.installed.length ? `Skills added: ${done.skills.installed.join(", ")}. ` : ""}
          {done.skills.pending.length ? `Skills to add when the library is available: ${done.skills.pending.join(", ")}. ` : ""}
          {done.skills.failed.length ? `Couldn't add: ${done.skills.failed.join(", ")}.` : ""}
        </div>
      )}
      <div className="grid two">
        {r.data?.templates.map(t => (
          <div key={t.id} className="card">
            <div className="card-head"><h2 className="grow">{t.name}</h2>{r.data?.current?.id === t.id && <span className="badge brand">In use</span>}</div>
            <p className="small soft">{t.summary}</p>
            {t.niches && (
              <div className="seg mt-12" role="group" aria-label="Niche">
                {t.niches.map(n => <button key={n.id} className={(niche[t.id] || t.niches![0].id) === n.id ? "on" : ""} onClick={() => setNiche(x => ({ ...x, [t.id]: n.id }))}>{n.name}</button>)}
              </div>
            )}
            {t.starterTasks.length > 0 && <div className="tiny muted mt-12">Tasks: {t.starterTasks.map(s => s.name).join(" · ")}</div>}
            {t.skills.length > 0 && <div className="tiny muted mt-4">Skills: {t.skills.join(", ")}</div>}
            <div className="row mt-12"><button className="btn sm" disabled={!!busy} onClick={() => apply(t)}>{busy === t.id ? "Applying…" : "Apply"}</button></div>
          </div>
        ))}
      </div>
    </div>
  );
}
