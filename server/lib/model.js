/**
 * model.js — streaming chat with the user's own key: Anthropic's Messages API, any OpenAI-compatible
 * server (OpenAI, Gemini, OpenRouter, xAI, Groq, DeepSeek, Qwen, Kimi, Mistral, your own) or a model
 * server on this computer (Ollama, LM Studio). Claudia Local never relays model calls anywhere else.
 *
 * Every client yields the same events, so agent.js doesn't care which provider it talks to:
 *   { type: "delta", text }                          streamed text
 *   { type: "tool_call", tool_calls, raw? }          OpenAI-shaped tool calls (raw: provider blocks to keep)
 *   { type: "usage", model, usage: { prompt_tokens, completion_tokens, cache_read?, cache_write? } }
 *   { type: "notice", text } · { type: "error", status, error } · { type: "done", model, raw? }
 * Messages go in OpenAI shape (system / user / assistant with tool_calls / tool). An assistant message may
 * carry `raw` (the provider's own content blocks, e.g. Claude's thinking blocks); only this provider reads it.
 *
 * Settings (store.js → chat): provider, a model per role (main, helpers, tasks) per provider, a fallback
 * model tried once when the main one fails after retries, and an optional monthly cap per provider. Spend
 * is an estimate from token counts and the small price table below; it is labelled as one everywhere.
 *
 * CLAUDIA_LOCAL_OPENROUTER_BASE / CLAUDIA_LOCAL_ANTHROPIC_BASE point those presets at another endpoint
 * (a local mock for tests, a proxy). Only https:// or a loopback http:// URL is accepted.
 */
import * as vault from "./vault.js";
import { P } from "./paths.js";
import { readJsonFile, writeJsonFile, ROLES } from "./store.js";
import { CHAT_BY_ID, providerValue, visionCapable, listChatModels, openrouterBase, anthropicBase, openrouterPrice, touchKey } from "./providers.js";

export const ANTHROPIC_VERSION = "2023-06-01";
const RETRY_STATUS = [429, 500, 502, 503, 504, 529];
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── which model ────────────────────────────────────────────────────────────
/** The model id for a role ("main", "helpers", "tasks" or a helper name) under a provider. */
export function resolveModel(cfg, { role = "main", provider } = {}) {
  const p = provider || cfg.chat?.provider || "";
  const main = cfg.chat?.models?.[p] || "";
  if (!role || role === "main") return main;
  const roles = cfg.chat?.roleModels?.[p] || {};
  if (role === "tasks") return roles.tasks || main;
  if (role === "helpers") return roles.helpers || main;
  if (ROLES.includes(role)) return cfg.chat?.helperModels?.[p]?.[role] || roles.helpers || main;
  return main;
}

/**
 * Where a chat call goes: { preset, baseUrl, apiKey, model } or { error }.
 * `model` overrides the configured one for this call; `provider` picks another preset (the fallback).
 */
export function chatTarget(cfg, { role = "main", model, provider } = {}) {
  if (!vault.isUnlocked()) return { error: "Claudia Local is locked." };
  const pid = provider || cfg.chat?.provider || "";
  const preset = CHAT_BY_ID.get(pid);
  if (!preset) return { error: "No chat model yet. Add a key in Settings → Keys, or start Ollama or LM Studio on this computer, then pick a model in Settings → Chat model.", code: "no_provider" };
  let apiKey = "";
  if (preset.kind !== "local") {
    apiKey = providerValue(preset.key, "key") || "";
    if (!apiKey && preset.id !== "custom") return { error: `Add your ${preset.name} key in Settings → Keys first.`, code: "no_key" };
  }
  const baseUrl = preset.id === "custom" ? cfg.chat.baseUrl : preset.id === "openrouter" ? openrouterBase() : preset.id === "anthropic" ? anthropicBase() : preset.baseUrl;
  if (!baseUrl) return { error: "Set the chat server address in Settings → Chat model first." };
  const m = model || resolveModel(cfg, { role, provider: pid });
  if (!m) return { error: `Pick a ${preset.name} model in Settings → Chat model first.`, code: "no_model" };
  return { preset, baseUrl: baseUrl.replace(/\/+$/, ""), apiKey, model: m };
}

