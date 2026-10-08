// Connections: per network, the setup steps, the redirect URI to register, keys, connect, expiry, daily caps.
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, errText } from "../../lib";
import { Copyable, Field, Modal, useAsync, useToast } from "../../ui";
import { when, type Account, type NetworkInfo } from "../../studio";
import { useSocial } from "./ctx";

/**
 * Extra details some networks need when you connect (names follow @useclaudia/social's connect params).
 * Developers: add a network's fields here if its connector needs more than the keys in Settings.
 */
const CONNECT_PARAMS: Record<string, { id: string; label: string; placeholder?: string; optional?: boolean }[]> = {
  telegram: [{ id: "chat", label: "Channel or group", placeholder: "@yourchannel or -100…" }, { id: "topicId", label: "Topic id (optional)", optional: true }],
  discord: [{ id: "webhookUrl", label: "Webhook URL (if not saved in Settings)", placeholder: "https://discord.com/api/webhooks/…", optional: true }, { id: "channelId", label: "Channel id (bots only)", placeholder: "123456789012345678", optional: true }],
  bluesky: [{ id: "handle", label: "Handle (if not saved in Settings)", placeholder: "you.bsky.social", optional: true }],
  mastodon: [{ id: "instance", label: "Server (if not saved in Settings)", placeholder: "mastodon.social", optional: true }],
  pinterest: [{ id: "boardId", label: "Board id (optional)", optional: true }],
  nostr: [{ id: "relays", label: "Relays (optional, comma separated)", placeholder: "wss://relay.damus.io, wss://nos.lol", optional: true }],
};
/** Which Settings → Keys row a network uses, when it isn't the network's own id. */
const KEY_FOR: Record<string, string> = { instagram: "meta", facebook: "meta", threads: "meta", farcaster: "neynar" };
const TIERS: [NetworkInfo["tier"], string, string][] = [
  ["direct", "Direct", "Claudia Local talks to the network with your own key or app."],
  ["service", "Through a posting service", "One key reaches the accounts you connected inside the service."],
  ["v2", "Needs your own reviewed app", "These networks only allow apps that passed their review."],
  ["later", "Coming later", ""],
  ["skip", "Not supported", "Claudia doesn't post here, and why."],
];
const AUTH_LABEL: Record<string, string> = { "oauth-loopback": "Sign in", "oauth-relay": "Sign in (via relay)", key: "Key", service: "Service" };

export default function Connections() {
  const s = useSocial();
  const keys = useAsync(() => api<{ providers: { id: string; configured: boolean }[] }>("/api/keys"));
  const keySet = (net: string) => keys.data?.providers.find(p => p.id === (KEY_FOR[net] || net))?.configured;
  return (
    <div className="col gap-16">
      <div className="note">
        <div><strong>Redirect URIs.</strong> When a network asks for one, register <Copyable text={s.redirects.loopback} /> if it accepts addresses on your own computer, otherwise <Copyable text={s.redirects.relay} />.</div>
        <div className="small muted mt-4">The relay only bounces the sign-in back to 127.0.0.1 on this computer. It stores nothing, and the code is useless without your app's secret, which stays here.</div>
      </div>
      {TIERS.map(([tier, label, about]) => {
        const nets = s.networks.filter(n => n.tier === tier);
        if (!nets.length) return null;
        return (
          <div key={tier} className="card">
            <div className="card-head"><h2>{label}</h2>{about && <p>{about}</p>}</div>
            <div className="list">{nets.map(n => <NetRow key={n.id} n={n} keySet={keySet(n.id)} />)}</div>
          </div>
        );
      })}
    </div>
  );
}

