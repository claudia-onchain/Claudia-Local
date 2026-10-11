// The unlock screen, or the setup wizard on first run (pages/wizard/Wizard.tsx).
import { useState, type FormEvent } from "react";
import { api, errText } from "../lib";
import { Face, Field } from "../ui";
import type { AppState } from "../App";
import Wizard from "./wizard/Wizard";

export default function Gate({ state, onDone }: { state: AppState; onDone: () => void }) {
  return state.setup ? <Unlock onDone={onDone} /> : <Wizard state={state} onDone={onDone} />;
}

function Hello({ title, sub }: { title: string; sub: string }) {
  return (
    <div className="hello">
      <Face size={64} />
      <div>
        <h1>{title}</h1>
        <p className="soft mt-4">{sub}</p>
      </div>
    </div>
  );
}

function Unlock({ onDone }: { onDone: () => void }) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try { await api("/api/unlock", { body: { passphrase: pass } }); onDone(); } catch (x) { setErr(errText(x)); setBusy(false); }
  };
  return (
    <div className="gate">
      <form className="gate-box" onSubmit={submit}>
        <Hello title="Welcome back" sub="Enter your passphrase to unlock Claudia Local." />
        <Field label="Passphrase">
          <input className="input" type="password" autoFocus autoComplete="current-password" value={pass} onChange={e => setPass(e.target.value)} />
        </Field>
        {err && <p className="error mt-8">{err}</p>}
        <button className="btn primary lg block mt-16" disabled={!pass || busy}>{busy ? "Unlocking…" : "Unlock"}</button>
        <p className="tiny muted mt-16">Everything stays on this computer. Forgot the passphrase? The keys can't be recovered; delete the data folder to start over.</p>
      </form>
    </div>
  );
}