/** Human label for a model id. */
export function modelLabel(id) {
  return id ? String(id).replace(/:free$/, "") : "No model picked yet";
}

/** Can the model for this role see images? */
export function canSeeImages(cfg, { role = "main", model } = {}) {
  const p = cfg.chat?.provider || "";
  const m = model || resolveModel(cfg, { role, provider: p });
  if (p === "openrouter") { const x = openrouterPrice(m); if (x?.vision !== undefined && x.vision !== null) return !!x.vision; }
  return visionCapable(p, m);
}

// ── spend (an estimate) ────────────────────────────────────────────────────
// USD per 1M tokens: [match, input, output]. Cached reads count at 10% of input, cache writes at 125%.
// Prices change; this is a rough guide for the monthly estimate and the optional caps, not a bill.
const PRICES = [
  [/claude-haiku-5[.-]5/, 0.10, 0.50], [/claude-sonnet-5[.-]5/, 2, 10], [/claude-opus-5[.-]5/, 4, 20],
  [/claude-haiku-4[.-]5/, 1, 5], [/claude-sonnet-4/, 3, 15], [/claude-opus-4/, 5, 25],
  [/gpt-5-nano/, 0.05, 0.40], [/gpt-5-mini/, 0.25, 2], [/gpt-5/, 1.25, 10],
  [/gpt-4\.1-nano/, 0.10, 0.40], [/gpt-4\.1-mini/, 0.40, 1.60], [/gpt-4\.1/, 2, 8], [/gpt-4o-mini/, 0.15, 0.60], [/gpt-4o/, 2.5, 10],
  [/gemini-2\.5-flash-lite/, 0.10, 0.40], [/gemini-2\.5-flash/, 0.30, 2.50], [/gemini-2\.5-pro/, 1.25, 10],
  [/grok-4/, 3, 15], [/grok-3-mini/, 0.30, 0.50],
  [/llama-3\.3-70b/, 0.59, 0.79], [/llama-3\.1-8b/, 0.05, 0.08], [/gpt-oss-120b/, 0.15, 0.75], [/qwen3-32b/, 0.29, 0.59],
  [/deepseek-reasoner/, 0.55, 2.19], [/deepseek-chat/, 0.27, 1.10],
  [/qwen-max/, 1.6, 6.4], [/qwen-plus/, 0.4, 1.2], [/qwen-turbo/, 0.05, 0.2], [/qwen-vl/, 0.21, 0.63],
  [/kimi-k2/, 0.6, 2.5],
  [/mistral-large/, 2, 6], [/mistral-medium/, 0.4, 2], [/mistral-small/, 0.1, 0.3], [/pixtral-large/, 2, 6],
];