function NetRow({ n, keySet }: { n: NetworkInfo; keySet?: boolean }) {
  const s = useSocial();
  const toast = useToast();
  const accounts = s.accounts.filter(a => a.network === n.id || a.via === n.id);
  const [ask, setAsk] = useState(false);
  const [params, setParams] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState("");
  const [cap, setCap] = useState(String(s.postCaps[n.id] ?? ""));
  const fields = CONNECT_PARAMS[n.id] || [];
  const redirect = n.auth === "oauth-loopback" ? s.redirects.loopback : n.auth === "oauth-relay" ? s.redirects.relay : "";
  const later = n.tier === "later" || n.tier === "skip";
  const reason = (n as NetworkInfo & { reason?: string }).reason;

  const connect = async () => {
    setBusy(true);
    try {
      const r = await api<Account | { authorizeUrl: string; state: string }>("/api/social/connect", { body: { network: n.id, params } });
      if ("authorizeUrl" in r) {
        window.open(r.authorizeUrl, "_blank", "noopener,noreferrer");
        setWaiting(`Finish signing in to ${n.name} in the new tab. It comes back to ${redirect || s.redirects.loopback}.`);
      } else { toast(`Connected ${n.name} ${r.handle}`, "ok"); s.reload(); }
      setAsk(false);
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  const disconnect = async (id: string) => {
    if (!confirm("Disconnect this account? Drafts for it stay, but they can't publish there.")) return;
    try { await api(`/api/social/accounts/${encodeURIComponent(id)}`, { method: "DELETE" }); s.reload(); } catch (e) { toast(errText(e), "bad"); }
  };
  const saveCap = async () => {
    try { await api("/api/social/caps", { body: { postCaps: { [n.id]: Number(cap) || 0 } } }); toast("Cap saved", "ok"); s.reload(); } catch (e) { toast(errText(e), "bad"); }
  };

  return (
    <div className="provider">
      <div className="row wrap">
        <div className="grow">
          <div className="row wrap gap-4"><strong>{n.name}</strong>{!later && <span className="badge">{AUTH_LABEL[n.auth] || n.auth}</span>}{n.costHint && <span className="badge copper">{n.costHint}</span>}</div>
          {!later && <div className="tiny muted mt-4">
            {[n.caps.text && "text", n.caps.image && "images", n.caps.video && "video", n.caps.thread && "threads", n.caps.reply && "replies", n.caps.inbox && "inbox"].filter(Boolean).join(" · ")}
            {n.limits?.maxChars ? ` · ${n.limits.maxChars} characters` : ""}
          </div>}
        </div>
        {!later && <button className="btn sm" disabled={busy} onClick={() => (fields.length ? setAsk(true) : connect())}>{accounts.length ? "Connect another" : "Connect"}</button>}
      </div>
      {later && reason && <div className="small muted mt-4">{reason}</div>}
      {accounts.map(a => {
        const soon = a.expiresAt && a.expiresAt - Date.now() < 7 * 86400_000;
        return (
          <div key={a.id} className="row wrap mt-8 small">
            <span className="dot ok" /><span>{a.handle}{a.name ? ` · ${a.name}` : ""}</span>
            {a.via && <span className="badge">via {s.netName(a.via)}</span>}
            {a.expiresAt && <span className={`badge ${soon ? "bad" : ""}`}>{a.expiresAt > Date.now() ? `Sign-in ends ${when(a.expiresAt)}` : "Sign-in expired, connect again"}</span>}
            <button className="linkbtn small right" onClick={() => disconnect(a.id)}>Disconnect</button>
          </div>
        );
      })}
      {waiting && <div className="note brand small mt-8">{waiting}</div>}
      {!later && <details className="more mt-8">
        <summary>How to set it up</summary>
        <div className="col gap-8 mt-8">
          <div className="setup">{n.setup}</div>
          {redirect && <div className="small">Redirect URI to register: <Copyable text={redirect} /></div>}
          <div className="small">Keys: {keySet === undefined ? "–" : keySet ? <span className="buy">saved</span> : <span className="muted">not saved yet</span>} · <Link to="/settings#keys">Settings → Keys and providers</Link>{n.docs && <> · <a href={n.docs} target="_blank" rel="noreferrer">{n.name} docs</a></>}</div>
          {!later && (
            <div className="row wrap small">
              <span className="soft">Your daily cap</span>
              <input className="input num" style={{ width: 80, minHeight: 30 }} inputMode="numeric" value={cap} placeholder="none" onChange={e => setCap(e.target.value)} aria-label={`Daily cap for ${n.name}`} />
              <button className="btn sm" disabled={String(s.postCaps[n.id] ?? "") === cap} onClick={saveCap}>Save</button>
              <span className="muted">Published today: {s.today[n.id] || 0}{n.limits.perDay ? ` · ${n.name}'s own limit: ${n.limits.perDay} a day` : ""}</span>
            </div>
          )}
        </div>
      </details>}
      {ask && (
        <Modal title={`Connect ${n.name}`} onClose={() => setAsk(false)}>
          <div className="fields">
            {fields.map(f => <Field key={f.id} label={f.label}><input className="input" placeholder={f.placeholder} value={params[f.id] || ""} onChange={e => setParams({ ...params, [f.id]: e.target.value })} /></Field>)}
          </div>
          <div className="row mt-16"><button className="btn ghost" onClick={() => setAsk(false)}>Cancel</button><button className="btn primary grow" disabled={busy || fields.some(f => !f.optional && !params[f.id]?.trim())} onClick={connect}>Connect</button></div>
        </Modal>
      )}
    </div>
  );
}
