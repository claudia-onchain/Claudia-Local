// Settings → Keys and providers: your own keys for everything, encrypted in the vault, never shown again in full.
// The list comes from server/lib/providers.js; add a provider there and it shows up here.
import { useState } from "react";
import { api, errText } from "../../lib";
import { Field, useAsync, useToast } from "../../ui";
import { DryRunView } from "../../studio-ui";
import { money } from "../../studio";

type PField = { id: string; label: string; secret: boolean; optional: boolean; placeholder: string; name: string; set: boolean; hint: string };
export type Provider = { id: string; group: string; name: string; for: string; docs: string; fields: PField[]; configured: boolean; canCheck: boolean };
type Group = { id: string; label: string; about: string };
type Test = { ok: boolean; issues: string[]; dryRun: any; note: string; live?: { status: number; ok: boolean; message: string }; generateDryRun?: { model: string; request: any; estimate: any }; generateDryRunError?: string };

export default function Keys() {
  const r = useAsync(() => api<{ groups: Group[]; providers: Provider[] }>("/api/keys"));
  const [open, setOpen] = useState<string | null>(null);
  const update = (p: Provider) => r.setData(d => d && { ...d, providers: d.providers.map(x => (x.id === p.id ? p : x)) });
  if (!r.data) return null;
  const count = r.data.providers.filter(p => p.configured).length;
  return (
    <div className="card" id="keys">
      <div className="card-head"><h2 className="grow">Keys and providers</h2><span className="badge">{count} set</span></div>
      <p className="small muted" style={{ marginTop: -6, marginBottom: 8 }}>Bring your own key for every service. Keys are encrypted with your passphrase and stay on this computer; after saving, only the last characters are shown.</p>
      {r.data.groups.map(g => {
        const list = r.data!.providers.filter(p => p.group === g.id);
        return (
          <div key={g.id} className="mt-16">
            <div className="label">{g.label}</div>
            <div className="tiny muted">{g.about}</div>
            <div className="mt-4">{list.map(p => <Row key={p.id} p={p} open={open === p.id} toggle={() => setOpen(open === p.id ? null : p.id)} onSaved={update} />)}</div>
          </div>
        );
      })}
    </div>
  );
}

function Row({ p, open, toggle, onSaved }: { p: Provider; open: boolean; toggle: () => void; onSaved: (p: Provider) => void }) {
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
  const runTest = async (live: boolean) => {
    setBusy(true);
    try { setTest(await api<Test>(`/api/keys/${p.id}/test`, { body: { live } })); } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const setPart = p.fields.some(f => f.set);
  return (
    <div className="provider">
      <div className="row">
        <span className={`dot ${p.configured ? "ok" : setPart ? "warn" : ""}`} />
        <div className="grow">
          <button className="linkbtn" style={{ color: "var(--text)", textAlign: "left" }} onClick={toggle} aria-expanded={open}>{p.name}</button>
          <div className="tiny muted">{p.for}</div>
        </div>
        <span className="tiny muted nowrap hide-phone">{p.configured ? "Set" : setPart ? "Partly set" : "Not set"}</span>
        <button className="btn sm" onClick={toggle}>{open ? "Close" : p.configured ? "Change" : "Add"}</button>
      </div>
      {open && (
        <div className="col gap-12 mt-12" style={{ paddingLeft: 15 }}>
          <div className="small">Get it at <a href={p.docs} target="_blank" rel="noreferrer">{p.docs.replace(/^https:\/\//, "").replace(/\/$/, "")}</a></div>
          {p.fields.map(f => (
            <Field key={f.id} label={<>{f.label}{f.optional && <span className="muted"> (optional)</span>}</>} hint={f.set ? (f.secret ? `Saved${f.hint ? `, ends ${f.hint.slice(-4)}` : ""}. Type a new one to replace it.` : `Saved: ${f.hint}`) : undefined}>
              <input className="input mono" type={f.secret ? "password" : "text"} autoComplete="off" spellCheck={false} placeholder={f.set ? "••••••••" : f.placeholder} value={vals[f.id] || ""} onChange={e => setVals({ ...vals, [f.id]: e.target.value })} />
            </Field>
          ))}
          <div className="row wrap">
            <button className="btn primary sm" disabled={busy || !Object.values(vals).some(v => v.trim())} onClick={save}>Save</button>
            <button className="btn sm" disabled={busy || !setPart} onClick={() => runTest(false)}>Test (dry run)</button>
            {p.canCheck && <button className="btn ghost sm" disabled={busy || !p.configured} onClick={() => runTest(true)} title="Sends one read-only request to the provider">Send check</button>}
            {setPart && <button className="btn danger sm right" onClick={remove}>Remove</button>}
          </div>
          {test && (
            <div className="col gap-8">
              {test.issues.map((i, n) => <div key={n} className="note warn small">{i}</div>)}
              {test.live && <div className={`note small ${test.live.ok ? "ok" : "bad"}`}>{test.live.message}{test.live.status ? ` (HTTP ${test.live.status})` : ""}</div>}
              {test.ok && !test.live && !test.issues.length && <div className="note ok small">Looks right. Nothing was sent.</div>}
              {test.note && <div className="small muted">{test.note}</div>}
              {test.dryRun && <><div className="label">The check would send</div><DryRunView data={{ request: test.dryRun }} /></>}
              {test.generateDryRun && <><div className="label">A test generation with {test.generateDryRun.model} would send (about {money(test.generateDryRun.estimate?.usd)})</div><DryRunView data={{ request: test.generateDryRun.request }} /></>}
              {test.generateDryRunError && <div className="small muted">Generation dry run: {test.generateDryRunError}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
