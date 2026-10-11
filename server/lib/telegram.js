/**
 * telegram.js — talk to your agent from Telegram, get task results and approve things on the go.
 *
 * Uses your own bot (Settings → Keys and providers → "Telegram chat bot"; a separate bot from the one
 * that posts to your channel, because a bot's updates can only be read by one program at a time).
 * Outbound only: long polling with getUpdates while Claudia Local is open and unlocked. No webhook,
 * no open port.
 *
 * Pairing: the dashboard shows a 6-digit code for 10 minutes; send "/pair 123456" to the bot. Only
 * paired Telegram user ids are answered; anyone else gets "This bot is private." once and is then
 * ignored. A paired owner's own text counts as you; forwarded messages and quoted text are outside
 * content (untrusted.wrap "channel"). Posts and trades still need a button press, and live trades
 * show the dry-run numbers and need a second "Confirm trade" press.
 *
 * CLAUDIA_LOCAL_TELEGRAM_BASE points at another Bot API server (a local mock for tests); only https://
 * or a loopback http:// address is accepted.
 */
import { randomInt } from "node:crypto";
import { getChat, deleteChat, trackActivity } from "./store.js";
import * as vault from "./vault.js";
import { providerValue } from "./providers.js";
import * as approvals from "./approvals.js";
import * as runner from "./runner.js";
import * as tasks from "./tasks.js";
import * as untrusted from "./untrusted.js";

export const CHAT_ID = "telegram";
const PROVIDER = "telegram-chat";
const PAIR_MS = 10 * 60_000;
const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const clip = (s, n = 200) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

let log = () => {};
let emit = () => {};
let pairing = null;          // { code, expiresAt, tries }
let loop = null;             // { ac }
let status = { polling: false, lastOk: 0, error: null };
let turn = null;             // { ac } while a Telegram chat turn runs
const queue = [];

function base() {
  const o = process.env.CLAUDIA_LOCAL_TELEGRAM_BASE?.trim();
  if (!o) return "https://api.telegram.org";
  const u = new URL(o);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname))) throw new Error("CLAUDIA_LOCAL_TELEGRAM_BASE must be https:// or a local http:// address");
  return o.replace(/\/+$/, "");
}
const token = () => (vault.isUnlocked() ? providerValue(PROVIDER, "key") : null);
const settings = () => tasks.autonomy().telegram;
const saveSettings = (fn) => { const a = tasks.autonomy(); fn(a.telegram); tasks.saveAutonomy(a); emit("telegram", info()); };
export const owners = () => settings().owners || [];
const isOwner = (id) => owners().some((o) => String(o.id) === String(id));

