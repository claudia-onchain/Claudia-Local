// Skills: Agent Skills (SKILL.md folders) from Claudia's library, a GitHub link (after a review) or a folder.
// Skills are instructions only: the agent reads them when a task fits, and nothing in a skill is ever run.
import { useEffect, useState } from "react";
import { api, ago, errText } from "../lib";
import { Field, Modal, PageHead, Switch, useAsync, useToast } from "../ui";

type Installed = {
  slug: string; name: string; title: string; description: string; version: string; source: { type: string; ref: string };
  enabled: boolean; installedAt: number; files: number; scripts: number; changed?: boolean; missing?: boolean;
};
type Detail = Installed & { skillMd: string; fileList: { path: string; size: number; kind: string }[] };
type LibSkill = { slug: string; title: string; category: string; summary: string; level: string; tags: string[]; version: string; installed: boolean };
type Library = { categories: { id: string; title: string; count: number }[]; total: number; skills: LibSkill[] };
type ReviewFile = { path: string; size: number; kind: "script" | "text" | "binary"; content: string | null; truncated: boolean };
type Review = { token: string; slug: string; title: string; description: string; blocked: string[]; installed: boolean; files: ReviewFile[] };

const size = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
const SOURCE: Record<string, string> = { library: "Claudia library", github: "GitHub", folder: "Folder" };

export default function Skills() {
  const [tab, setTab] = useState<"installed" | "library" | "add">("installed");
  const installed = useAsync(() => api<{ skills: Installed[] }>("/api/skills"));
  return (
    <>
      <PageHead title="Skills" sub="Instructions your agent reads when a task fits. Skills are instructions only: Claudia Local never runs scripts from a skill." />
      <div className="tabs">
        <button className={tab === "installed" ? "on" : ""} onClick={() => setTab("installed")}>Installed{installed.data ? ` (${installed.data.skills.length})` : ""}</button>
        <button className={tab === "library" ? "on" : ""} onClick={() => setTab("library")}>Library</button>
        <button className={tab === "add" ? "on" : ""} onClick={() => setTab("add")}>Add from GitHub or a folder</button>
      </div>
      {tab === "installed" && <InstalledList data={installed.data?.skills || null} error={installed.error} reload={installed.reload} />}
      {tab === "library" && <LibraryView onInstalled={installed.reload} />}
      {tab === "add" && <AddView onInstalled={() => { installed.reload(); setTab("installed"); }} />}
    </>
  );
}

function InstalledList({ data, error, reload }: { data: Installed[] | null; error: string | null; reload: () => void }) {
  const toast = useToast();
  const [view, setView] = useState<string | null>(null);
  const run = async (f: () => Promise<unknown>, ok?: string) => { try { await f(); if (ok) toast(ok, "ok"); reload(); } catch (e) { toast(errText(e), "bad"); } };
  if (error) return <p className="error">{error}</p>;
  if (!data) return null;
  if (!data.length) return <div className="card"><div className="empty">No skills yet. Install one from the Library tab.</div></div>;
  return (
    <div className="card">
      <div className="list">
        {data.map(s => (
          <div key={s.slug} className="item stack" style={{ alignItems: "flex-start" }}>
            <div className="grow" style={{ minWidth: 0 }}>
              <div>{s.title} <span className="mono tiny muted">{s.slug}</span></div>
              <div className="small muted trunc">{s.description}</div>
              <div className="row wrap tiny muted mt-4">
                <span className="badge">{SOURCE[s.source?.type] || s.source?.type}</span>
                {s.version && <span>v{s.version}</span>}
                <span>{s.files} files{s.scripts ? `, ${s.scripts} script${s.scripts > 1 ? "s" : ""} (never run)` : ""}</span>
                <span>installed {ago(s.installedAt)}</span>
              </div>
              {(s.changed || s.missing) && (
                <div className="note bad small mt-8">
                  {s.missing ? "Missing from disk." : "Changed on disk since install."} The agent won't load it until you review it.
                  <div className="row mt-8">
                    <button className="btn sm" onClick={() => setView(s.slug)}>View</button>
                    {!s.missing && <button className="btn sm" onClick={() => { if (confirm(`Accept what's on disk now as ${s.slug}? Only do this if you made or checked the change.`)) run(() => api(`/api/skills/${s.slug}/repin`, { method: "POST", body: {} }), "Accepted"); }}>Accept changes</button>}
                  </div>
                </div>
              )}
            </div>
            <div className="row">
              <button className="btn ghost sm" onClick={() => setView(s.slug)}>View</button>
              <button className="btn ghost sm" onClick={() => { if (confirm(`Remove ${s.title}?`)) run(() => api(`/api/skills/${s.slug}`, { method: "DELETE" }), "Removed"); }}>Remove</button>
              <Switch checked={s.enabled} onChange={v => run(() => api(`/api/skills/${s.slug}`, { body: { enabled: v } }))} />
            </div>
          </div>
        ))}
      </div>
      {view && <ViewSkill slug={view} onClose={() => setView(null)} />}
    </div>
  );
}

