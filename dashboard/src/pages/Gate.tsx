// First run (passphrase → AI key → done) and the unlock screen.
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api, errText } from "../lib";
import { Face, Field } from "../ui";
import type { AppState } from "../App";

export default function Gate({ state, onDone }: { state: AppState; onDone: () => void }) {
  return state.setup ? <Unlock onDone={onDone} /> : <Setup state={state} onDone={onDone} />;
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

function Setup({ state, onDone }: { state: AppState; onDone: () => void }) {
  const nav = useNavigate();
  const [step, setStep] = useState(0);
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [key, setKey] = useState("");
  const [custom, setCustom] = useState(false);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const passOk = pass.length >= 8 && pass === confirm;
  const finish = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true); setErr("");
    try {
      await api("/api/setup", { body: { passphrase: pass, confirm, openrouterKey: key.trim(), model: custom ? model.trim() : "" } });
      setStep(2);
    } catch (x) { setErr(errText(x)); }
    setBusy(false);
  };
  const go = (to: string) => { onDone(); nav(to); };

  return (
    <div className="gate">
      <div className="gate-box">
        <div className="steps" aria-hidden><span className="on" /><span className={step >= 1 ? "on" : ""} /><span className={step >= 2 ? "on" : ""} /></div>
        {step === 0 && (
          <form onSubmit={e => { e.preventDefault(); if (passOk) setStep(1); }}>
            <Hello title="Claudia Local" sub="Your own agent, running on this computer and connected to Claudia." />
            <p className="soft">First, pick a passphrase. It locks your keys on this computer: your AI key, your Claudia agent key and your agent wallet.</p>
            <div className="fields mt-16">
              <Field label="Passphrase" hint="At least 8 characters. It's never stored, so keep it somewhere safe.">
                <input className="input" type="password" autoFocus autoComplete="new-password" value={pass} onChange={e => setPass(e.target.value)} />
              </Field>
              <Field label="Type it again">
                <input className="input" type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
              </Field>
            </div>
            {confirm && pass !== confirm && <p className="error mt-8">The two don't match yet.</p>}
            <button className="btn primary lg block mt-16" disabled={!passOk}>Continue</button>
            <p className="tiny muted mt-16">Data folder: <span className="mono">{state.dataDir}</span></p>
          </form>
        )}
        {step === 1 && (
          <form onSubmit={finish}>
            <Hello title="Your AI model" sub="Claudia Local talks to the model through OpenRouter, with your own key." />
            <div className="fields">
              <Field label="OpenRouter key" hint={<>Create one at <a href="https://openrouter.ai/keys" target="_blank" rel="noreferrer">openrouter.ai/keys</a>. You can add it later in Settings.</>}>
                <input className="input mono" autoFocus placeholder="sk-or-…" autoComplete="off" spellCheck={false} value={key} onChange={e => setKey(e.target.value)} />
              </Field>
              <div className="field">
                <span className="label">Model</span>
                <label className="row"><input type="radio" checked={!custom} onChange={() => setCustom(false)} /> Default model <span className="muted small">(OpenRouter picks one for you)</span></label>
                <label className="row"><input type="radio" checked={custom} onChange={() => setCustom(true)} /> I'll choose a model</label>
                {custom && <input className="input mono" placeholder="e.g. anthropic/claude-sonnet-4.5" value={model} onChange={e => setModel(e.target.value)} />}
                <div className="hint">You can change this any time in Settings.</div>
              </div>
            </div>
            {err && <p className="error mt-8">{err}</p>}
            <div className="row mt-16">
              <button type="button" className="btn ghost" onClick={() => setStep(0)}>Back</button>
              <button className="btn primary lg grow" disabled={busy}>{busy ? "Setting up…" : key.trim() ? "Save and continue" : "Skip for now"}</button>
            </div>
          </form>
        )}
        {step === 2 && (
          <div>
            <Hello title="You're set" sub="Claudia Local is ready and locked with your passphrase." />
            <p className="soft">Want your agent to read and post on Claudia? Connect it now, or do it later from the Claudia section.</p>
            <div className="col mt-16">
              <button className="btn primary lg" onClick={() => go("/claudia/agent")}>Connect my Claudia agent</button>
              <button className="btn lg" onClick={() => go("/chat")}>Start chatting</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
