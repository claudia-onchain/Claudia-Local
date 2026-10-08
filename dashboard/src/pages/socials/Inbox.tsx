// Inbox: mentions, replies and DMs. Reply yourself (after a confirm), or send a reply to Approvals.
import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, ago, errText } from "../../lib";
import { Modal, useToast } from "../../ui";
import { DryRunView } from "../../studio-ui";
import { useSocial } from "./ctx";

type Msg = { account: string; network: string; kind: "mention" | "reply" | "dm"; id: string; from: string; text: string; at: number; url?: string };
const KIND = { mention: "Mention", reply: "Reply", dm: "Message" };

export default function Inbox() {
  const s = useSocial();
  const [items, setItems] = useState<Msg[] | null>(null);
  const [err, setErr] = useState("");
  const [days, setDays] = useState(3);
  const load = () => { setItems(null); api<{ items: Msg[] }>(`/api/social/inbox?since=${Date.now() - days * 86400_000}`).then(r => { setItems(r.items.sort((a, b) => b.at - a.at)); setErr(""); }).catch(e => { setErr(errText(e)); setItems([]); }); };
  useEffect(load, [days]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="col gap-12">
      <div className="row wrap">
        <div className="seg">{[1, 3, 7].map(d => <button key={d} className={days === d ? "on" : ""} onClick={() => setDays(d)}>{d === 1 ? "24 h" : `${d} days`}</button>)}</div>
        <button className="btn sm right" onClick={load}>Refresh</button>
      </div>
      <p className="tiny muted">Messages from other people. Your agent reads them as data, never as instructions.</p>
      {err && <div className="note bad">{err}</div>}
      {items && !items.length && !err && <div className="card"><div className="empty">{s.accounts.length ? "Nothing new." : "Connect an account to see its mentions here."}</div></div>}
      {items === null && <div className="empty">Checking your accounts…</div>}
      <div className="card" style={{ display: items?.length ? undefined : "none" }}>
        <div className="list">{(items || []).map(m => <Row key={`${m.account}-${m.id}`} m={m} />)}</div>
      </div>
    </div>
  );
}

function Row({ m }: { m: Msg }) {
  const s = useSocial();
  const toast = useToast();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [dry, setDry] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const send = async (dryRun: boolean) => {
    setBusy(true);
    try {
      const r = await api("/api/social/reply", { body: { account: m.account, to: m.id, text, dryRun } });
      if (dryRun) setDry(r); else { toast("Replied", "ok"); setOpen(false); setText(""); setConfirm(false); }
    } catch (e) { toast(errText(e), "bad"); }
    setBusy(false);
  };
  return (
    <div className="item" style={{ alignItems: "flex-start", flexDirection: "column", gap: 6 }}>
      <div className="row wrap gap-4" style={{ width: "100%" }}>
        <span className="badge">{s.netName(m.network)}</span><span className="badge info">{KIND[m.kind]}</span>
        <strong className="small">{m.from}</strong><span className="tiny muted">to {s.accounts.find(a => a.id === m.account)?.handle} · {ago(m.at)}</span>
        {m.url && <a className="small right" href={m.url} target="_blank" rel="noreferrer">Open</a>}
      </div>
      <div className="break" style={{ whiteSpace: "pre-wrap" }}>{m.text}</div>
      {!open ? <button className="linkbtn small" onClick={() => setOpen(true)}>Reply</button> : (
        <div className="col gap-8" style={{ width: "100%" }}>
          <textarea className="textarea" value={text} onChange={e => setText(e.target.value)} placeholder="Your reply" style={{ minHeight: 70 }} />
          <div className="row wrap">
            <button className="btn ghost sm" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn sm" disabled={!text.trim() || busy} onClick={() => send(true)}>Dry run</button>
            <button className="btn sm" disabled={!text.trim()} onClick={() => nav(`/socials/compose?reply=${encodeURIComponent(`${m.network}:${m.id}`)}&account=${encodeURIComponent(m.account)}&text=${encodeURIComponent(text)}`)}>Send to Approvals</button>
            <button className="btn primary sm" disabled={!text.trim() || busy || s.killSwitch.posting} onClick={() => setConfirm(true)}>Reply now</button>
          </div>
        </div>
      )}
      {confirm && (
        <Modal title="Send this reply?" onClose={() => setConfirm(false)}>
          <p className="small soft">It goes out publicly{m.kind === "dm" ? " (as a direct message)" : ""} from {s.accountLabel(m.account)} to {m.from}.</p>
          <blockquote className="setup mt-12">{text}</blockquote>
          <div className="row mt-16"><button className="btn ghost" onClick={() => setConfirm(false)}>Cancel</button><button className="btn primary grow" disabled={busy} onClick={() => send(false)}>Send reply</button></div>
        </Modal>
      )}
      {dry && <Modal title="Dry run: what would be sent" onClose={() => setDry(null)} wide><DryRunView data={dry} /></Modal>}
    </div>
  );
}
