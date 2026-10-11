// Settings → Keys: your own keys for everything, encrypted in the vault, never shown again in full.
// Grouped Chat / Media / Social / Claudia. The list comes from server/lib/providers.js; add a provider there
// and it shows up here. "Import from .env" maps known variable names to providers and previews before saving.
import { useState } from "react";
import { Link } from "react-router-dom";
import { ago, api, errText } from "../../lib";
import { Field, Modal, useAsync, useToast } from "../../ui";
import { DryRunView } from "../../studio-ui";
import { money } from "../../studio";

type PField = { id: string; label: string; secret: boolean; optional: boolean; placeholder: string; name: string; set: boolean; hint: string; env?: string[] };
export type Provider = {
  id: string; group: string; name: string; for: string; docs: string; fields: PField[]; configured: boolean; canCheck: boolean;
  readonly?: boolean; lastUsed?: number | null; lastTested?: number | null; testOk?: boolean | null;
};
type Group = { id: string; section?: string; label: string; about: string };
type Test = { ok: boolean; issues: string[]; dryRun: any; note: string; live?: { status: number; ok: boolean; message: string }; generateDryRun?: { model: string; request: any; estimate: any }; generateDryRunError?: string };

const SECTIONS = ["Chat", "Media", "Social", "Claudia"];

export default function Keys() {
  const r = useAsync(() => api<{ groups: Group[]; providers: Provider[] }>("/api/keys"));
  const [open, setOpen] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const update = (p: Provider) => r.setData(d => d && { ...d, providers: d.providers.map(x => (x.id === p.id ? p : x)) });
  if (!r.data) return null;
  const count = r.data.providers.filter(p => p.configured).length;
  const sectionOf = (g: Group) => g.section || (g.id === "chat" ? "Chat" : g.id === "media" ? "Media" : g.id === "claudia" ? "Claudia" : "Social");
  return (
    <div className="card" id="keys">
      <div className="card-head">
        <h2 className="grow">Keys</h2>
        <span className="badge">{count} set</span>
        <button className="btn sm" onClick={() => setImporting(true)}>Import from .env</button>
      </div>
      <p className="small muted" style={{ marginTop: -6, marginBottom: 8 }}>Bring your own key for every service. Keys are encrypted with your passphrase and stay on this computer; after saving, only the last characters are shown.</p>
      {SECTIONS.map(sec => {
        const groups = r.data!.groups.filter(g => sectionOf(g) === sec);
        if (!groups.some(g => r.data!.providers.some(p => p.group === g.id))) return null;
        return (
          <div key={sec} className="mt-24">
            <h3>{sec}</h3>
            {groups.map(g => {
              const list = r.data!.providers.filter(p => p.group === g.id);
              if (!list.length) return null;
              return (
                <div key={g.id} className="mt-12">
                  {(groups.length > 1 || g.label !== sec) && <div className="label">{g.label}</div>}
                  <div className="tiny muted">{g.about}</div>
                  <div className="mt-4">{list.map(p => <Row key={p.id} p={p} open={open === p.id} toggle={() => setOpen(open === p.id ? null : p.id)} onSaved={update} reload={r.reload} />)}</div>
                </div>
              );
            })}
          </div>
        );
      })}
      {importing && <ImportEnv onClose={() => setImporting(false)} onSaved={() => { setImporting(false); r.reload(); }} />}
    </div>
  );
}

