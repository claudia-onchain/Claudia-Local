/**
 * approvals.js — one queue for everything that waits for your yes or your answer.
 *
 *   question      the agent asks you something (ask_user, and "post this?" in chat)
 *   thread_post   a task wants to post in a Claudia thread room
 *   social_post   a task drafted a social post (it also waits in Socials → Approvals)
 *   trade         a task suggests a real buy or sell: approving opens a dry run with the numbers,
 *                 and only a second, separate confirm sends it (never automatic)
 *
 * Items persist in approvals.json and expire (24 h at most; chat questions after 5 minutes, as before).
 * They can be answered from the chat, the Approvals page or Telegram; whoever answers first wins.
 * What an approved item does lives here, in server code: the model can't change it.
 */
import { join } from "node:path";
import { HOME } from "./paths.js";
import { readJsonFile, writeJsonFile, newId, trackActivity } from "./store.js";
import * as cl from "./claudia.js";
import * as S from "./studio-social.js";
import * as studio from "./studio.js";

const FILE = join(HOME, "approvals.json");
export const MAX_TTL_MS = 24 * 3600_000;
export const KINDS = ["question", "thread_post", "social_post", "trade"];
const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const clip = (s, n = 200) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

const waiters = new Map();   // id -> { resolve, timer, send }
const listeners = new Set(); // (event, item) => void
let onPosted = () => {};     // counts autonomous posts for the daily budget (tasks.js)

export const list = () => readJsonFile(FILE, []);
export const get = (id) => list().find((x) => x.id === id) || null;
export const pending = () => list().filter((x) => x.status === "pending" || x.status === "confirm");
const save = (all) => writeJsonFile(FILE, all.slice(0, 500));

/** Listen to "created" | "updated" events (dashboard broadcast, Telegram). Returns an unsubscribe function. */
export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emit(ev, item) { for (const f of listeners) { try { f(ev, item); } catch { /* */ } } }
export function setPostCounter(fn) { onPosted = fn || onPosted; }

function patch(id, fields) {
  const all = list();
  const it = all.find((x) => x.id === id);
  if (!it) return null;
  Object.assign(it, fields, { updatedAt: Date.now() });
  save(all);
  emit("updated", it);
  return it;
}

/**
 * Add an item. `options` are button labels; for actionable kinds the first one approves.
 * source: "chat" | "task" | "heartbeat" | "watcher" | "telegram". origin: untrusted.js source that led to it.
 */
export function create({ kind = "question", question, options, detail = {}, source = "chat", origin = "user", sessionId, taskId, runId, ttlMs = MAX_TTL_MS, ephemeral = false, allowCustom }) {
  if (!KINDS.includes(kind)) throw err(400, "Unknown approval kind.");
  const opts = (Array.isArray(options) && options.length ? options : kind === "question" ? [] : kind === "trade" ? ["Review the trade", "Deny"] : ["Approve", "Deny"]).slice(0, 8).map((l) => String(l).slice(0, 200));
  const now = Date.now();
  const item = {
    id: newId("ap_"), kind, status: "pending", question: String(question || "").slice(0, 1000), options: opts,
    allowCustom: allowCustom ?? kind === "question", detail: JSON.parse(JSON.stringify(detail || {}).slice(0, 20_000)),
    source, origin, sessionId: sessionId || null, taskId: taskId || null, runId: runId || null, ephemeral: !!ephemeral,
    createdAt: now, updatedAt: now, expiresAt: now + Math.max(30_000, Math.min(MAX_TTL_MS, Number(ttlMs) || MAX_TTL_MS)),
  };
  save([item, ...list()]);
  emit("created", item);
  return item;
}

/**
 * Ask and wait (the chat's ask_user and "post this?"). Sends the same approval_request / approval_closed
 * messages the chat always used; resolves { answers, custom, by } or { timedOut: true }.
 */
export function ask(fields, { timeoutMs = 5 * 60_000, send } = {}) {
  const item = create({ ...fields, ttlMs: timeoutMs, ephemeral: true, allowCustom: true });
  send?.({ type: "approval_request", id: item.id, question: item.question, options: item.options.map((label) => ({ label })), allowCustom: true, ...(fields.extra || {}) });
  return new Promise((resolve) => {
    const timer = setTimeout(() => expire(item.id), Math.max(1000, item.expiresAt - Date.now()));
    waiters.set(item.id, { resolve, timer, send });
  });
}

function expire(id, status = "expired") {
  const w = waiters.get(id);
  if (w) { clearTimeout(w.timer); waiters.delete(id); w.resolve({ timedOut: true }); w.send?.({ type: "approval_closed", id }); }
  const it = get(id);
  if (it && (it.status === "pending" || it.status === "confirm")) patch(id, { status });
}

const answerText = (a) => (a.custom ? String(a.custom) : (a.answers || []).join(", ")) || "(no answer)";
const approves = (it, a) => !a.custom && (a.answers || [])[0] === it.options[0];

