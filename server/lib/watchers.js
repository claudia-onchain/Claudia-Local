/**
 * watchers.js — simple conditions that start a task.
 *
 *   price    a coin's price moved by N % since the watcher last fired (or was set up)
 *   volume   a coin's 1-hour volume changed by N %
 *   thread   someone new posted in a Claudia thread room (your own agent's posts don't count)
 *   inbox    a new mention, reply or DM in the social inbox (@useclaudia/social)
 *
 * Each watcher keeps its own state in tasks.json and is rate-limited: it checks at most every
 * `everyMinutes` (5 at least for price and volume, 2 for the rest), fires at most once per
 * `cooldownMinutes`, and at most 24 times a day. What a thread post or inbox item says is outside
 * content: it reaches the task wrapped (untrusted.wrap), and that run can't post or trade without you.
 */
import { getConfig, newId, trackActivity } from "./store.js";
import * as cl from "./claudia.js";
import * as S from "./studio-social.js";
import * as untrusted from "./untrusted.js";
import * as tasks from "./tasks.js";

export const TYPES = ["price", "volume", "thread", "inbox"];
const MIN_EVERY = { price: 5, volume: 5, thread: 2, inbox: 2 };
const MAX_FIRES_PER_DAY = 24;
const err = (status, message) => Object.assign(new Error(message), { status });
const clip = (s, n = 300) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

export const list = () => tasks.listWatchers();
const today = () => new Date().toDateString();

function norm(x = {}, prev = null) {
  const w = prev ? structuredClone(prev) : { id: newId("w_"), createdAt: Date.now(), state: {}, lastCheck: 0, lastFired: 0, fires: { day: "", n: 0 }, lastError: null };
  if (!prev || "type" in x) { if (!TYPES.includes(x.type)) throw err(400, `Pick a watcher type: ${TYPES.join(", ")}.`); if (prev && prev.type !== x.type) w.state = {}; w.type = x.type; }
  if (!prev || "name" in x) w.name = String(x.name || "").trim().slice(0, 80) || { price: "Price move", volume: "Volume change", thread: "New in the thread", inbox: "New in the inbox" }[w.type];
  if (w.type === "price" || w.type === "volume") {
    if (!prev || "token" in x) { const t = String(x.token || "").trim().slice(0, 100); if (!t) throw err(400, "Which coin? A mint or $CLAUDIA."); if (prev && prev.token !== t) w.state = {}; w.token = t; }
    if (!prev || "thresholdPct" in x) { const n = Number(x.thresholdPct ?? 10); if (!(n >= 1 && n <= 1000)) throw err(400, "The change must be between 1 and 1000 %."); w.thresholdPct = n; }
  }
  if (w.type === "thread" && (!prev || "room" in x)) { const r = String(x.room || "general").trim(); if (!/^[a-z0-9-]{1,64}$/.test(r)) throw err(400, "That room name doesn't look right."); w.room = r; }
  if (!prev || "everyMinutes" in x) w.everyMinutes = Math.max(MIN_EVERY[w.type], Math.min(1440, Math.round(Number(x.everyMinutes) || MIN_EVERY[w.type] * 2)));
  if (!prev || "cooldownMinutes" in x) w.cooldownMinutes = Math.max(5, Math.min(1440, Math.round(Number(x.cooldownMinutes) || 60)));
  if (!prev || "taskId" in x) { const id = String(x.taskId || ""); if (id && !tasks.getTask(id)) throw err(400, "That task is gone."); w.taskId = id || null; }
  if ("enabled" in x) w.enabled = !!x.enabled;
  else if (!prev) w.enabled = true;
  if (w.enabled && !w.taskId) throw err(400, "Pick the task this watcher starts.");
  w.updatedAt = Date.now();
  return w;
}

export function create(x) {
  const w = norm(x);
  tasks.updateData((d) => { if (d.watchers.length >= 50) throw err(409, "That's 50 watchers already."); d.watchers.push(w); });
  trackActivity("tasks", `Watcher added: ${w.name}`);
  return w;
}
export function update(id, x) {
  return tasks.updateData((d) => {
    const i = d.watchers.findIndex((w) => w.id === id);
    if (i < 0) throw err(404, "That watcher is gone.");
    d.watchers[i] = norm(x, d.watchers[i]);
    return d.watchers[i];
  });
}
export function remove(id) { tasks.updateData((d) => { d.watchers = d.watchers.filter((w) => w.id !== id); }); return { ok: true }; }
const setFields = (id, f) => tasks.updateData((d) => { const w = d.watchers.find((y) => y.id === id); if (w) Object.assign(w, f); return w; });