/** { in, out } USD per 1M tokens, 0 for models on this computer, null when unknown. */
export function priceFor(presetId, model) {
  const p = CHAT_BY_ID.get(presetId);
  if (p?.kind === "local") return { in: 0, out: 0 };
  if (presetId === "openrouter") { const x = openrouterPrice(model); if (x) return { in: x.in, out: x.out }; }
  const id = String(model || "").toLowerCase().replace(/^[a-z0-9-]+\//, "");
  const hit = PRICES.find(([re]) => re.test(id));
  return hit ? { in: hit[1], out: hit[2] } : null;
}

const month = (t = Date.now()) => new Date(t).toISOString().slice(0, 7);
export const readSpend = () => readJsonFile(P.modelSpend, { months: {} });

export function recordSpend(presetId, model, u) {
  const price = priceFor(presetId, model);
  const s = readSpend();
  const m = month();
  const row = s.months[m]?.[presetId] || { usd: 0, input: 0, output: 0, calls: 0, unpriced: 0 };
  const cr = u.cache_read || 0, cw = u.cache_write || 0;
  const plain = Math.max(0, (u.prompt_tokens || 0) - cr - cw);
  row.calls += 1; row.input += u.prompt_tokens || 0; row.output += u.completion_tokens || 0;
  const cost = price ? (plain * price.in + cw * price.in * 1.25 + cr * price.in * 0.1 + (u.completion_tokens || 0) * price.out) / 1e6 : 0;
  if (price) row.usd = Math.round((row.usd + cost) * 1e6) / 1e6;
  else row.unpriced += 1;
  // The daily USD cap for tasks (tasks.js) reads `usd` per day from usage.json.
  if (cost > 0) {
    const usage = readJsonFile(P.usage, { days: {} });
    const d = new Date().toISOString().slice(0, 10);
    const day = usage.days[d] || { calls: 0, prompt: 0, completion: 0, models: {} };
    day.usd = Math.round(((day.usd || 0) + cost) * 1e6) / 1e6;
    usage.days[d] = day;
    writeJsonFile(P.usage, usage);
  }
  s.months[m] = { ...(s.months[m] || {}), [presetId]: row };
  for (const k of Object.keys(s.months).sort().slice(0, -13)) delete s.months[k];
  writeJsonFile(P.modelSpend, s);
}

/** This month's estimated spend per provider, plus the caps. */
export function spendSummary(cfg) {
  const rows = readSpend().months[month()] || {};
  const providers = Object.entries(rows).map(([id, r]) => ({ id, name: CHAT_BY_ID.get(id)?.name || id, ...r, usd: Math.round(r.usd * 10000) / 10000, cap: cfg.chat?.caps?.[id] || 0 }));
  return { month: month(), estimate: true, totalUsd: Math.round(providers.reduce((a, b) => a + b.usd, 0) * 10000) / 10000, providers, caps: cfg.chat?.caps || {} };
}

function overCap(cfg, presetId) {
  const cap = cfg.chat?.caps?.[presetId] || 0;
  if (!(cap > 0)) return null;
  const used = readSpend().months[month()]?.[presetId]?.usd || 0;
  return used >= cap ? { cap, used: Math.round(used * 100) / 100 } : null;
}

// ── OpenAI-compatible ──────────────────────────────────────────────────────
export class ModelClient {
  constructor({ apiKey, model, maxTokens = 4096, temperature = 0.6, baseUrl, usage = "openai", providerName = "the model provider", presetId = "" }) {
    this.apiKey = apiKey;
    this.model = model;
    this.url = baseUrl;
    this.usage = usage;
    this.providerName = providerName;
    this.presetId = presetId;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.noTools = false;
  }

  async *stream(messages, tools, signal) {
    const useTools = !this.noTools && tools && tools.length > 0;
    const msgs = messages.map(({ raw, ...m }) => m); // provider blocks are for their own provider only
    const body = { model: this.model, messages: msgs, stream: true, max_tokens: this.maxTokens, temperature: this.temperature };
    if (this.usage === "openrouter") body.usage = { include: true };
    else if (this.usage === "openai") body.stream_options = { include_usage: true };
    if (useTools) { body.tools = tools; body.tool_choice = "auto"; }
    const headers = { "Content-Type": "application/json" };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (this.usage === "openrouter") { headers["HTTP-Referer"] = "https://useclaudia.xyz"; headers["X-Title"] = "Claudia Local"; }

    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const timeout = AbortSignal.timeout(120_000);
        res = await fetch(`${this.url}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
      } catch (e) {
        if (signal?.aborted) return;
        if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
        yield { type: "error", status: 0, error: `Couldn't reach ${this.providerName}: ${e.message}` };
        return;
      }
      if (!res.ok && RETRY_STATUS.includes(res.status) && attempt < 2) {
        await res.text().catch(() => "");
        await sleep(1000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      if (res.status === 400 && body.stream_options && /stream_options/i.test(text)) {
        this.usage = null;
        yield* this.stream(messages, tools, signal);
        return;
      }
      if (useTools && (res.status === 404 || res.status === 400) && /tool/i.test(text)) {
        this.noTools = true;
        yield { type: "notice", text: "This model can't use tools, so it will answer without them." };
        yield* this.stream(messages, null, signal);
        return;
      }
      yield { type: "error", status: res.status, error: text.slice(0, 500) };
      return;
    }

    const calls = new Map();
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let model = this.model;
    const flush = () => {
      if (!calls.size) return null;
      const tool_calls = [...calls.values()].map((c, i) => ({ id: c.id || `call_${Date.now()}_${i}`, type: "function", function: { name: c.name, arguments: c.args || "{}" } }));
      calls.clear();
      return tool_calls;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          const data = t.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let chunk;
          try { chunk = JSON.parse(data); } catch { continue; }
          if (chunk.error) { yield { type: "error", status: Number(chunk.error.code) || 502, error: String(chunk.error.message || "Model error") }; return; }
          if (chunk.model) model = chunk.model;
          const choice = chunk.choices?.[0];
          const delta = choice?.delta;
          if (delta?.content) yield { type: "delta", text: delta.content };
          for (const tc of delta?.tool_calls || []) {
            const i = tc.index ?? 0;
            const cur = calls.get(i) || { id: "", name: "", args: "" };
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.name += tc.function.name;
            if (tc.function?.arguments) cur.args += tc.function.arguments;
            calls.set(i, cur);
          }
          if (chunk.usage) yield { type: "usage", model, usage: { prompt_tokens: chunk.usage.prompt_tokens || 0, completion_tokens: chunk.usage.completion_tokens || 0, cache_read: chunk.usage.prompt_tokens_details?.cached_tokens || 0 } };
          if (choice?.finish_reason) { const tc = flush(); if (tc) yield { type: "tool_call", tool_calls: tc }; }
        }
      }
    } catch (e) {
      if (signal?.aborted) return;
      yield { type: "error", status: 0, error: `Stream interrupted: ${e.message}` };
      return;
    }
    const tc = flush();
    if (tc) yield { type: "tool_call", tool_calls: tc };
    yield { type: "done", model };
  }

  /** One whole reply as text (no tools). Used by the campaign planner. */
  async complete(messages, signal) {
    return completeText(this, messages, signal);
  }
}