function Row({ p, open, toggle, onSaved, reload }: { p: Provider; open: boolean; toggle: () => void; onSaved: (p: Provider) => void; reload: () => void }) {
  const toast = useToast();
  const [vals, setVals] = useState<Record<string, string>>({});
  const [test, setTest] = useState<Test | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const fields = Object.fromEntries(Object.entries(vals).filter(([, v]) => v.trim()).map(([k, v]) => [k, v.trim()]));
      onSaved(await api<Provider>(`/api/keys/${p.id}`, { body: { fields } })); setVals({}); setTest(null); toast(`${p.name}: saved (encrypted)`, "ok");
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const remove = async () => {
    if (!confirm(`Remove the ${p.name} key${p.fields.length > 1 ? "s" : ""}?`)) return;
    try { onSaved(await api<Provider>(`/api/keys/${p.id}`, { method: "DELETE" })); setTest(null); toast(`${p.name}: removed`, "ok"); } catch (e) { toast(errText(e), "bad"); }
  };
  const runTest = async () => {
    setBusy(true);
    try { setTest(await api<Test>(`/api/keys/${p.id}/test`, { body: { live: p.canCheck } })); if (!open) toggle(); reload(); } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const setPart = p.fields.some(f => f.set);
  const dot = p.testOk === false ? "bad" : p.configured ? "ok" : setPart ? "warn" : "";
  const when = [p.lastUsed ? `Last used ${ago(p.lastUsed)}` : "", p.lastTested ? `Tested ${ago(p.lastTested)}${p.testOk === false ? " (failed)" : ""}` : ""].filter(Boolean).join(" · ");
  const ends = p.fields.find(f => f.set && f.secret && f.hint)?.hint;
  return (
    <div className="provider">
      <div className="row">
        <span className={`dot ${dot}`} />
        <div className="grow">
          {p.readonly ? <span>{p.name}</span> : <button className="linkbtn" style={{ color: "var(--text)", textAlign: "left" }} onClick={toggle} aria-expanded={open}>{p.name}</button>}
          <div className="tiny muted">{p.for}</div>
          {when && <div className="tiny muted">{when}</div>}
        </div>
        <span className="tiny muted nowrap hide-phone">{p.configured ? `Set${ends ? `, ends ${ends.slice(-4)}` : ""}` : setPart ? "Partly set" : "Not set"}</span>
        {setPart && <button className="btn sm" disabled={busy} onClick={runTest} title={p.canCheck ? "Sends one read-only request to the provider" : "Checks the format and shows what would be sent"}>{busy ? "Testing…" : "Test"}</button>}
        {p.readonly
          ? <Link className="btn sm ghost" to="/claudia/agent">Change it on the Claudia page</Link>
          : <button className="btn sm" onClick={toggle}>{open ? "Close" : p.configured ? "Change" : "Add"}</button>}
      </div>
      {open && !p.readonly && (
        <div className="col gap-12 mt-12" style={{ paddingLeft: 15 }}>
          <div className="small">Get it at <a href={p.docs} target="_blank" rel="noreferrer">{p.docs.replace(/^https:\/\//, "").replace(/\/$/, "")}</a></div>
          {p.fields.map(f => (
            <Field key={f.id} label={<>{f.label}{f.optional && <span className="muted"> (optional)</span>}</>} hint={f.set ? (f.secret ? `Saved${f.hint ? `, ends ${f.hint.slice(-4)}` : ""}. Type a new one to replace it.` : `Saved: ${f.hint}`) : undefined}>
              <input className="input mono" type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={f.set ? "••••••••" : f.placeholder} value={vals[f.id] || ""} onChange={e => setVals({ ...vals, [f.id]: e.target.value })} />
            </Field>
          ))}
          <div className="row wrap">
            <button className="btn primary sm" disabled={busy || !Object.values(vals).some(v => v.trim())} onClick={save}>Save</button>
            {setPart && <button className="btn danger sm right" onClick={remove}>Remove</button>}
          </div>
        </div>
      )}
      {open && test && (
        <div className="col gap-8 mt-12" style={{ paddingLeft: 15 }}>
          {test.issues.map((i, n) => <div key={n} className="note warn small">{i}</div>)}
          {test.live && <div className={`note small ${test.live.ok ? "ok" : "bad"}`}>{test.live.message}{test.live.status ? ` (HTTP ${test.live.status})` : ""}</div>}
          {test.ok && !test.live && !test.issues.length && <div className="note ok small">Looks right. Nothing was sent.</div>}
          {test.note && <div className="small muted">{test.note}</div>}
          {test.dryRun && !test.live && <><div className="label">The check would send</div><DryRunView data={{ request: test.dryRun }} /></>}
          {test.generateDryRun && <><div className="label">A test generation with {test.generateDryRun.model} would send (about {money(test.generateDryRun.estimate?.usd)})</div><DryRunView data={{ request: test.generateDryRun.request }} /></>}
          {test.generateDryRunError && <div className="small muted">Generation dry run: {test.generateDryRunError}</div>}
        </div>
      )}
    </div>
  );
}

type EnvRow = { var: string; provider: string; providerName: string; field: string; fieldLabel: string; hint: string; replaces: boolean; same: boolean; duplicate: boolean; readonly: boolean };

function ImportEnv({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [text, setText] = useState("");
  const [rows, setRows] = useState<EnvRow[] | null>(null);
  const [unknown, setUnknown] = useState<string[]>([]);
  const [pick, setPick] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  const usable = (r: EnvRow) => !r.duplicate && !r.readonly && !r.same;
  const preview = async () => {
    setBusy(true);
    try {
      const r = await api<{ rows: EnvRow[]; unknown: string[] }>("/api/keys/import-env", { body: { text } });
      setRows(r.rows); setUnknown(r.unknown);
      setPick(Object.fromEntries(r.rows.filter(usable).map(x => [x.var, true])));
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const chosen = (rows || []).filter(r => usable(r) && pick[r.var]).map(r => r.var);
  const save = async () => {
    setBusy(true);
    try {
      const r = await api<{ saved: string[] }>("/api/keys/import-env", { body: { text, apply: true, only: chosen } });
      toast(`Saved ${r.saved.length} key${r.saved.length === 1 ? "" : "s"} (encrypted)`, "ok");
      onSaved();
    } catch (e) { toast(errText(e), "bad"); setBusy(false); }
  };
  const state = (r: EnvRow) => r.readonly ? <span className="badge">set on the Claudia page</span> : r.duplicate ? <span className="badge">duplicate</span> : r.same ? <span className="badge">same</span> : r.replaces ? <span className="badge copper">replaces</span> : <span className="badge ok">new</span>;
  return (
    <Modal title="Import keys from a .env file" onClose={onClose} wide>
      <p className="small muted">The file stays in this window; only the keys you pick are saved, encrypted.</p>
      <textarea className="textarea mono mt-12" rows={8} placeholder={"ANTHROPIC_API_KEY=sk-ant-…\nOPENAI_API_KEY=sk-…"} spellCheck={false} autoComplete="off" value={text} onChange={e => { setText(e.target.value); setRows(null); }} />
      <div className="row mt-8"><button className="btn sm" disabled={!text.trim() || busy} onClick={preview}>Preview</button></div>
      {rows && (
        <div className="mt-16">
          {!rows.length ? <div className="small muted">No known key names in that file.</div> : (
            <table className="table">
              <thead><tr><th /><th>Variable</th><th>Provider</th><th>Field</th><th>Key</th><th /></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.var}>
                    <td><input type="checkbox" disabled={!usable(r)} checked={usable(r) && !!pick[r.var]} onChange={e => setPick({ ...pick, [r.var]: e.target.checked })} aria-label={`Save ${r.var}`} /></td>
                    <td className="mono small">{r.var}</td>
                    <td>{r.providerName}</td>
                    <td className="small">{r.fieldLabel}</td>
                    <td className="mono small">{r.hint ? `ends ${r.hint.slice(-4)}` : ""}</td>
                    <td>{state(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {unknown.length > 0 && <div className="tiny muted mt-8 break">Not used: {unknown.join(", ")}</div>}
          <div className="row mt-12">
            <button className="btn primary sm" disabled={!chosen.length || busy} onClick={save}>Save {chosen.length} key{chosen.length === 1 ? "" : "s"}</button>
            <button className="btn ghost sm" onClick={onClose}>Cancel</button>
          </div>
        </div>
      )}
    </Modal>
  );
}