async function api(method, params = {}, { signal, timeoutMs = 15_000 } = {}) {
  const t = token();
  if (!t) throw err(409, "Add the Telegram chat bot token first.");
  const sig = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  const r = await fetch(`${base()}/bot${t}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params), signal: sig, redirect: "error" });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw err(r.status === 401 || r.status === 404 ? 401 : 502, j.description ? `Telegram: ${j.description}` : `Telegram answered ${r.status}.`, String(r.status));
  return j.result;
}

/** Split long text into Telegram-sized messages (4096 max). */
function chunks(text) {
  const s = String(text || "").trim() || "(empty)";
  const out = [];
  for (let i = 0; i < s.length && out.length < 6; i += 3900) out.push(s.slice(i, i + 3900));
  return out;
}
export async function sendTo(chatId, text, extra = {}) {
  let last = null;
  const parts = chunks(text);
  for (let i = 0; i < parts.length; i++) last = await api("sendMessage", { chat_id: chatId, text: parts[i], disable_web_page_preview: true, ...(i === parts.length - 1 ? extra : {}) });
  return last;
}

/** Task results and heartbeat check-ins. Returns true when at least one owner got it. */
export async function notify(text, extra = {}) {
  if (!status.polling || !owners().length) return false;
  let sent = 0;
  for (const o of owners()) { try { await sendTo(o.id, text, extra); sent++; } catch (e) { log(`[telegram] send: ${e.message}`); } }
  return sent > 0;
}

// ── dashboard side ─────────────────────────────────────────────────────────
export function info() {
  const s = settings();
  return {
    tokenSet: !!token(), enabled: !!s.enabled, bot: s.bot || null, polling: status.polling, lastOk: status.lastOk || null, error: status.error,
    owners: owners().map((o) => ({ id: String(o.id), name: o.name, pairedAt: o.pairedAt })),
    pairing: pairing && pairing.expiresAt > Date.now() ? { code: pairing.code, expiresAt: pairing.expiresAt } : null,
    voice: { openai: !!providerValue("openai", "key"), groq: !!providerValue("groq", "key") },
  };
}

export async function connect(enabled) {
  if (!enabled) { saveSettings((t) => { t.enabled = false; }); stop(); trackActivity("telegram", "Telegram channel switched off"); return info(); }
  const me = await api("getMe");
  saveSettings((t) => { t.enabled = true; t.bot = { id: me.id, username: me.username || "", name: me.first_name || "" }; });
  api("setMyCommands", { commands: [
    { command: "pair", description: "Pair with the code from Claudia Local" }, { command: "status", description: "Tasks, approvals and today's budget" },
    { command: "pending", description: "What's waiting for your approval" }, { command: "new", description: "Start a fresh chat" },
    { command: "stop", description: "Pause every task and the heartbeat" }, { command: "resume", description: "Resume tasks and the heartbeat" },
  ] }).catch(() => {});
  trackActivity("telegram", `Telegram channel on (@${me.username || me.id})`);
  supervise();
  return info();
}

export function newPairingCode() {
  if (!settings().enabled || !token()) throw err(409, "Connect the bot first.");
  pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, "0"), expiresAt: Date.now() + PAIR_MS, tries: 0 };
  emit("telegram", info());
  return info();
}

export function unpair(id) {
  saveSettings((t) => { t.owners = (t.owners || []).filter((o) => String(o.id) !== String(id)); });
  trackActivity("telegram", "Telegram user unpaired");
  return info();
}

export async function test() {
  if (!owners().length) throw err(409, "Pair a Telegram account first.");
  if (!status.polling) throw err(409, "The bot isn't connected right now.");
  const ok = await notify("Test from Claudia Local. Task results, check-ins and approvals will arrive here.");
  if (!ok) throw err(502, "Telegram didn't take the message. Check the bot token.");
  return { ok: true };
}

// ── approvals over Telegram ────────────────────────────────────────────────
const sentFor = new Map(); // approval id -> [{ chat_id, message_id }]

function itemText(it) {
  const head = { question: "Question from your agent", thread_post: "Post in the Claudia thread?", social_post: "Publish this social post?", trade: "Trade suggestion" }[it.kind] || "Approval";
  const d = it.detail || {};
  const body = it.kind === "thread_post" ? `#${d.room}\n\n${d.content}` : it.kind === "social_post" ? `${d.text || ""}` : it.kind === "trade" ? `${it.question}\n${d.reason ? `Why: ${d.reason}` : ""}` : it.question;
  const from = it.source === "task" || it.source === "heartbeat" || it.source === "watcher" ? `\n\nFrom a ${it.source === "watcher" ? "watcher-started task" : it.source}${it.origin !== "user" ? " that read outside content" : ""}.` : "";
  return `${head}\n\n${body}${from}`;
}
function itemButtons(it) {
  if (it.status === "confirm") return { inline_keyboard: [[{ text: "Confirm trade", callback_data: `c:${it.id}` }, { text: "Cancel", callback_data: `x:${it.id}` }]] };
  if (it.status !== "pending" || !it.options.length) return undefined;
  return { inline_keyboard: [it.options.slice(0, 4).map((label, i) => ({ text: label.slice(0, 40), callback_data: `a:${it.id}:${i}` }))] };
}
function statusLine(it) {
  if (it.status === "confirm") return `\n\nDry run:\n${approvals.previewText(it.preview)}`;
  if (it.status === "pending") return "";
  const who = it.answer?.by ? ` (${it.answer.by})` : "";
  const ans = it.answer ? `: ${it.answer.custom || (it.answer.answers || []).join(", ")}` : "";
  return `\n\n${{ answered: "Answered", denied: "Denied", done: "Done", failed: "Failed", expired: "Expired", canceled: "Canceled" }[it.status] || it.status}${ans}${who}${it.result ? `\n${it.result}` : ""}`;
}

async function pushItem(it) {
  if (!status.polling) return;
  const list = [];
  for (const o of owners()) {
    try { const m = await sendTo(o.id, itemText(it) + statusLine(it), { reply_markup: itemButtons(it) }); list.push({ chat_id: o.id, message_id: m.message_id }); } catch (e) { log(`[telegram] approval: ${e.message}`); }
  }
  if (list.length) sentFor.set(it.id, list);
}
async function refreshItem(it) {
  for (const m of sentFor.get(it.id) || []) {
    try { await api("editMessageText", { ...m, text: (itemText(it) + statusLine(it)).slice(0, 4000), reply_markup: itemButtons(it) || { inline_keyboard: [] } }); } catch { /* message gone or unchanged */ }
  }
  if (!["pending", "confirm"].includes(it.status)) sentFor.delete(it.id);
}
function onApproval(ev, it) {
  if (it.source === "chat") return; // questions from the dashboard chat stay in the dashboard
  if (ev === "created") pushItem(it).catch(() => {});
  else refreshItem(it).catch(() => {});
}

async function onCallback(q) {
  const ack = (text) => api("answerCallbackQuery", { callback_query_id: q.id, text: text ? String(text).slice(0, 190) : undefined }).catch(() => {});
  if (!isOwner(q.from?.id)) return ack("This bot is private.");
  const [kind, id, idx] = String(q.data || "").split(":");
  try {
    if (kind === "a") {
      const it = approvals.get(id);
      if (!it) return ack("That approval is gone.");
      if (it.status !== "pending") { refreshItem(it).catch(() => {}); return ack(`Already ${it.status}.`); }
      const label = it.options[Number(idx)];
      if (label === undefined) return ack("Unknown button.");
      ack(it.kind === "trade" && Number(idx) === 0 ? "Running a dry run…" : label);
      if (!sentFor.has(id) && q.message) sentFor.set(id, [{ chat_id: q.message.chat.id, message_id: q.message.message_id }]);
      await approvals.answer(id, { answers: [label], by: "telegram" });
      return;
    }
    if (kind === "c") { ack("Sending…"); await approvals.confirmTrade(id, { by: "telegram" }); return; }
    if (kind === "x") { approvals.cancel(id); return ack("Canceled."); }
    return ack();
  } catch (e) { return ack(e.message); }
}

// ── messages ───────────────────────────────────────────────────────────────
function strangers() { return tasks.readState().telegram?.strangers || []; }
async function stranger(m) {
  const id = String(m.from.id);
  if (strangers().includes(id)) return;
  tasks.writeState((s) => { s.telegram = { ...(s.telegram || {}) }; s.telegram.strangers = [id, ...(s.telegram.strangers || [])].slice(0, 500); });
  await sendTo(m.chat.id, "This bot is private.").catch(() => {});
}

async function tryPair(m, code) {
  const p = pairing;
  if (!p || p.expiresAt < Date.now()) { pairing = null; return isOwner(m.from.id) ? sendTo(m.chat.id, "You're already paired.") : stranger(m); }
  if (code !== p.code) {
    p.tries++;
    if (p.tries >= 5) { pairing = null; emit("telegram", info()); }
    return sendTo(m.chat.id, "That code doesn't match. Make a new one in Claudia Local → Settings → Channels.");
  }
  pairing = null;
  const name = [m.from.first_name, m.from.last_name].filter(Boolean).join(" ") + (m.from.username ? ` (@${m.from.username})` : "");
  saveSettings((t) => { t.owners = [...(t.owners || []).filter((o) => String(o.id) !== String(m.from.id)), { id: String(m.from.id), name: clip(name, 80) || String(m.from.id), pairedAt: Date.now() }].slice(0, 10); });
  tasks.writeState((s) => { if (s.telegram?.strangers) s.telegram.strangers = s.telegram.strangers.filter((x) => x !== String(m.from.id)); });
  trackActivity("telegram", `Telegram paired: ${clip(name, 80)}`);
  return sendTo(m.chat.id, "Paired. Write to me here like in the Claudia Local chat. Task results, check-ins and approvals arrive here too. /help lists the commands.");
}

function statusText() {
  const a = tasks.publicAutonomy();
  const all = tasks.listTasks();
  const on = all.filter((t) => t.enabled).length;
  return [
    a.stopped ? "Everything on its own is PAUSED." : "Tasks and heartbeat are running.",
    `Tasks: ${on} on, ${all.length - on} paused.`,
    `Waiting for you: ${approvals.pending().length}.`,
    `Today: ${a.used.runs}/${a.budgets.runsPerDay || "∞"} runs, ${a.used.toolCalls}/${a.budgets.toolCallsPerDay || "∞"} tool calls, ${a.used.posts}/${a.budgets.postsPerDay} posts on its own, ${a.used.tokens.toLocaleString("en-US")} tokens.`,
    `Heartbeat: ${a.heartbeat.enabled ? `every ${a.heartbeat.everyMinutes} min` : "off"}.`,
  ].join("\n");
}

async function command(m, cmd, arg) {
  const chat = m.chat.id;
  switch (cmd) {
    case "start": case "help":
      return sendTo(chat, "Write to me like in the Claudia Local chat.\n/status  tasks, approvals and today's budget\n/pending  what's waiting for you\n/new  start a fresh chat\n/stop  pause every task and the heartbeat\n/resume  resume them");
    case "status": return sendTo(chat, statusText());
    case "pending": {
      const p = approvals.pending();
      if (!p.length) return sendTo(chat, "Nothing is waiting for you.");
      for (const it of p.slice(0, 10)) { const x = await sendTo(chat, itemText(it) + statusLine(it), { reply_markup: itemButtons(it) }); sentFor.set(it.id, [...(sentFor.get(it.id) || []).filter((y) => y.chat_id !== chat), { chat_id: chat, message_id: x.message_id }]); }
      return null;
    }
    case "new": deleteChat(CHAT_ID); return sendTo(chat, "Fresh chat started.");
    case "stop": tasks.stopAll("Telegram /stop"); return sendTo(chat, "Paused every task, watcher and the heartbeat. /resume to start them again.");
    case "resume": tasks.resumeAll(); return sendTo(chat, tasks.isStopped() ? "The STOP file is still there; remove it on the computer." : "Resumed.");
    case "pair": return sendTo(chat, "You're already paired.");
    default: return sendTo(chat, `Unknown command /${cmd}. /help lists them.`);
  }
}

/** Voice notes: your own OpenAI or Groq key does the transcription. */
async function transcribe(fileId) {
  const openai = providerValue("openai", "key"), groq = providerValue("groq", "key");
  if (!openai && !groq) return { error: "Voice notes need an OpenAI or Groq key. Add one under Settings → Keys and providers, or type instead." };
  const f = await api("getFile", { file_id: fileId });
  if (!f.file_path || (f.file_size || 0) > 10 * 1024 * 1024) return { error: "That voice note is too long (10 MB at most)." };
  const r = await fetch(`${base()}/file/bot${token()}/${f.file_path}`, { signal: AbortSignal.timeout(30_000), redirect: "error" });
  if (!r.ok) return { error: "Couldn't download the voice note from Telegram." };
  const audio = new Uint8Array(await r.arrayBuffer());
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/ogg" }), "voice.ogg");
  form.append("model", openai ? "gpt-4o-transcribe" : "whisper-large-v3-turbo");
  const url = openai ? "https://api.openai.com/v1/audio/transcriptions" : "https://api.groq.com/openai/v1/audio/transcriptions";
  const t = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${openai || groq}` }, body: form, signal: AbortSignal.timeout(60_000), redirect: "error" });
  const j = await t.json().catch(() => ({}));
  if (!t.ok) return { error: `${openai ? "OpenAI" : "Groq"} couldn't transcribe it (${t.status}).` };
  return { text: String(j.text || "").trim() };
}

/** Owner's message → the prompt. Forwarded and quoted parts are outside content. */
function promptFrom(m, text) {
  const fwd = m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_sender_name || m.forward_date;
  if (fwd) {
    const who = m.forward_origin?.sender_user?.username || m.forward_origin?.chat?.title || m.forward_from?.username || m.forward_from_chat?.title || m.forward_sender_name || m.forward_origin?.sender_user_name || "someone";
    return { prompt: `I forwarded you this message:\n${untrusted.wrap("channel", text, { from: `forwarded from ${who}` })}`, origin: "channel" };
  }
  const quoted = m.quote?.text || m.reply_to_message?.text || m.reply_to_message?.caption || "";
  if (quoted) return { prompt: `${text}\n\nThe message I'm replying to:\n${untrusted.wrap("channel", quoted, { from: "quoted message" })}`, origin: "user" };
  return { prompt: text, origin: "user" };
}

async function chatTurn(job) {
  const { m, prompt, origin } = job;
  const ac = new AbortController();
  turn = { ac };
  const typing = setInterval(() => api("sendChatAction", { chat_id: m.chat.id, action: "typing" }).catch(() => {}), 5000);
  api("sendChatAction", { chat_id: m.chat.id, action: "typing" }).catch(() => {});
  try {
    // A new Telegram chat starts with "Telegram:" so it's easy to spot in the dashboard's chat list.
    const first = !getChat(CHAT_ID)?.messages?.length;
    const res = await runner.run({ prompt: first ? `Telegram: ${prompt}` : prompt, label: "a Telegram chat", tools: null, role: "chat", budget: { maxRounds: 8, maxToolCalls: 16 }, origin, source: "telegram", chatId: CHAT_ID, signal: ac.signal });
    const extra = res.approvals.length ? `\n\n${res.approvals.length} item(s) wait for your approval: /pending` : "";
    await sendTo(m.chat.id, (res.status === "error" ? `Something went wrong: ${res.summary}` : res.summary) + extra);
  } catch (e) {
    await sendTo(m.chat.id, `Something went wrong: ${e.message}`).catch(() => {});
  } finally {
    clearInterval(typing);
    turn = null;
    const next = queue.shift();
    if (next) chatTurn(next).catch(() => {});
  }
}

async function onMessage(m) {
  if (!m?.from || m.from.is_bot || m.chat?.type !== "private") return;
  const text = String(m.text || m.caption || "").trim();
  const pair = /^\/pair(?:@\w+)?\s+(\d{6})\s*$/i.exec(text);
  if (pair) return tryPair(m, pair[1]);
  if (!isOwner(m.from.id)) return stranger(m);
  const cmd = /^\/([a-z]+)(?:@\w+)?(?:\s+(.*))?$/i.exec(text);
  if (cmd) return command(m, cmd[1].toLowerCase(), cmd[2] || "");
  let said = text;
  if (m.voice || m.audio) {
    const t = await transcribe((m.voice || m.audio).file_id).catch((e) => ({ error: `Couldn't transcribe it: ${e.message}` }));
    if (t.error) return sendTo(m.chat.id, t.error);
    if (!t.text) return sendTo(m.chat.id, "I couldn't hear any words in that.");
    await sendTo(m.chat.id, `Heard: ${clip(t.text, 500)}`).catch(() => {});
    said = t.text;
  }
  if (!said) return sendTo(m.chat.id, "I can read text and voice notes.");
  const job = { m, ...promptFrom(m, said.slice(0, 8000)) };
  if (turn) {
    if (queue.length >= 3) return sendTo(m.chat.id, "Still working on your earlier messages. Try again in a moment.");
    queue.push(job);
    return null;
  }
  chatTurn(job).catch(() => {});
  return null;
}

// ── polling ────────────────────────────────────────────────────────────────
const shouldPoll = () => vault.isUnlocked() && !!settings().enabled && !!token();
const sleep = (ms, signal) => new Promise((r) => { const t = setTimeout(r, ms); signal?.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); });

