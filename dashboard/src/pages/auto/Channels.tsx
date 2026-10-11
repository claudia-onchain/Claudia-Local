// Settings → Channels: Telegram. Your own bot, long polling only (no webhook, no open port), paired accounts only.
import { useState } from "react";
import { api, errText } from "../../lib";
import { Copyable, Switch, useAsync, useToast } from "../../ui";
import { fmtTime, useAutoEvents, type Telegram } from "./auto";

export default function Channels() {
  const toast = useToast();
  const r = useAsync(() => api<Telegram>("/api/telegram"));
  useAutoEvents(e => { if (e.topic === "telegram") r.setData(e.data); });
  const [token, setToken] = useState("");
  const t = r.data;
  const act = async (fn: () => Promise<Telegram | unknown>, ok?: string) => {
    try { const x = await fn(); if (x && typeof x === "object" && "tokenSet" in (x as object)) r.setData(x as Telegram); else r.reload(); if (ok) toast(ok, "ok"); } catch (e) { toast(errText(e), "bad"); }
  };
  const saveToken = () => act(async () => { await api("/api/keys/telegram-chat", { body: { fields: { key: token.trim() } } }); setToken(""); return api<Telegram>("/api/telegram"); }, "Bot token saved (encrypted)");
  return (
    <div className="card" id="channels">
      <div className="card-head"><h2>Channels</h2><p>Chat with your agent from Telegram, get task results and approve things on the go.</p></div>
      {!t ? null : (
        <div className="col gap-12">
          <div className="list">
            <div className="item" style={{ alignItems: "flex-start" }}>
              <div className="grow">
                <div>Telegram bot</div>
                <div className="small muted">Make a bot with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> and paste its token. Use a different bot from the one that posts to your channel. Claudia Local only reads it while it's open and unlocked; no webhook, no open port.</div>
                <div className="row mt-8">
                  <input className="input mono" type="password" autoComplete="off" spellCheck={false} placeholder={t.tokenSet ? "••••••••  (saved)" : "123456:ABC…"} value={token} onChange={e => setToken(e.target.value)} />
                  <button className="btn" disabled={!token.trim()} onClick={saveToken}>Save</button>
                </div>
              </div>
            </div>
            <div className="item">
              <div className="grow">
                <div>Connected{t.bot?.username ? <> as <span className="mono">@{t.bot.username}</span></> : ""}</div>
                <div className="small muted">{t.enabled ? (t.polling ? `Listening${t.lastOk ? `, last contact ${fmtTime(t.lastOk)}` : ""}.` : "Waiting to start.") : "Off."}</div>
                {t.error && <div className="small error mt-4">{t.error}</div>}
              </div>
              <Switch checked={t.enabled} disabled={!t.tokenSet} onChange={v => act(() => api("/api/telegram/connect", { body: { enabled: v } }), v ? "Bot connected" : "Bot switched off")} />
            </div>
          </div>
          {t.enabled && (
            <>
              <div className="card tight flat">
                <div className="row wrap">
                  <div className="grow">
                    <div>Pair your Telegram account</div>
                    {t.pairing
                      ? <div className="small soft mt-4">Send this to <span className="mono">@{t.bot?.username || "your bot"}</span> within 10 minutes (until {new Date(t.pairing.expiresAt).toLocaleTimeString()}): <Copyable text={`/pair ${t.pairing.code}`} /></div>
                      : <div className="small muted mt-4">Only paired accounts get answers. Everyone else hears "This bot is private." once.</div>}
                  </div>
                  <button className="btn sm" onClick={() => act(() => api("/api/telegram/pair", { body: {} }))}>{t.pairing ? "New code" : "Show a code"}</button>
                </div>
              </div>
              <div>
                <div className="label">Paired accounts</div>
                {!t.owners.length && <div className="small muted mt-4">None yet.</div>}
                <div className="list">
                  {t.owners.map(o => (
                    <div key={o.id} className="item">
                      <span className="grow small">{o.name} <span className="mono tiny muted">{o.id}</span></span>
                      <span className="tiny muted hide-phone">since {fmtTime(o.pairedAt)}</span>
                      <button className="btn ghost sm" onClick={() => { if (confirm(`Unpair ${o.name}?`)) act(() => api(`/api/telegram/owners/${encodeURIComponent(o.id)}`, { method: "DELETE" }), "Unpaired"); }}>Unpair</button>
                    </div>
                  ))}
                </div>
              </div>
              <div className="row wrap">
                <button className="btn sm" disabled={!t.owners.length || !t.polling} onClick={() => act(() => api("/api/telegram/test", { body: {} }), "Test message sent")}>Send a test message</button>
                <span className="tiny muted">Voice notes: {t.voice.openai ? "transcribed with your OpenAI key" : t.voice.groq ? "transcribed with your Groq key" : "add an OpenAI or Groq key under Keys and providers to use them"}.</span>
              </div>
              <p className="tiny muted">Your own messages count as you. Forwarded messages and quoted text are treated as other people's words. Posts and trades always need a button press, and trades show the dry-run numbers and need a second confirm.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
}