async function completeText(client, messages, signal) {
  let text = "";
  for await (const c of client.stream(messages, null, signal)) {
    if (c.type === "delta") text += c.text;
    else if (c.type === "error") throw Object.assign(new Error(c.error || "The model returned an error."), { status: c.status || 502 });
  }
  return text;
}

// ── Anthropic Messages API ─────────────────────────────────────────────────
const toolId = (id, i) => String(id || `toolu_${i}`).replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
const jsonOr = (s, d) => { try { const v = JSON.parse(s || "{}"); return v && typeof v === "object" && !Array.isArray(v) ? v : d; } catch { return d; } };

function userBlocks(content) {
  if (typeof content === "string") return content.trim() ? [{ type: "text", text: content }] : [{ type: "text", text: "(empty message)" }];
  const out = [];
  for (const p of Array.isArray(content) ? content : []) {
    if (p?.type === "text" && p.text) out.push({ type: "text", text: String(p.text) });
    else if (p?.type === "image_url") {
      const m = /^data:(image\/(?:png|jpeg|gif|webp));base64,(.+)$/.exec(String(p.image_url?.url || ""));
      if (m) out.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }
  }
  return out.length ? out : [{ type: "text", text: "(empty message)" }];
}

/**
 * OpenAI-shaped history → { system, messages } for the Messages API.
 * Thinking blocks are only sent back for the turn in progress (after the last user message); earlier
 * turns go back as text and tool calls, so trimming old history never trips the thinking-block checks.
 */