function ViewSkill({ slug, onClose }: { slug: string; onClose: () => void }) {
  const d = useAsync(() => api<Detail>(`/api/skills/${slug}`), [slug]);
  return (
    <Modal title={d.data?.title || slug} onClose={onClose} wide>
      {d.error && <p className="error">{d.error}</p>}
      {d.data && (
        <div className="col gap-12">
          {d.data.changed && <div className="note bad small">Changed on disk since install.</div>}
          <div className="label">SKILL.md</div>
          <pre className="code">{d.data.skillMd || "(missing)"}</pre>
          <div className="label">Files</div>
          <div className="list">
            {d.data.fileList.map(f => (
              <div key={f.path} className="item small">
                <span className="mono grow break">{f.path}</span>
                <span className={`badge${f.kind === "script" ? " copper" : ""}`}>{f.kind}</span>
                <span className="tiny muted nowrap">{size(f.size)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </Modal>
  );
}

function LibraryView({ onInstalled }: { onInstalled: () => void }) {
  const toast = useToast();
  const [category, setCategory] = useState("");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState("");
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 300); return () => clearTimeout(t); }, [q]);
  const lib = useAsync(() => api<Library>(`/api/skills/library?category=${encodeURIComponent(category)}&q=${encodeURIComponent(query)}`), [category, query]);
  const install = async (slug: string) => {
    setBusy(slug);
    try { const r = await api<{ pending?: boolean; message?: string }>("/api/skills/install", { body: { slug } }); toast(r.pending ? r.message || "Queued" : "Installed", r.pending ? undefined : "ok"); lib.reload(); onInstalled(); } catch (e) { toast(errText(e), "bad"); }
    setBusy("");
  };
  return (
    <div className="col gap-12">
      <div className="row wrap">
        <div className="seg">
          <button className={!category ? "on" : ""} onClick={() => setCategory("")}>All</button>
          {(lib.data?.categories || []).map(c => <button key={c.id} className={category === c.id ? "on" : ""} onClick={() => setCategory(c.id)}>{c.title}</button>)}
        </div>
        <input className="input grow" style={{ minWidth: 180 }} placeholder="Search skills" value={q} onChange={e => setQ(e.target.value)} aria-label="Search skills" />
      </div>
      {lib.error && <p className="error">Couldn't load the library: {lib.error}</p>}
      {lib.data && !lib.data.skills.length && <div className="empty">Nothing matches that.</div>}
      <div className="card">
        <div className="list">
          {(lib.data?.skills || []).map(s => (
            <div key={s.slug} className="item" style={{ alignItems: "flex-start" }}>
              <div className="grow">
                <div>{s.title} <span className="mono tiny muted">{s.slug}</span></div>
                <div className="small soft">{s.summary}</div>
                <div className="row wrap tiny muted mt-4">
                  {s.level && <span className="badge">{s.level}</span>}
                  {s.tags.slice(0, 4).map(t => <span key={t} className="badge">{t}</span>)}
                </div>
              </div>
              {s.installed ? <span className="badge ok">Installed</span> : <button className="btn sm" disabled={!!busy} onClick={() => install(s.slug)}>{busy === s.slug ? "Installing…" : "Install"}</button>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AddView({ onInstalled }: { onInstalled: () => void }) {
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [path, setPath] = useState("");
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (f: () => Promise<void>) => { setBusy(true); try { await f(); } catch (e) { toast(errText(e), "bad"); } setBusy(false); };
  return (
    <div className="col gap-16">
      <div className="note warn">Skills are instructions only. Claudia Local never runs scripts from a skill. Anything that tells you or the agent to pipe a download into a shell is refused.</div>
      <div className="card">
        <div className="card-head"><h2>From GitHub</h2><p>You see every file before anything is installed.</p></div>
        <Field label="Link to a repository or a skill folder">
          <div className="row">
            <input className="input mono" placeholder="https://github.com/owner/repo/tree/main/skills/name" value={url} onChange={e => setUrl(e.target.value)} />
            <button className="btn" disabled={!url.trim() || busy} onClick={() => run(async () => { setReview(null); setReview(await api<Review>("/api/skills/review", { body: { url: url.trim() } })); })}>{busy && !review ? "Loading…" : "Review"}</button>
          </div>
        </Field>
        {review && <ReviewView r={review} busy={busy} onCancel={() => setReview(null)} onInstall={() => run(async () => { await api("/api/skills/install-reviewed", { body: { token: review.token } }); toast(`Installed ${review.slug}`, "ok"); setReview(null); setUrl(""); onInstalled(); })} />}
      </div>
      <div className="card">
        <div className="card-head"><h2>From a folder on this computer</h2><p>A folder with a SKILL.md at the top.</p></div>
        <div className="row">
          <input className="input mono" placeholder="/Users/you/skills/my-skill" value={path} onChange={e => setPath(e.target.value)} />
          <button className="btn" disabled={!path.trim() || busy} onClick={() => run(async () => { await api("/api/skills/install-folder", { body: { path: path.trim() } }); toast("Installed", "ok"); setPath(""); onInstalled(); })}>Install</button>
        </div>
      </div>
    </div>
  );
}

function ReviewView({ r, busy, onCancel, onInstall }: { r: Review; busy: boolean; onCancel: () => void; onInstall: () => void }) {
  const scripts = r.files.filter(f => f.kind === "script");
  return (
    <div className="col gap-12 mt-16">
      <div>
        <div style={{ fontWeight: 500 }}>{r.title} <span className="mono tiny muted">{r.slug}</span></div>
        <div className="small soft mt-4">{r.description}</div>
        {r.installed && <div className="small muted mt-4">Installing replaces the copy you have now.</div>}
      </div>
      {r.blocked.length > 0 && <div className="note bad small">{r.blocked.map((b, i) => <div key={i}>{b}</div>)}<div className="mt-4">This skill can't be installed.</div></div>}
      <div className="label">All {r.files.length} files{scripts.length ? ` (${scripts.length} script${scripts.length > 1 ? "s" : ""}, shown in full, never run)` : ""}</div>
      <div className="list">
        {r.files.map(f => (
          <div key={f.path} className="item small">
            <span className="mono grow break">{f.path}</span>
            <span className={`badge${f.kind === "script" ? " copper" : ""}`}>{f.kind}</span>
            <span className="tiny muted nowrap">{size(f.size)}</span>
          </div>
        ))}
      </div>
      {r.files.filter(f => f.path === "SKILL.md" || f.kind === "script").map(f => (
        <div key={f.path}>
          <div className="label mono">{f.path}</div>
          <pre className="code mt-4">{f.content}</pre>
        </div>
      ))}
      {r.files.filter(f => f.kind === "text" && f.path !== "SKILL.md").map(f => (
        <details key={f.path} className="more">
          <summary className="mono">{f.path}</summary>
          <pre className="code mt-8">{f.content}{f.truncated ? "\n…" : ""}</pre>
        </details>
      ))}
      <div className="row">
        <button className="btn ghost" onClick={onCancel}>Cancel</button>
        {!r.blocked.length && <button className="btn primary" disabled={busy} onClick={onInstall}>{busy ? "Installing…" : "Install"}</button>}
      </div>
    </div>
  );
}
