/**
 * runner.js — one agent turn without a browser: scheduled tasks, the heartbeat, watchers and Telegram.
 *
 * Builds on what createAgent (agent.js) returns as `headless`: the same model client, system prompt,
 * tools and tool runner as the chat. On top of that it adds:
 *   - its own session (nothing is mixed into your chats unless `chatId` is given, as Telegram does),
 *   - an allowed tool list and a budget (model rounds and tool calls per run),
 *   - a run log of everything that happened,
 *   - the rules for acting alone, kept here in server code:
 *       claudia_post  → waits in Approvals, unless the task may post without asking AND the run was
 *                       not started by outside content (untrusted.mayAct)
 *       draft_post    → the draft also waits in Approvals (or is approved by the same rule as above)
 *       propose_trade → a trade item in Approvals: you review the dry run and confirm. Always.
 *       ask_user      → a question in Approvals (dashboard and Telegram), with a short wait
 */
import { getConfig, saveChat, getChat, trackUsage } from "./store.js";
import * as approvals from "./approvals.js";
import * as untrusted from "./untrusted.js";
import * as cl from "./claudia.js";
import * as studio from "./studio.js";
import { runStudioTool } from "./studio-tools.js";

let H = null; // agent.headless
export function init(agent) { H = agent.headless; }
export const ready = () => !!H;

const clip = (s, n = 400) => { const x = String(s ?? "").replace(/\s+/g, " ").trim(); return x.length > n ? x.slice(0, n) + "…" : x; };

export const DEFAULT_BUDGET = { maxRounds: 6, maxToolCalls: 12 };
export const BUDGET_BOUNDS = { maxRounds: [1, 20], maxToolCalls: [0, 60] };
export function normBudget(b = {}) {
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(BUDGET_BOUNDS)) {
    const n = Math.round(Number(b?.[k]));
    out[k] = Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : DEFAULT_BUDGET[k];
  }
  return out;
}

function windowed(messages) {
  let start = Math.max(0, messages.length - 40);
  while (start > 0 && messages[start]?.role !== "user") start--;
  return messages.slice(start);
}

/**
 * Run one turn.
 *   prompt       what to do (the person's own words for tasks; already wrapped when it holds outside content)
 *   label        "Task: Morning read", shown in the system prompt and logs
 *   tools        allowed tool names (null = every tool that's switched on)
 *   role/model   model role ("tasks") and an optional model id for this run
 *   budget       { maxRounds, maxToolCalls }
 *   origin       untrusted.js source that started this run ("user" for your own task prompt)
 *   source       "task" | "heartbeat" | "watcher" | "telegram" (for Approvals)
 *   allowPost    the task may post without asking (only honoured when mayAct(origin))
 *   chatId       keep the conversation in this saved chat (Telegram); otherwise a fresh session
 *   gate         { beforeRound() → string|null, beforeTool(name) → string|null, onUsage(prompt, completion),
 *                  canPost() → boolean, onPost() }  (daily budgets and the kill switch, tasks.js)
 *   signal       AbortSignal (kill switch, lock)
 *   onEvent      (event) => void, live progress
 * Returns { status: "ok"|"error"|"stopped"|"budget", summary, events, toolCalls, usage, approvals }.
 */