export function toAnthropic(messages, { keepThinking = true } = {}) {
  let system = "";
  const out = [];
  let lastUser = -1;
  messages.forEach((m, i) => { if (m.role === "user") lastUser = i; });
  const push = (role, blocks) => {
    const prev = out[out.length - 1];
    if (prev && prev.role === role) prev.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  messages.forEach((m, i) => {
    if (m.role === "system") { system += (system ? "\n\n" : "") + (typeof m.content === "string" ? m.content : userBlocks(m.content).map(b => b.text || "").join("\n")); return; }
    if (m.role === "user") return push("user", userBlocks(m.content));
    if (m.role === "tool") return push("user", [{ type: "tool_result", tool_use_id: toolId(m.tool_call_id, i), content: String(m.content ?? "") || "(empty)" }]);
    if (m.role !== "assistant") return;
    let blocks;
    if (i > lastUser && Array.isArray(m.raw) && m.raw.length) {
      blocks = keepThinking ? m.raw : m.raw.filter(b => b.type !== "thinking" && b.type !== "redacted_thinking");
    } else {
      blocks = [];
      if (m.content && String(m.content).trim()) blocks.push({ type: "text", text: String(m.content) });
      (m.tool_calls || []).forEach((tc, j) => blocks.push({ type: "tool_use", id: toolId(tc.id, `${i}_${j}`), name: String(tc.function?.name || "unknown"), input: jsonOr(tc.function?.arguments, {}) }));
    }
    if (blocks.length) push("assistant", blocks);
  });
  // Every tool_use needs a tool_result in the next user message (a stopped turn can leave one open).
  for (let i = 0; i < out.length; i++) {
    if (out[i].role !== "assistant") continue;
    const ids = out[i].content.filter(b => b.type === "tool_use").map(b => b.id);
    if (!ids.length) continue;
    let next = out[i + 1];
    if (!next || next.role !== "user") { next = { role: "user", content: [] }; out.splice(i + 1, 0, next); }
    const have = new Set(next.content.filter(b => b.type === "tool_result").map(b => b.tool_use_id));
    const missing = ids.filter(id => !have.has(id)).map(id => ({ type: "tool_result", tool_use_id: id, content: "(no result: the turn was stopped)", is_error: true }));
    const results = [...next.content.filter(b => b.type === "tool_result" && ids.includes(b.tool_use_id)), ...missing];
    next.content = [...results, ...next.content.filter(b => !(b.type === "tool_result" && ids.includes(b.tool_use_id)))];
  }
  while (out.length && out[0].role !== "user") out.shift();
  return { system, messages: out };
}

export class AnthropicClient {
  constructor({ apiKey, model, maxTokens = 4096, baseUrl, providerName = "Anthropic", presetId = "anthropic" }) {
    this.apiKey = apiKey;
    this.model = model;
    this.url = baseUrl || anthropicBase();
    this.providerName = providerName;
    this.presetId = presetId;
    // Thinking counts against max_tokens, so leave room above the reply length you set.
    this.maxTokens = Math.max(16000, maxTokens || 0);
    this.noTools = false;
  }

  body(messages, tools, { keepThinking = true, fallbacks = true } = {}) {
    const { system, messages: msgs } = toAnthropic(messages, { keepThinking });
    const body = { model: this.model, max_tokens: this.maxTokens, stream: true, messages: msgs, cache_control: { type: "ephemeral" } };
    if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
    if (tools?.length && !this.noTools) {
      body.tools = tools.map(t => ({ name: t.function.name, description: t.function.description || "", input_schema: t.function.parameters || { type: "object", properties: {} } }));
      body.tools[body.tools.length - 1].cache_control = { type: "ephemeral" };
    }
    // Claude declines some requests; on Opus and Sonnet the API can hand them to another model itself.
    if (fallbacks && /^claude-(opus|sonnet)-5-5/.test(this.model)) body.fallbacks = "default";
    return body;
  }

  async *stream(messages, tools, signal, opts = {}) {
    const body = this.body(messages, tools, opts);
    const headers = { "Content-Type": "application/json", "x-api-key": this.apiKey, "anthropic-version": ANTHROPIC_VERSION };
    if (body.fallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const timeout = AbortSignal.timeout(180_000);
        res = await fetch(`${this.url}/messages`, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
      } catch (e) {
        if (signal?.aborted) return;
        if (attempt < 2) { await sleep(800 * (attempt + 1)); continue; }
        yield { type: "error", status: 0, error: `Couldn't reach ${this.providerName}: ${e.message}` };
        return;
      }
      if (!res.ok && RETRY_STATUS.includes(res.status) && attempt < 2) {
        const ra = Number(res.headers.get("retry-after"));
        await res.text().catch(() => "");
        await sleep(Number.isFinite(ra) && ra > 0 && ra <= 20 ? ra * 1000 : 1000 * (attempt + 1));
        continue;
      }
      break;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      let msg = text;
      try { msg = JSON.parse(text).error?.message || text; } catch { /* not JSON */ }
      if (res.status === 400 && body.fallbacks && /fallback/i.test(msg)) { yield* this.stream(messages, tools, signal, { ...opts, fallbacks: false }); return; }
      if (res.status === 400 && opts.keepThinking !== false && /thinking|signature|prefix/i.test(msg)) { yield* this.stream(messages, tools, signal, { ...opts, keepThinking: false }); return; }
      if (res.status === 400 && body.tools && /tool/i.test(msg) && !/tool_use|tool_result/i.test(msg)) {
        this.noTools = true;
        yield { type: "notice", text: "This model can't use tools, so it will answer without them." };
        yield* this.stream(messages, null, signal, opts);
        return;
      }
      yield { type: "error", status: res.status, error: String(msg).slice(0, 500) };
      return;
    }

    const blocks = []; // by index: { type, …, json? }
    const usage = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 };
    let model = this.model;
    let stop = "";
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith("data:")) continue;
          let ev;
          try { ev = JSON.parse(t.slice(5).trim()); } catch { continue; }
          switch (ev.type) {
            case "message_start": {
              const u = ev.message?.usage || {};
              if (ev.message?.model) model = ev.message.model;
              usage.input = u.input_tokens || 0; usage.cacheRead = u.cache_read_input_tokens || 0; usage.cacheWrite = u.cache_creation_input_tokens || 0; usage.output = u.output_tokens || 0;
              break;
            }
            case "content_block_start": {
              const b = { ...(ev.content_block || {}) };
              if (b.type === "tool_use") { b.json = ""; b.input = {}; }
              if (b.type === "text") b.text = b.text || "";
              if (b.type === "thinking") { b.thinking = b.thinking || ""; b.signature = b.signature || ""; }
              blocks[ev.index] = b;
              if (b.type === "text" && b.text) yield { type: "delta", text: b.text };
              break;
            }
            case "content_block_delta": {
              const b = blocks[ev.index];
              const d = ev.delta || {};
              if (!b) break;
              if (d.type === "text_delta" && d.text) { b.text = (b.text || "") + d.text; yield { type: "delta", text: d.text }; }
              else if (d.type === "input_json_delta") b.json += d.partial_json || "";
              else if (d.type === "thinking_delta") b.thinking += d.thinking || "";
              else if (d.type === "signature_delta") b.signature = (b.signature || "") + (d.signature || "");
              break;
            }
            case "content_block_stop": {
              const b = blocks[ev.index];
              if (b?.type === "tool_use") { b.input = jsonOr(b.json, {}); b.done = true; }
              else if (b) b.done = true;
              break;
            }
            case "message_delta": {
              if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
              const u = ev.usage || {};
              if (u.output_tokens !== undefined) usage.output = u.output_tokens;
              if (u.input_tokens) usage.input = u.input_tokens;
              if (u.cache_read_input_tokens) usage.cacheRead = u.cache_read_input_tokens;
              if (u.cache_creation_input_tokens) usage.cacheWrite = u.cache_creation_input_tokens;
              break;
            }
            case "error": {
              const e = ev.error || {};
              yield { type: "error", status: e.type === "overloaded_error" ? 529 : e.type === "rate_limit_error" ? 429 : e.type === "api_error" ? 500 : 502, error: String(e.message || "Model error") };
              return;
            }
            default: break; // ping, message_stop
          }
        }
      }
    } catch (e) {
      if (signal?.aborted) return;
      yield { type: "error", status: 0, error: `Stream interrupted: ${e.message}` };
      return;
    }

    yield { type: "usage", model, usage: { prompt_tokens: usage.input + usage.cacheRead + usage.cacheWrite, completion_tokens: usage.output, cache_read: usage.cacheRead, cache_write: usage.cacheWrite } };
    if (stop === "refusal") { yield { type: "error", status: 422, error: "Claude declined this request." }; return; }
    // Keep finished blocks only (a reply cut off by max_tokens can leave a half-written tool call).
    const raw = blocks.filter(b => b && b.done).map(({ json, done, ...b }) => b);
    const calls = raw.filter(b => b.type === "tool_use").map(b => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
    if (calls.length) yield { type: "tool_call", tool_calls: calls, raw };
    yield { type: "done", model, raw };
  }

  async complete(messages, signal) {
    return completeText(this, messages, signal);
  }
}

