// Composer: write once, override per network, add media, see the live preview for every account, send to Approvals.
import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api, errText } from "../../lib";
import { Field, Modal, Switch, useToast } from "../../ui";
import { fromLocalInput, money, toLocalInput, type Post, type PostInput, type Preview } from "../../studio";
import { DryRunView, Dropzone, LibraryPicker, MediaView } from "../../studio-ui";
import { useSocial } from "./ctx";

/**
 * Per-network settings passed as PostInput.options[network] (names follow @useclaudia/social's connectors).
 * Developers: add a network's options here and they show up when one of its accounts is picked.
 */
const NET_OPTIONS: Record<string, { id: string; label: string; choices?: [string, string][] }[]> = {
  youtube: [{ id: "title", label: "Video title" }, { id: "privacyStatus", label: "Visibility", choices: [["private", "Private"], ["unlisted", "Unlisted"], ["public", "Public"]] }],
  tiktok: [{ id: "privacyLevel", label: "Who can see it", choices: [["SELF_ONLY", "Only me"], ["MUTUAL_FOLLOW_FRIENDS", "Friends"], ["FOLLOWER_OF_CREATOR", "Followers"], ["PUBLIC_TO_EVERYONE", "Everyone"]] }],
  pinterest: [{ id: "boardId", label: "Board id" }, { id: "title", label: "Pin title" }],
};