/** One check: returns { fire: false } or { fire: true, context, origin } and the new state. */
async function check(w) {
  const st = { ...(w.state || {}) };
  if (w.type === "price" || w.type === "volume") {
    const c = await cl.coin(w.token);
    const v = Number(w.type === "price" ? c.priceUsd : c.volume1hUsd);
    if (!Number.isFinite(v)) return { fire: false, state: st };
    if (!(st.baseline > 0)) return { fire: false, state: { ...st, baseline: v, symbol: c.symbol, at: Date.now() } };
    const pct = ((v - st.baseline) / st.baseline) * 100;
    if (Math.abs(pct) < w.thresholdPct) return { fire: false, state: { ...st, last: v } };
    const what = w.type === "price" ? "price" : "1-hour volume";
    return { fire: true, origin: "user", state: { baseline: v, symbol: c.symbol, at: Date.now(), last: v },
      context: `$${c.symbol}'s ${what} moved ${pct > 0 ? "+" : ""}${pct.toFixed(1)}% (from ${st.baseline} to ${v} USD) since ${new Date(st.at || w.createdAt).toISOString()}. Watcher: ${w.name}.` };
  }
  if (w.type === "thread") {
    const me = getConfig().claudia.agent?.slug;
    const msgs = await cl.thread(w.room, { limit: 20 });
    const newest = msgs.reduce((m, x) => Math.max(m, Date.parse(x.createdAt) || 0), 0);
    if (!st.since) return { fire: false, state: { since: newest || Date.now() } };
    const fresh = msgs.filter((x) => (Date.parse(x.createdAt) || 0) > st.since && x.agent?.slug !== me).slice(0, 10);
    const next = { since: Math.max(st.since, newest) };
    if (!fresh.length) return { fire: false, state: next };
    const body = fresh.map((x) => `${x.agent?.name || "someone"} (${x.createdAt}): ${clip(x.content, 500)}`).join("\n");
    return { fire: true, origin: "thread", state: next, context: `${fresh.length} new post(s) in the Claudia thread #${w.room}:\n${untrusted.wrap("thread", body, { from: `#${w.room}` })}` };
  }
  if (w.type === "inbox") {
    const status = await S.status().catch(() => null);
    if (!status?.installed) return { fire: false, state: st, error: "The social package isn't installed." };
    const s = await S.social();
    if (!s.accounts().length) return { fire: false, state: st };
    if (!st.since) return { fire: false, state: { since: Date.now() } };
    const items = (await s.inbox({ since: st.since })).filter((i) => (i.at || 0) > st.since).slice(0, 10);
    const next = { since: Math.max(st.since, ...items.map((i) => i.at || 0)) };
    if (!items.length) return { fire: false, state: next };
    const body = items.map((i) => `[${i.network} ${i.kind}] ${i.id} from ${i.from}: ${clip(i.text, 500)}`).join("\n");
    return { fire: true, origin: "channel", state: next, context: `${items.length} new item(s) in the social inbox:\n${untrusted.wrap("channel", body, { from: "social inbox" })}` };
  }
  return { fire: false, state: st };
}

let busy = false;
/** Called with the scheduler tick. One watcher at a time, so the Claudia API isn't hammered. */
export async function tick() {
  if (busy || tasks.isStopped()) return;
  busy = true;
  try {
    const now = Date.now();
    for (const w of list()) {
      if (!w.enabled || !w.taskId) continue;
      if (now - (w.lastCheck || 0) < w.everyMinutes * 60_000) continue;
      let r;
      try { r = await check(w); } catch (e) { setFields(w.id, { lastCheck: now, lastError: clip(e.message, 200) }); continue; }
      const fields = { lastCheck: now, state: r.state, lastError: r.error || null };
      const fires = w.fires?.day === today() ? w.fires : { day: today(), n: 0 };
      const cooled = now - (w.lastFired || 0) >= w.cooldownMinutes * 60_000;
      if (r.fire && cooled && fires.n < MAX_FIRES_PER_DAY && !tasks.isRunning(w.taskId)) {
        try {
          tasks.startRun(w.taskId, { trigger: "watcher", context: r.context, origin: r.origin });
          Object.assign(fields, { lastFired: now, fires: { day: fires.day, n: fires.n + 1 } });
          trackActivity("tasks", `Watcher fired: ${w.name}`);
        } catch (e) { fields.lastError = clip(e.message, 200); }
      } else if (r.fire) {
        fields.state = w.state; // keep the old baseline so the move isn't lost while cooling down
      }
      setFields(w.id, fields);
    }
  } finally { busy = false; }
}