/** Answer an item. by: "chat" | "dashboard" | "telegram". Runs its action when it was approved. */
export async function answer(id, { answers = [], custom, by = "dashboard" } = {}) {
  const it = get(id);
  if (!it) throw err(404, "That approval is gone.");
  if (it.status !== "pending") throw err(409, it.status === "confirm" ? "This trade is waiting for its confirm step." : `Already ${it.status}.`);
  if (Date.now() > it.expiresAt) { expire(id); throw err(410, "That approval expired."); }
  const a = { answers: (Array.isArray(answers) ? answers : [answers]).map((x) => String(x).slice(0, 200)).slice(0, 8), custom: custom ? String(custom).slice(0, 2000) : undefined, by };
  patch(id, { status: "answered", answer: { ...a, at: Date.now() } });
  const w = waiters.get(id);
  if (w) {
    clearTimeout(w.timer); waiters.delete(id); w.resolve(a);
    if (by !== "chat") w.send?.({ type: "approval_answered", id, text: answerText(a), by });
  }
  if (it.kind === "question") return get(id);
  const ok = approves(it, a);
  trackActivity("approvals", `${ok ? "Approved" : "Denied"} (${by}): ${clip(it.question, 120)}`);
  if (!ok) return patch(id, { status: "denied" });
  try {
    if (it.kind === "thread_post") return await runThreadPost(it);
    if (it.kind === "social_post") return await runSocialPost(it);
    if (it.kind === "trade") return await previewTrade(it);
  } catch (e) {
    return patch(id, { status: "failed", result: clip(e.hint ? `${e.message} ${e.hint}` : e.message, 500) });
  }
  return get(id);
}

async function runThreadPost(it) {
  const { room, content } = it.detail;
  const r = await cl.post(room, content);
  onPosted(it);
  return patch(it.id, { status: "done", result: r.held ? `Claudia is holding it for review (${r.reason}).` : `Posted in #${room}.` });
}

async function runSocialPost(it) {
  const s = await S.social();
  const post = studio.findPost(s, it.detail.postId);
  if (!post) return patch(it.id, { status: "failed", result: "The draft is gone." });
  if (post.status !== "pending_approval" && post.status !== "draft") return patch(it.id, { status: "done", result: `Already handled in Socials (${post.status}).` });
  const out = await studio.approvePost(post.id, { publishNow: true });
  onPosted(it);
  return patch(it.id, { status: "done", result: out.status === "scheduled" ? `Approved; it goes out ${new Date(post.input.scheduleAt).toISOString()}.` : `Approved: ${out.status}.` });
}

/** Approving a trade only makes a dry run. The numbers go back to you; confirmTrade sends it. */
async function previewTrade(it) {
  const d = it.detail;
  const pv = await cl.previewTrade({ token: d.token, side: d.side, amount: d.amount, source: it.source || "task", ...(d.chain ? { chain: d.chain } : {}) });
  return patch(it.id, { status: "confirm", preview: pv, expiresAt: Math.min(it.expiresAt, pv.expiresAt || Date.now() + 5 * 60_000) });
}

/** One plain paragraph with a trade preview's numbers (dashboard and Telegram show the same thing). */
export function previewText(pv) {
  if (!pv) return "";
  const q = pv.quote || {};
  const u = pv.unit || "SOL", c = pv.caps || {}, sim = pv.simulation || {};
  const recv = pv.expectedReceive ? `${pv.expectedReceive.amount} ${pv.expectedReceive.unit} (at least ${pv.expectedReceive.min})` : `${q.expectedOut ?? "?"} (at least ${q.minOut ?? "?"})`;
  return [
    `${pv.side === "buy" ? "Buy" : "Sell"} ${pv.side === "buy" ? `${pv.amount} ${u} of` : `${pv.amount}% of`} $${pv.symbol} on ${pv.chainName || "Solana"}${pv.chain === "hood" ? " (beta)" : ""}`,
    `You get about ${recv} · price impact ${q.priceImpactPct ?? "?"}% · fees ${q.feeNative ?? "?"} ${u}`,
    `Simulation: ${sim.ok === true ? "passed" : sim.ok === false ? `would fail (${sim.error || "no reason"})` : `couldn't run${sim.error ? ` (${sim.error})` : ""}`} · wallet ${pv.balanceNative ?? "?"} ${u}`,
    `Caps left today: ${pv.side === "buy" ? c.leftToday : c.sellLeftToday} of ${c.perDay} ${u}${pv.side === "sell" ? " in sales" : ""} · ${c.perTrade} ${u} per trade`,
    pv.liveTrading ? "" : "Live trading is off, so this can't be sent until you switch it on.",
    ...(pv.warnings || []),
  ].filter(Boolean).join("\n");
}

/** The second step for a trade: send exactly the previewed transaction. */
export async function confirmTrade(id, { by = "dashboard" } = {}) {
  const it = get(id);
  if (!it || it.kind !== "trade") throw err(404, "That trade approval is gone.");
  if (it.status !== "confirm" || !it.preview?.id) throw err(409, "Review the trade first.");
  try {
    const r = await cl.confirmTrade({ previewId: it.preview.id, confirm: true });
    trackActivity("approvals", `Trade confirmed (${by}): ${clip(it.question, 120)}`);
    return patch(id, { status: "done", result: `Sent. ${(r.explorer || []).join(" ")}`.trim() });
  } catch (e) {
    return patch(id, { status: "failed", result: clip(e.message, 500) });
  }
}

export function cancel(id) {
  const it = get(id);
  if (!it) throw err(404, "That approval is gone.");
  if (it.status === "pending" || it.status === "confirm") expire(id, "canceled");
  return get(id);
}

/** Expire overdue items. Runs every minute. */
export function sweep() {
  const now = Date.now();
  for (const it of list()) if ((it.status === "pending" || it.status === "confirm") && it.expiresAt < now) expire(it.id);
}

/** On lock and on start: chat questions can't outlive their chat. */
export function cancelEphemeral() {
  for (const [id] of waiters) expire(id);
  for (const it of list()) if (it.ephemeral && it.status === "pending") expire(it.id);
}

export function init() {
  cancelEphemeral();
  setInterval(sweep, 60_000).unref();
}