// ── fallback: try another model once when the main one fails ───────────────
class FallbackClient {
  constructor(primary, fallback, label) {
    this.primary = primary;
    this.fallback = fallback;
    this.label = label;
    this.model = primary.model;
  }
  async *stream(messages, tools, signal) {
    let started = false, failed = null;
    for await (const c of this.primary.stream(messages, tools, signal)) {
      if (c.type === "error" && !started) { failed = c; break; }
      if (c.type === "delta" || c.type === "tool_call") started = true;
      yield c;
    }
    if (!failed || signal?.aborted) return;
    const why = failed.status === 429 ? "rate limit" : failed.status >= 500 || failed.status === 0 ? "provider problem" : `error ${failed.status}`;
    yield { type: "notice", text: `The main model failed (${why}). Trying the fallback, ${this.label}, once.` };
    yield* this.fallback.stream(messages, tools, signal);
  }
  async complete(messages, signal) { return completeText(this, messages, signal); }
}

// ── building a client ──────────────────────────────────────────────────────
function makeClient(t, cfg, { maxTokens, temperature }) {
  const common = { apiKey: t.apiKey, model: t.model, baseUrl: t.baseUrl, providerName: t.preset.name, presetId: t.preset.id, maxTokens: maxTokens ?? cfg.maxTokens };
  const c = t.preset.kind === "anthropic" ? new AnthropicClient(common) : new ModelClient({ ...common, usage: t.preset.usage, temperature: temperature ?? cfg.temperature });
  // Meter every call: estimated spend per provider and "last used" on the key.
  const inner = c.stream.bind(c);
  c.stream = async function* (...a) {
    if (t.preset.key) touchKey(t.preset.key);
    for await (const ev of inner(...a)) {
      if (ev.type === "usage") { try { recordSpend(t.preset.id, ev.model || t.model, ev.usage); } catch { /* estimate only */ } }
      yield ev;
    }
  };
  return c;
}