export async function run(o) {
  if (!H) throw new Error("The runner isn't ready yet.");
  const events = [];
  const approvalIds = [];
  const log = (e) => { const x = { t: Date.now(), ...e }; if (events.length < 300) events.push(x); try { o.onEvent?.(x); } catch { /* */ } };
  const budget = normBudget(o.budget);
  const usage = { prompt: 0, completion: 0 };
  let toolCalls = 0, status = "ok", final = "";

  const r = H.client({ role: o.role || "tasks", model: o.model || undefined });
  if (r.error) { log({ type: "error", text: r.error }); return { status: "error", summary: r.error, events, toolCalls, usage, approvals: approvalIds }; }

  const allowed = Array.isArray(o.tools) ? o.tools : null;
  const specs = H.activeSpecs(allowed || undefined);
  const mayPostAlone = !!o.allowPost && untrusted.mayAct(o.origin || "user");
  const saved = o.chatId ? getChat(o.chatId)?.messages || [] : [];
  const session = [...saved, { role: "user", content: String(o.prompt || "").slice(0, 60_000) }];
  const send = () => {};
  const ctx = { ws: null, sid: o.chatId || `run:${o.source || "task"}`, send, signal: o.signal, source: o.source || "task", origin: o.origin || "user", askTimeoutMs: 10 * 60_000 };

  const extra = [
    "## Running on your own",
    o.source === "telegram"
      ? "- The user is talking to you on Telegram. Keep replies short and plain text (no markdown tables)."
      : `- This is ${o.label || "a scheduled task"}. Nobody is watching live: do the job, then end with a short summary of what you did and found (a few lines).`,
    `- Budget for this run: ${budget.maxRounds} model rounds and ${budget.maxToolCalls} tool calls. Don't waste them.`,
    "- Posts and trades wait for the user's approval unless stated otherwise below. Say clearly what is waiting.",
    mayPostAlone ? "- This task may post without asking, inside the daily post limit." : "",
    "- You can't buy, sell or launch. propose_trade puts a suggestion in the user's Approvals.",
    `- ${untrusted.SYSTEM_RULE}`,
  ].filter(Boolean).join("\n");

  async function tool(name, args) {
    if (allowed && !allowed.includes(name)) return `The "${name}" tool isn't allowed for this run.`;
    const stop = o.gate?.beforeTool?.(name);
    if (stop) return stop;
    switch (name) {
      case "claudia_post": {
        if (!cl.isConnected()) return "No Claudia agent is connected, so nothing was posted.";
        const cfg = getConfig();
        const room = /^[a-z0-9-]{1,64}$/.test(String(args.room || "")) ? args.room : cfg.claudia.room || "general";
        const content = String(args.content || "").trim().slice(0, 2000);
        if (!content) return "Nothing to post.";
        const hits = studio.bannedIn(content);
        if (hits.length) return `The post uses banned phrases from the brand kit (${hits.join(", ")}). Rewrite it without them.`;
        if (mayPostAlone && o.gate?.canPost?.() !== false) {
          const res = await cl.post(room, content);
          o.gate?.onPost?.();
          return res.held ? `Claudia accepted the post but is holding it for review (${res.reason}).` : `Posted in #${room}.`;
        }
        const it = approvals.create({ kind: "thread_post", question: `Post this in #${room}?`, detail: { room, content }, source: ctx.source, origin: o.origin || "user", taskId: o.taskId, runId: o.runId });
        approvalIds.push(it.id);
        log({ type: "approval", id: it.id, text: it.question });
        return `Waiting for the user's approval (${it.id}). Nothing was posted yet.`;
      }
      case "draft_post": {
        const res = await runStudioTool("draft_post", args, { source: "agent" });
        const post = res.data?.post;
        if (!post?.id) return res.text;
        if (mayPostAlone && o.gate?.canPost?.() !== false) {
          try {
            const out = await studio.approvePost(post.id, { publishNow: true });
            o.gate?.onPost?.();
            return `Draft ${post.id} approved by the task's own rule: ${out.status}.`;
          } catch (e) { return `${res.text}\nIt couldn't go out on its own (${e.message}), so it waits in Approvals.`; }
        }
        const it = approvals.create({ kind: "social_post", question: `Publish this post? ${clip(post.input?.text, 300)}`, detail: { postId: post.id, text: post.input?.text, targets: (post.input?.targets || []).map((t) => t.account) }, source: ctx.source, origin: o.origin || "user", taskId: o.taskId, runId: o.runId });
        approvalIds.push(it.id);
        log({ type: "approval", id: it.id, text: it.question });
        return res.text;
      }
      case "propose_trade": {
        const out = await H.executeTool(name, args, ctx);
        if (out.startsWith("Error:")) return out;
        const side = args.side === "sell" ? "sell" : "buy";
        const amount = Number(args.amount);
        const it = approvals.create({ kind: "trade", question: `${side === "buy" ? "Buy" : "Sell"} ${side === "buy" ? `${amount} ${args.chain === "hood" || /^(hood:|0x)/i.test(String(args.token || "")) ? "ETH" : "SOL"} of` : `${amount}% of`} ${args.token}?`, detail: { token: String(args.token || ""), side, amount, reason: clip(args.reason, 600), ...(args.chain ? { chain: String(args.chain) } : {}) }, source: ctx.source, origin: o.origin || "user", taskId: o.taskId, runId: o.runId });
        approvalIds.push(it.id);
        log({ type: "approval", id: it.id, text: it.question });
        return `${out} It's also in Approvals (${it.id}): the user reviews a dry run and confirms it themselves.`;
      }
      case "ask_user": {
        const q = String(args.question || "").slice(0, 1000);
        log({ type: "approval", text: q });
        const options = (Array.isArray(args.options) ? args.options : []).slice(0, 8).map((x) => String(x).slice(0, 200));
        const ans = await approvals.ask({ kind: "question", question: q, options, source: ctx.source, origin: o.origin || "user", sessionId: ctx.sid, taskId: o.taskId, runId: o.runId }, { timeoutMs: ctx.askTimeoutMs });
        if (ans.timedOut) return "The user didn't answer in time. Carry on without it and say what you assumed.";
        return ans.custom ? String(ans.custom).slice(0, 2000) : (ans.answers || []).join(", ") || "(no answer)";
      }
      default:
        return H.executeTool(name, args, ctx);
    }
  }

  try {
    for (let round = 0; round < budget.maxRounds; round++) {
      if (o.signal?.aborted) { status = "stopped"; break; }
      const halt = o.gate?.beforeRound?.();
      if (halt) { log({ type: "notice", text: halt }); status = "budget"; final = final || halt; break; }
      const sys = H.systemPrompt(String(o.prompt || "").slice(0, 2000)) + "\n\n" + extra;
      const messages = [{ role: "system", content: sys }, ...windowed(session)];
      const offerTools = toolCalls < budget.maxToolCalls && round < budget.maxRounds - 1 ? specs : [];
      let said = "", calls = [], failed = false, raw = null;
      for await (const c of r.client.stream(messages, offerTools, o.signal)) {
        if (c.type === "delta") said += c.text;
        else if (c.type === "tool_call") { calls = c.tool_calls; raw = c.raw || raw; } // raw: provider blocks (Claude's thinking) for this turn
        else if (c.type === "usage") {
          trackUsage(c.model || r.model, c.usage.prompt_tokens, c.usage.completion_tokens);
          usage.prompt += c.usage.prompt_tokens || 0; usage.completion += c.usage.completion_tokens || 0;
          o.gate?.onUsage?.(c.usage.prompt_tokens || 0, c.usage.completion_tokens || 0);
        } else if (c.type === "notice") log({ type: "notice", text: c.text });
        else if (c.type === "error") { const m = H.friendlyModelError(c); log({ type: "error", text: m }); final = m; failed = true; break; }
      }
      if (said) { final = said; log({ type: "text", text: clip(said, 4000) }); }
      if (said || calls.length) session.push({ role: "assistant", content: said || null, ...(calls.length ? { tool_calls: calls } : {}), ...(raw && calls.length ? { raw } : {}) });
      if (failed) { status = "error"; break; }
      if (o.signal?.aborted) { status = "stopped"; break; }
      if (!calls.length) break;
      for (const tc of calls.slice(0, 8)) {
        let args; try { args = JSON.parse(tc.function.arguments || "{}"); } catch { args = {}; }
        const name = tc.function.name;
        let result;
        if (toolCalls >= budget.maxToolCalls) { result = "Tool budget for this run is used up. Write your summary now."; status = "budget"; }
        else {
          toolCalls++;
          log({ type: "tool", name, args: clip(JSON.stringify(args ?? {}), 600) });
          try { result = String(await tool(name, args && typeof args === "object" ? args : {})); } catch (e) { result = `Error: ${e.message}`; }
          log({ type: "result", name, text: clip(result, 1500), error: result.startsWith("Error:") });
        }
        session.push({ role: "tool", tool_call_id: tc.id, name, content: result.slice(0, 30_000) });
      }
      if (round === budget.maxRounds - 1) status = status === "ok" ? "budget" : status;
    }
  } catch (e) {
    if (o.signal?.aborted) status = "stopped";
    else { status = "error"; final = e.message; log({ type: "error", text: e.message }); }
  }
  if (o.signal?.aborted) status = "stopped";
  if (o.chatId) { try { saveChat(o.chatId, session); } catch { /* */ } }
  const summary = status === "stopped" ? "Stopped." : final || (status === "budget" ? "The run hit its budget before writing a summary." : "(no summary)");
  return { status, summary: summary.slice(0, 8000), events, toolCalls, usage, approvals: approvalIds };
}
