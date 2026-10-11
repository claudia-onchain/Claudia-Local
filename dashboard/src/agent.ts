// The agent connection: one WebSocket for the whole app, and the chat timeline per session.
import { useSyncExternalStore } from "react";
import { bus } from "./lib";

export type Item =
  | { kind: "user"; id: string; text: string; images?: string[] }
  | { kind: "assistant"; id: string; text: string; streaming?: boolean }
  | { kind: "tool"; id: string; name: string; args?: any; result?: string; state: "running" | "done" | "error" }
  | { kind: "helper"; id: string; role: string; task: string; status: "working" | "done" | "failed"; steps: string[]; summary?: string }
  | { kind: "approval"; id: string; question: string; options: { label: string }[]; post?: { room: string; content: string }; answered?: string }
  | { kind: "error"; id: string; text: string }
  | { kind: "notice"; id: string; text: string };

export type HelperRun = { id: string; role: string; task: string; status: "working" | "done" | "failed"; steps: string[]; summary?: string; ts: number };

type State = {
  conn: "connecting" | "open" | "closed";
  sessions: Record<string, { items: Item[]; busy: boolean; queued: number }>;
  helpers: HelperRun[];
  pendingApprovals: number;
};

let state: State = { conn: "closed", sessions: {}, helpers: [], pendingApprovals: 0 };
const subs = new Set<() => void>();
const emit = () => { state = { ...state }; subs.forEach(f => f()); };
const uid = () => Math.random().toString(36).slice(2, 10);

function sess(id: string) {
  if (!state.sessions[id]) state.sessions = { ...state.sessions, [id]: { items: [], busy: false, queued: 0 } };
  return state.sessions[id];
}
function setItems(id: string, f: (items: Item[]) => Item[], patch: Partial<State["sessions"][string]> = {}) {
  const s = sess(id);
  state.sessions = { ...state.sessions, [id]: { ...s, ...patch, items: f(s.items) } };
}
const countApprovals = () => {
  let n = 0;
  for (const s of Object.values(state.sessions)) for (const it of s.items) if (it.kind === "approval" && !it.answered) n++;
  state.pendingApprovals = n;
};

let ws: WebSocket | null = null;
let retry = 0;
let wanted = false;

export function connect() {
  wanted = true;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  state.conn = "connecting"; emit();
  const sock = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
  ws = sock;
  sock.onopen = () => { retry = 0; state.conn = "open"; emit(); };
  sock.onmessage = (e) => { try { onMsg(JSON.parse(e.data)); } catch { /* */ } };
  sock.onclose = (e) => {
    if (ws === sock) ws = null;
    state.conn = "closed";
    for (const id of Object.keys(state.sessions)) state.sessions[id] = { ...state.sessions[id], busy: false };
    emit();
    if (e.code === 4401) { bus.dispatchEvent(new Event("locked")); return; }
    if (wanted && retry < 20) setTimeout(connect, Math.min(800 * ++retry, 8000));
  };
}

export function disconnect() {
  wanted = false;
  try { ws?.close(); } catch { /* */ }
  ws = null;
  state = { conn: "closed", sessions: {}, helpers: [], pendingApprovals: 0 };
  emit();
}

function send(m: unknown) {
  if (ws?.readyState === WebSocket.OPEN) { ws.send(JSON.stringify(m)); return true; }
  return false;
}