/**
 * A client for the current chat settings: { client, model, provider } or { error }.
 *   role   "main" (default), "helpers", "tasks" or a helper name (research, market, …)
 *   model  a model id for this call only
 */
export function chatClient(cfg, { model, role = "main", maxTokens, temperature } = {}) {
  const t = chatTarget(cfg, { role, model });
  if (t.error) return { error: t.error, code: t.code };
  const cap = overCap(cfg, t.preset.id);
  if (cap) return { error: `Paused: ${t.preset.name} reached your monthly cap ($${cap.used} of $${cap.cap}, estimated). Raise the cap in Settings → Chat model, or wait for next month.`, code: "cap" };
  let client = makeClient(t, cfg, { maxTokens, temperature });
  const fb = cfg.chat?.fallback;
  if (fb?.provider && fb.model && !(fb.provider === t.preset.id && fb.model === t.model)) {
    const ft = chatTarget(cfg, { provider: fb.provider, model: fb.model });
    if (!ft.error && !overCap(cfg, ft.preset.id)) client = new FallbackClient(client, makeClient(ft, cfg, { maxTokens, temperature }), `${ft.preset.name} ${ft.model}`);
  }
  return { client, model: t.model, provider: t.preset };
}

/** Models for a provider (its own list when it has one, else a short built-in list). */
export function listModels(presetId, cfg) {
  return listChatModels(presetId, { baseUrl: cfg?.chat?.baseUrl });
}
