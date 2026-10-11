// Brand kit: your brand's name, voice in writing, topics, banned phrases and visuals (portraits, look, voice).
// Used by the Generate studio ("Use your brand kit"), Socials (banned phrases block posts), campaigns, tasks and chat.
// "Claudia" is a preset you can load.
import { useEffect, useState } from "react";
import { api, errText } from "../lib";
import { Field, Modal, PageHead, Switch, useAsync, useToast } from "../ui";
import type { Brand } from "../studio";
import { Dropzone, LibraryPicker, MediaView } from "../studio-ui";

const VOICE_LABEL: Record<string, string> = { "": "No voice yet", elevenlabs: "ElevenLabs", openai: "OpenAI", google: "Google" };
type Preset = { id: string; name: string; style: string; topics: string[]; banned: string[]; visuals: string };
const lines = (s: string) => s.split("\n").map(x => x.trim()).filter(Boolean);

export default function BrandKit({ standalone }: { standalone?: boolean }) {
  const toast = useToast();
  const r = useAsync(() => api<{ brand: Brand; voiceProviders: string[] }>("/api/brand"));
  const presets = useAsync(() => api<{ presets: Preset[] }>("/api/brand/presets"));
  const [b, setB] = useState<Brand | null>(null);
  const [banned, setBanned] = useState("");
  const [topics, setTopics] = useState("");
  const [picker, setPicker] = useState(false);
  const [ask, setAsk] = useState<Preset | null>(null);
  const [base, setBase] = useState<Brand | null>(null);
  const take = (x: Brand) => { setB(x); setBase(x); setBanned(x.banned.join("\n")); setTopics((x.topics || []).join("\n")); };
  useEffect(() => { if (r.data) take(r.data.brand); }, [r.data]);
  const head = standalone ? <PageHead title="Brand kit" sub="Your brand: how it sounds, what it talks about, what it never says, and how it looks." /> : null;
  if (!b) return <>{head}{r.error ? <div className="note bad">{r.error}</div> : null}</>;
  const save = async (patch: Partial<Brand> & { banned?: any; topics?: any }, msg = "Brand kit saved") => {
    try { const x = await api<{ brand: Brand }>("/api/brand", { body: patch }); if (Object.keys(patch).join() === "refs") { setB(v => v && { ...v, refs: x.brand.refs }); setBase(v => v && { ...v, refs: x.brand.refs }); } // keep unsaved text edits
      else take(x.brand);
      toast(msg, "ok"); } catch (e) { toast(errText(e), "bad"); }
  };
  const load = async (p: Preset) => { try { take((await api<{ brand: Brand }>("/api/brand/presets", { body: { id: p.id } })).brand); toast(`${p.name} loaded`, "ok"); } catch (e) { toast(errText(e), "bad"); } setAsk(null); };
  const dirty = JSON.stringify(base) !== JSON.stringify({ ...b, banned: lines(banned), topics: lines(topics) });

  return (
    <>
      {head}
      <div className="grid side-r">
        <div className="col gap-16">
          <div className="card">
            <div className="card-head"><h2>How it sounds in writing</h2></div>
            <div className="fields">
              <Field label="Name" hint="Your brand, your persona or your own name. Posts and plans are written as this."><input className="input" value={b.name} placeholder="Your brand" onChange={e => setB({ ...b, name: e.target.value })} /></Field>
              <Field label="Tone guide" hint="A few lines on voice, words you like, how you sign off. Used for posts, campaign plans, tasks and chat.">
                <textarea className="textarea" style={{ minHeight: 140 }} value={b.style} onChange={e => setB({ ...b, style: e.target.value })} placeholder={"Friendly and direct. Short sentences.\nExplains things simply. No hype."} />
              </Field>
              <Field label="Topics" hint="One per line. What the brand talks about; the agent stays on these.">
                <textarea className="textarea" value={topics} onChange={e => setTopics(e.target.value)} placeholder={"home workouts\nmeal prep\nrecovery"} />
              </Field>
              <Field label="Banned phrases" hint="One per line. Posts that use them are blocked, scheduled ones too; the agent is told never to use them.">
                <textarea className="textarea mono" value={banned} onChange={e => setBanned(e.target.value)} placeholder={"to the moon\nguaranteed\n100x"} />
              </Field>
            </div>
          </div>
          <div className="card">
            <div className="card-head"><h2>Visuals</h2><p>Image and video models use these to keep the look consistent.</p></div>
            <div className="label">Reference portraits</div>
            <div className="thumbs mt-8">
              {b.refs.map(p => <div key={p} className="thumb" style={{ width: 96, height: 96 }}><MediaView path={p} /><button className="x" onClick={() => save({ refs: b.refs.filter(x => x !== p) }, "Portrait removed")}>Remove</button></div>)}
            </div>
            {b.refs.length < 8 && (
              <div className="row wrap mt-12">
                <div className="grow" style={{ minWidth: 200 }}><Dropzone to="brand" accept="image/png,image/jpeg,image/webp" label="Drop portraits here (PNG, JPEG, WEBP)" onDone={f => save({ refs: [...b.refs, ...f.map(x => x.path)].slice(0, 8) }, "Portrait added")} /></div>
                <button className="btn sm" onClick={() => setPicker(true)}>From the library</button>
              </div>
            )}
            <p className="tiny muted mt-8">Up to 8. Clear, well-lit, one person, different angles work best.</p>
            <div className="mt-16">
              <Field label="Look" hint="One short paragraph added to image and video prompts: the face, hair, clothes, colours, light.">
                <textarea className="textarea" value={b.visuals} onChange={e => setB({ ...b, visuals: e.target.value })} placeholder="Warm natural light, earthy colours, clean backgrounds, candid framing." />
              </Field>
            </div>
          </div>
        </div>
        <div className="col gap-16">
          <div className="card">
            <div className="card-head"><h2>Start from a preset</h2></div>
            <p className="small muted">Loading a preset replaces the name, tone guide, topics, banned phrases and look, and adds its portrait. Your voice settings stay.</p>
            <div className="list mt-8">
              {presets.data?.presets.map(p => (
                <div key={p.id} className="item">
                  <div className="grow"><div>{p.name}</div><div className="tiny muted">The Claudia influencer persona that 0.2 shipped with.</div></div>
                  <button className="btn sm" onClick={() => setAsk(p)}>Load</button>
                </div>
              ))}
            </div>
          </div>
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
              <Switch checked={b.useInChat} onChange={v => setB({ ...b, useInChat: v })} label="Chat and tasks: give the agent the tone guide and topics" />
              <p className="tiny muted">The Generate studio uses the portraits, look and voice whenever "Use your brand kit" is on.</p>
            </div>
          </div>
          <button className="btn primary" disabled={!dirty} onClick={() => save({ name: b.name, style: b.style, topics: lines(topics), visuals: b.visuals, banned: lines(banned), voice: b.voice, useInChat: b.useInChat, useInSocial: b.useInSocial })}>Save brand kit</button>
        </div>
        {picker && <LibraryPicker kinds={["image"]} onClose={() => setPicker(false)} onPick={o => save({ refs: [...b.refs, o.path].slice(0, 8) }, "Portrait added")} />}
        {ask && (
          <Modal title={`Load ${ask.name}?`} onClose={() => setAsk(null)}>
            <p className="soft">This replaces your name, tone guide, topics, banned phrases and look with {ask.name}'s{dirty ? ", and drops your unsaved changes" : ""}.</p>
            <div className="row mt-16"><button className="btn ghost" onClick={() => setAsk(null)}>Cancel</button><button className="btn primary grow" onClick={() => load(ask)}>Load {ask.name}</button></div>
          </Modal>
        )}
      </div>
    </>
  );
}