export default function Composer() {
  const s = useSocial();
  const toast = useToast();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const [text, setText] = useState(params.get("text") || "");
  const [targets, setTargets] = useState<string[]>(() => {
    const a = params.get("account");
    return a && s.accounts.some(x => x.id === a) ? [a] : s.accounts.map(x => x.id);
  });
  const [overrides, setOverrides] = useState<Record<string, string>>({});
  const [media, setMedia] = useState<{ path: string; mime?: string; alt?: string }[]>(() => (params.get("media") ? [{ path: params.get("media")! }] : []));
  const [link, setLink] = useState("");
  const [at, setAt] = useState("");
  const [labels, setLabels] = useState({ ai: true, ad: false, nfa: false });
  const [options, setOptions] = useState<Record<string, Record<string, string>>>({});
  const replyTo = params.get("reply") ? { network: params.get("reply")!.split(":")[0], id: params.get("reply")!.split(":").slice(1).join(":") } : undefined;
  const [picker, setPicker] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Preview[]>([]);
  const [pvErr, setPvErr] = useState("");
  const [dry, setDry] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const saving = useRef(Promise.resolve<string | null>(null));

  const nets = [...new Set(targets.map(id => s.accounts.find(a => a.id === id)?.network).filter(Boolean) as string[])];
  const input = (): PostInput => ({
    // null (not undefined) so clearing a field clears it on the server too.
    text, media, link: (link || null) as any, scheduleAt: (fromLocalInput(at) ?? null) as any, labels, replyTo,
    ...(Object.keys(options).length ? { options } : {}),
    targets: targets.map(account => { const n = s.accounts.find(a => a.id === account)?.network || ""; return overrides[n] ? { account, text: overrides[n] } : { account }; }),
  });

  // Keep a draft on the server so the preview is exactly what the social package will publish.
  useEffect(() => {
    if (!targets.length || (!text.trim() && !media.length)) { setPreviews([]); return; }
    const t = setTimeout(() => {
      saving.current = saving.current.then(async (id) => {
        try {
          const p = id ? await api<Post>(`/api/social/posts/${id}`, { body: { input: input() } }) : await api<Post>("/api/social/posts", { body: { input: input() } });
          setDraftId(p.id);
          const r = await api<{ previews: Preview[] }>(`/api/social/posts/${p.id}/preview`);
          setPreviews(r.previews); setPvErr("");
          return p.id;
        } catch (e) { setPvErr(errText(e)); return id; }
      });
    }, 500);
    return () => clearTimeout(t);
  }, [text, targets.join(","), JSON.stringify(overrides), JSON.stringify(media), link, at, JSON.stringify(labels), JSON.stringify(options)]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    setBusy(true);
    try {
      const id = await saving.current;
      if (!id) throw new Error("Write something and pick an account first.");
      await api(`/api/social/posts/${id}`, { body: { input: input() } });
      await api(`/api/social/posts/${id}/submit`, { body: {} });
      toast("Sent to Approvals", "ok");
      nav("/socials");
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const dryRun = async () => {
    try { const id = await saving.current; if (!id) return; setDry(await api(`/api/social/posts/${id}/publish`, { body: { dryRun: true } })); } catch (e) { toast(errText(e), "bad"); }
  };

  if (!s.accounts.length) return <div className="card"><div className="empty">Connect an account first: <Link to="/socials/connections">Connections</Link>.</div></div>;
  const blocked = previews.filter(p => p.blocked);
  const cost = previews.reduce((n, p) => n + (p.costUsd || 0), 0);

  return (
    <div className="grid two" style={{ alignItems: "start" }}>
      <div className="card">
        <div className="fields">
          {replyTo && <div className="note small">Replying to {s.netName(replyTo.network)} post <span className="mono">{replyTo.id}</span>.</div>}
          <Field label="Post to">
            <div className="row wrap">
              {s.accounts.map(a => (
                <label key={a.id} className={`check${targets.includes(a.id) ? " on" : ""}`}>
                  <input type="checkbox" checked={targets.includes(a.id)} onChange={e => setTargets(t => (e.target.checked ? [...t, a.id] : t.filter(x => x !== a.id)))} />
                  {s.netName(a.network)} <span className="muted">{a.handle}</span>
                </label>
              ))}
            </div>
          </Field>
          <Field label="Post" hint={`${text.length} characters`}>
            <textarea className="textarea" style={{ minHeight: 140 }} value={text} onChange={e => setText(e.target.value)} placeholder="Write it once. Override it per network below if you like." />
          </Field>
          {nets.length > 0 && (
            <details className="more">
              <summary>Different text per network</summary>
              <div className="fields mt-8">
                {nets.map(n => {
                  const max = s.networks.find(x => x.id === n)?.limits.maxChars;
                  return (
                    <Field key={n} label={s.netName(n)} hint={overrides[n] ? `${overrides[n].length}${max ? ` / ${max}` : ""} characters` : "Empty uses the main text."}>
                      <textarea className="textarea" style={{ minHeight: 64 }} value={overrides[n] || ""} onChange={e => setOverrides({ ...overrides, [n]: e.target.value })} />
                    </Field>
                  );
                })}
              </div>
            </details>
          )}
          {nets.filter(n => NET_OPTIONS[n]).map(n => (
            <Field key={n} label={`${s.netName(n)} settings`}>
              <div className="fields two">
                {NET_OPTIONS[n].map(o => {
                  const v = options[n]?.[o.id] || "";
                  const set = (x: string) => setOptions({ ...options, [n]: { ...(options[n] || {}), [o.id]: x } });
                  return o.choices
                    ? <select key={o.id} className="select" value={v} onChange={e => set(e.target.value)} aria-label={o.label}><option value="">{o.label}: default</option>{o.choices.map(([cv, cl]) => <option key={cv} value={cv}>{o.label}: {cl}</option>)}</select>
                    : <input key={o.id} className="input" placeholder={o.label} value={v} onChange={e => set(e.target.value)} />;
                })}
              </div>
            </Field>
          ))}
          <Field label="Media">
            {media.length > 0 && (
              <div className="thumbs">
                {media.map(m => <div key={m.path} className="thumb"><MediaView path={m.path} mime={m.mime} /><button className="x" onClick={() => setMedia(x => x.filter(y => y.path !== m.path))}>Remove</button></div>)}
              </div>
            )}
            <div className="row wrap">
              <button className="btn sm" onClick={() => setPicker(true)}>From the library</button>
              <div className="grow" style={{ minWidth: 160 }}><Dropzone accept="image/*,video/*" label="or drop a file" onDone={f => setMedia(x => [...x, ...f].slice(0, 10))} /></div>
            </div>
          </Field>
          <div className="fields two">
            <Field label="Link (optional)"><input className="input" placeholder="https://useclaudia.xyz/…" value={link} onChange={e => setLink(e.target.value)} /></Field>
            <Field label="Publish at" hint="Empty: right after you approve it."><input className="input" type="datetime-local" value={at} min={toLocalInput(Date.now())} onChange={e => setAt(e.target.value)} /></Field>
          </div>
          <div className="col gap-8">
            <Switch checked={labels.ai} onChange={v => setLabels({ ...labels, ai: v })} label={<span>Label as made with AI <span className="muted small">(networks expect it)</span></span>} />
            <Switch checked={labels.nfa} onChange={v => setLabels({ ...labels, nfa: v })} label={<span>Add "not financial advice" <span className="muted small">(added anyway when a coin or price is mentioned)</span></span>} />
            <Switch checked={labels.ad} onChange={v => setLabels({ ...labels, ad: v })} label="It's a paid promotion" />
          </div>
        </div>
        <hr className="hr" />
        <div className="row wrap">
          <span className="small muted grow">{cost > 0 ? `X bills about ${money(cost)} for this.` : ""}</span>
          <button className="btn" disabled={!draftId} onClick={dryRun}>Dry run</button>
          <button className="btn primary" disabled={!draftId || busy || !targets.length} onClick={send}>Send to Approvals</button>
        </div>
      </div>

      <div className="col gap-12">
        <div className="row"><h2 style={{ fontSize: 15.5 }} className="grow">Preview</h2>{blocked.length > 0 && <span className="badge bad">{blocked.length} blocked</span>}</div>
        {pvErr && <div className="note bad small">{pvErr}</div>}
        {!previews.length && !pvErr && <div className="card"><div className="empty">Start writing to see each network's version, with the labels it adds.</div></div>}
        {previews.map(p => {
          const max = s.networks.find(n => n.id === p.network)?.limits.maxChars;
          return (
            <div key={p.account} className={`preview${p.blocked ? " blocked" : ""}`}>
              <div className="row wrap gap-4"><strong>{s.netName(p.network)}</strong><span className="small muted">{s.accounts.find(a => a.id === p.account)?.handle}</span>
                <span className={`tiny num right ${max && p.chars > max ? "sell" : "muted"}`}>{p.chars}{max ? ` / ${max}` : ""}</span></div>
              <div className="body">{p.text}</div>
              {(p.media > 0 || p.labelsAdded.length > 0 || p.costUsd) && (
                <div className="row wrap gap-4">
                  {p.media > 0 && <span className="badge">{p.media} media</span>}
                  {p.labelsAdded.map(l => <span key={l} className="badge info">+ {l === "ai" ? "AI label" : l === "nfa" ? "not financial advice" : l}</span>)}
                  {!!p.costUsd && <span className="badge copper">{money(p.costUsd)}</span>}
                </div>
              )}
              {p.warnings.map((w, i) => <div key={i} className="note warn small">{w}</div>)}
              {p.blocked && <div className="note bad small">Blocked: {p.blocked}</div>}
            </div>
          );
        })}
      </div>
      {picker && <LibraryPicker kinds={["image", "video", "avatar"]} onClose={() => setPicker(false)} onPick={o => setMedia(x => [...x, o].slice(0, 10))} />}
      {dry && <Modal title="Dry run: what would be sent" onClose={() => setDry(null)} wide><DryRunView data={dry} /></Modal>}
    </div>
  );
}