function onMsg(m: any) {
  const sid: string = m.sessionId || "default";
  switch (m.type) {
    case "thinking": setItems(sid, it => it, { busy: true }); break;
    case "text_delta":
      setItems(sid, items => {
        const last = items[items.length - 1];
        if (last?.kind === "assistant" && last.streaming) return [...items.slice(0, -1), { ...last, text: last.text + m.text }];
        return [...items, { kind: "assistant", id: uid(), text: m.text, streaming: true }];
      }, { busy: true });
      break;
    case "tool_started":
      setItems(sid, items => [...items.map(x => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x)), { kind: "tool", id: m.callId || uid(), name: m.toolName, args: m.args, state: "running" }]);
      break;
    case "tool_result":
      setItems(sid, items => {
        const i = items.findIndex(x => x.kind === "tool" && (x.id === m.callId || (!m.callId && x.name === m.toolName && x.state === "running")));
        const done: Item = { kind: "tool", id: m.callId || uid(), name: m.toolName, args: m.args, result: m.result, state: m.error ? "error" : "done" };
        if (i < 0) return [...items, done];
        const c = [...items]; c[i] = done; return c;
      });
      if (m.toolName === "write_file") bus.dispatchEvent(new Event("files"));
      break;
    case "agent_event": {
      const ev = m.event;
      const upd = (h: { status: any; steps: string[]; summary?: string }) => {
        const steps = [...h.steps];
        if (ev.kind === "tool_result") steps.push(`${ev.toolName}`);
        return {
          ...h, steps,
          status: ev.kind === "completed" ? "done" : ev.kind === "failed" ? "failed" : "working",
          summary: ev.kind === "completed" ? ev.artifact?.summary : ev.kind === "failed" ? ev.label : h.summary,
        };
      };
      setItems(sid, items => {
        const i = items.findIndex(x => x.kind === "helper" && x.id === ev.agentId);
        if (i < 0) {
          if (ev.kind !== "started") return items;
          return [...items, { kind: "helper", id: ev.agentId, role: ev.role, task: ev.label || "", status: "working", steps: [] }];
        }
        const c = [...items]; c[i] = upd(c[i] as any) as Item; return c;
      });
      const hi = state.helpers.findIndex(h => h.id === ev.agentId);
      if (hi < 0 && ev.kind === "started") state.helpers = [{ id: ev.agentId, role: ev.role, task: ev.label || "", status: "working" as const, steps: [], ts: Date.now() }, ...state.helpers].slice(0, 30);
      else if (hi >= 0) { const c = [...state.helpers]; c[hi] = upd(c[hi]) as HelperRun; state.helpers = c; }
      break;
    }
    case "approval_request":
      setItems(sid, items => [...items.map(x => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x)), { kind: "approval", id: m.id, question: m.question, options: m.options || [], post: m.kind === "post" ? { room: m.room, content: m.content } : undefined }]);
      countApprovals();
      break;
    case "approval_answered": // answered on the Approvals page or in Telegram
      setItems(sid, items => items.map(x => (x.kind === "approval" && x.id === m.id && !x.answered ? { ...x, answered: `${m.text}${m.by === "telegram" ? " (in Telegram)" : ""}` } : x)));
      countApprovals();
      break;
    case "approval_closed":
      setItems(sid, items => items.map(x => (x.kind === "approval" && x.id === m.id && !x.answered ? { ...x, answered: "No answer in time" } : x)));
      countApprovals();
      break;
    case "error":
      setItems(sid, items => [...items.map(x => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x)), { kind: "error", id: uid(), text: m.message }]);
      break;
    case "notice":
      setItems(sid, items => [...items, { kind: "notice", id: uid(), text: m.message }]);
      break;
    case "message_queued":
      setItems(sid, it => it, { queued: m.position || 1 });
      break;
    case "turn_done":
      setItems(sid, items => items.map(x => (x.kind === "assistant" && x.streaming ? { ...x, streaming: false } : x.kind === "tool" && x.state === "running" ? { ...x, state: "done" } : x)), { busy: false, queued: Math.max(0, sess(sid).queued - 1) });
      bus.dispatchEvent(new Event("chats"));
      break;
    case "session_loaded":
      setItems(sid, () => fromStored(m.messages || []), { busy: false });
      break;
    case "memory_update": bus.dispatchEvent(new Event("memory")); break;
    case "proposal": bus.dispatchEvent(new Event("proposals")); break;
    case "paper_update": bus.dispatchEvent(new Event("paper")); break;
    case "files_update": bus.dispatchEvent(new Event("files")); break;
    case "helper_result": bus.dispatchEvent(new CustomEvent("helper_result", { detail: m })); break;
    // Creator studio events (job progress, drafts, connections, kill switch): see studio.ts → useStudioEvents.
    // Tasks, approvals, Telegram: see pages/auto/auto.ts → useAutoEvents.
    case "auto": bus.dispatchEvent(new CustomEvent("auto", { detail: { topic: m.topic, data: m.data } })); return;
    case "studio": bus.dispatchEvent(new CustomEvent("studio", { detail: { topic: m.topic, data: m.data } })); return;
  }
  emit();
}

/** Rebuilds the timeline from a saved chat. */
function fromStored(messages: any[]): Item[] {
  const items: Item[] = [];
  const results = new Map<string, string>();
  for (const m of messages) if (m.role === "tool") results.set(m.tool_call_id, String(m.content || ""));
  for (const m of messages) {
    if (m.role === "user") items.push({ kind: "user", id: uid(), text: typeof m.content === "string" ? m.content : "" });
    else if (m.role === "assistant") {
      if (m.content) items.push({ kind: "assistant", id: uid(), text: String(m.content) });
      for (const tc of m.tool_calls || []) {
        let args: any = {}; try { args = JSON.parse(tc.function?.arguments || "{}"); } catch { /* */ }
        const r = results.get(tc.id);
        items.push({ kind: "tool", id: tc.id, name: tc.function?.name, args, result: r?.slice(0, 1500), state: r?.startsWith("Error:") ? "error" : "done" });
      }
    }
  }
  return items;
}

export const agent = {
  subscribe(f: () => void) { subs.add(f); return () => { subs.delete(f); }; },
  get: () => state,
  /** `previews`: data URLs of attached images, shown in this session only (images aren't saved). */
  send(sessionId: string, text: string, opts: { images?: { data: string; mime: string }[]; attachments?: { name: string; text: string }[] } = {}, previews: string[] = []) {
    setItems(sessionId, items => [...items, { kind: "user", id: uid(), text, ...(previews.length ? { images: previews } : {}) }], { busy: true });
    emit();
    if (!send({ type: "user_message", sessionId, content: text, ...opts })) {
      setItems(sessionId, items => [...items, { kind: "error", id: uid(), text: "Not connected to the app. Reconnecting…" }], { busy: false });
      emit();
      connect();
    }
  },
  stop(sessionId: string) { send({ type: "stop", sessionId }); },
  answer(sessionId: string, id: string, answers: string[], custom?: string) {
    setItems(sessionId, items => items.map(x => (x.kind === "approval" && x.id === id ? { ...x, answered: custom || answers.join(", ") } : x)));
    countApprovals();
    emit();
    send({ type: "approval_response", id, answers, custom });
  },
  load(sessionId: string) { send({ type: "load_session", sessionId }); },
  forget(sessionId: string) {
    send({ type: "forget_session", sessionId });
    const { [sessionId]: _, ...rest } = state.sessions;
    state.sessions = rest;
    emit();
  },
  runHelper(role: string, task: string) { return send({ type: "run_helper", sessionId: "helpers", role, task }); },
};

export function useAgent() {
  return useSyncExternalStore(agent.subscribe, agent.get);
}
