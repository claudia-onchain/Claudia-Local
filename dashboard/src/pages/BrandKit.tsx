// Claudia → Brand kit: reference portraits, voice, tone guide and banned phrases.
// Used by the Generate studio ("Use Claudia's brand kit"), Socials (banned phrases block posts) and chat.
import { useEffect, useState } from "react";
import { api, errText } from "../lib";
import { Field, Switch, useAsync, useToast } from "../ui";
import type { Brand } from "../studio";
import { Dropzone, LibraryPicker, MediaView } from "../studio-ui";

const VOICE_LABEL: Record<string, string> = { "": "No voice yet", elevenlabs: "ElevenLabs", openai: "OpenAI", google: "Google" };

export default function BrandKit() {
  const toast = useToast();
  const r = useAsync(() => api<{ brand: Brand; voiceProviders: string[] }>("/api/brand"));
  const [b, setB] = useState<Brand | null>(null);
  const [banned, setBanned] = useState("");
  const [picker, setPicker] = useState(false);
  const [base, setBase] = useState<Brand | null>(null);
  useEffect(() => { if (r.data) { setB(r.data.brand); setBase(r.data.brand); setBanned(r.data.brand.banned.join("\n")); } }, [r.data]);
  if (!b) return r.error ? <div className="note bad">{r.error}</div> : null;
  const save = async (patch: Partial<Brand> & { banned?: any }, msg = "Brand kit saved") => {
    try { const x = await api<{ brand: Brand }>("/api/brand", { body: patch }); if (Object.keys(patch).join() === "refs") { setB(v => v && { ...v, refs: x.brand.refs }); setBase(v => v && { ...v, refs: x.brand.refs }); } // keep unsaved text edits
      else { setB(x.brand); setBase(x.brand); setBanned(x.brand.banned.join("\n")); }
      toast(msg, "ok"); } catch (e) { toast(errText(e), "bad"); }
  };
  const dirty = JSON.stringify(base) !== JSON.stringify({ ...b, banned: banned.split("\n").map(x => x.trim()).filter(Boolean) });

  return (
    <div className="grid side-r">
      <div className="col gap-16">
        <div className="card">
          <div className="card-head"><h2>Reference portraits</h2><p>Image and video models use these to keep Claudia looking like herself.</p></div>
          <div className="thumbs">
            {b.refs.map(p => <div key={p} className="thumb" style={{ width: 96, height: 96 }}><MediaView path={p} /><button className="x" onClick={() => save({ refs: b.refs.filter(x => x !== p) }, "Portrait removed")}>Remove</button></div>)}
          </div>
          {b.refs.length < 8 && (
            <div className="row wrap mt-12">
              <div className="grow" style={{ minWidth: 200 }}><Dropzone to="brand" accept="image/png,image/jpeg,image/webp" label="Drop portraits here (PNG, JPEG, WEBP)" onDone={f => save({ refs: [...b.refs, ...f.map(x => x.path)].slice(0, 8) }, "Portrait added")} /></div>
              <button className="btn sm" onClick={() => setPicker(true)}>From the library</button>
            </div>
          )}
          <p className="tiny muted mt-8">Up to 8. Clear, well-lit, one person, different angles work best.</p>
        </div>
        <div className="card">
          <div className="card-head"><h2>How she sounds in writing</h2></div>
          <div className="fields">
            <Field label="Name"><input className="input" value={b.name} onChange={e => setB({ ...b, name: e.target.value })} /></Field>
            <Field label="Tone guide" hint="A few lines on voice, words she likes, how she signs off. Used for posts, campaign plans and chat.">
              <textarea className="textarea" style={{ minHeight: 140 }} value={b.style} onChange={e => setB({ ...b, style: e.target.value })} placeholder={"Warm, playful, short sentences. Says gm. Explains things simply.\nNever hypes prices. Calls people friends, not degens."} />
            </Field>
            <Field label="Banned phrases" hint="One per line. Posts that use them are blocked; the agent is told never to use them.">
              <textarea className="textarea mono" value={banned} onChange={e => setBanned(e.target.value)} placeholder={"to the moon\nguaranteed\n100x"} />
            </Field>
          </div>
        </div>
      </div>
      <div className="col gap-16">
        <div className="card">
          <div className="card-head"><h2>Voice</h2><p>For speech and avatar clips.</p></div>
          <div className="fields">
            <Field label="Provider">
              <select className="select" value={b.voice.provider} onChange={e => setB({ ...b, voice: { ...b.voice, provider: e.target.value } })}>
                {["", ...(r.data?.voiceProviders || [])].map(v => <option key={v} value={v}>{VOICE_LABEL[v] || v}</option>)}
              </select>
            </Field>
            <Field label="Voice id" hint="From your provider account (ElevenLabs: Voices → your voice → ID). Use your own voice: ElevenLabs' premade voices stop working on 2026-12-31.">
              <input className="input mono" value={b.voice.voiceId} onChange={e => setB({ ...b, voice: { ...b.voice, voiceId: e.target.value } })} placeholder="voice id" />
            </Field>
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>Where it's used</h2></div>
          <div className="col gap-12">
            <Switch checked={b.useInSocial} onChange={v => setB({ ...b, useInSocial: v })} label="Socials: block posts with banned phrases" />
            <Switch checked={b.useInChat} onChange={v => setB({ ...b, useInChat: v })} label="Chat: give the agent the tone guide" />
            <p className="tiny muted">The Generate studio uses the portraits and voice whenever "Use Claudia's brand kit" is on.</p>
          </div>
        </div>
        <button className="btn primary" disabled={!dirty} onClick={() => save({ name: b.name, style: b.style, banned: banned.split("\n"), voice: b.voice, useInChat: b.useInChat, useInSocial: b.useInSocial })}>Save brand kit</button>
      </div>
      {picker && <LibraryPicker kinds={["image"]} onClose={() => setPicker(false)} onPick={o => save({ refs: [...b.refs, o.path].slice(0, 8) }, "Portrait added")} />}
    </div>
  );
}