async function poll(ac) {
  let wait = 1000;
  status = { ...status, polling: true, error: null };
  emit("telegram", info());
  log("[telegram] polling");
  while (!ac.signal.aborted && shouldPoll()) {
    try {
      const offset = tasks.readState().telegram?.offset || 0;
      const updates = await api("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query"] }, { signal: ac.signal, timeoutMs: 40_000 });
      for (const u of updates) {
        tasks.writeState((s) => { s.telegram = { ...(s.telegram || {}), offset: u.update_id + 1 }; });
        if (u.callback_query) onCallback(u.callback_query).catch((e) => log(`[telegram] button: ${e.message}`));
        else if (u.message) onMessage(u.message).catch((e) => log(`[telegram] message: ${e.message}`));
      }
      wait = 1000;
      if (status.error) { status.error = null; emit("telegram", info()); }
      status.lastOk = Date.now();
    } catch (e) {
      if (ac.signal.aborted) break;
      const msg = e.code === "409" ? "Another program is reading this bot's updates (a webhook or a second copy). Use a bot only Claudia Local reads." : e.status === 401 ? "Telegram doesn't accept this bot token." : e.message;
      if (status.error !== msg) { status.error = msg; log(`[telegram] ${msg}`); emit("telegram", info()); }
      await sleep(e.status === 401 ? 60_000 : wait, ac.signal);
      wait = Math.min(wait * 2, 60_000);
    }
  }
  status = { ...status, polling: false };
  emit("telegram", info());
}

/** Starts or stops polling to match: unlocked + switched on + token set. */
export function supervise() {
  if (shouldPoll() && !loop) {
    const ac = new AbortController();
    loop = { ac };
    poll(ac).catch((e) => log(`[telegram] ${e.message}`)).finally(() => { if (loop?.ac === ac) loop = null; });
  } else if (!shouldPoll() && loop) stop();
}
export function stop() {
  loop?.ac.abort();
  loop = null;
  turn?.ac.abort();
  queue.length = 0;
  status = { ...status, polling: false };
}

export function init(o = {}) {
  log = o.log || log;
  emit = (topic, data) => { try { o.broadcast?.({ type: "auto", topic, data }); } catch { /* */ } };
  approvals.on(onApproval);
  setInterval(supervise, 3000).unref();
}
