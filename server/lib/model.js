/**
 * model.js — streaming chat completions with the user's own key, from any OpenAI-compatible server.
 *
 * Presets (OpenRouter, xAI, Qwen, DeepSeek, Kimi, OpenAI, Anthropic, or your own server) live in
 * providers.js → CHAT_PRESETS; Settings → Chat model picks one. OpenAI-compatible SSE: tool calls
 * arrive in fragments and are stitched together by index. If the chosen model can't use tools, the
 * turn is retried once without tools.
 *
 * CLAUDIA_LOCAL_OPENROUTER_BASE points the OpenRouter preset at another OpenAI-compatible endpoint (a
 * local mock for tests, a proxy). Only https:// or a loopback http:// URL is accepted.
 */
import * as vault from "./vault.js";
import { CHAT_BY_ID, providerValue } from "./providers.js";

export const DEFAULT_MODEL = "openrouter/free";
const OPENROUTER = "https://openrouter.ai/api/v1";

export function baseUrl() {
  const o = process.env.CLAUDIA_LOCAL_OPENROUTER_BASE?.trim();
  if (!o) return OPENROUTER;
  let u;
  try { u = new URL(o); } catch { throw new Error("CLAUDIA_LOCAL_OPENROUTER_BASE is not a URL"); }
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) throw new Error("CLAUDIA_LOCAL_OPENROUTER_BASE must be https:// or a local http:// address");
  return o.replace(/\/+$/, "");
}

/**
 * Where the agent's chat goes, from the settings: { preset, baseUrl, apiKey, model, usage } or { error }.
 * `override` is a model id for this one call (helpers can have their own model).
 */
export function chatTarget(cfg, override) {
  const preset = CHAT_BY_ID.get(cfg.chat?.provider || "openrouter") || CHAT_BY_ID.get("openrouter");
  if (!vault.isUnlocked()) return { error: "Claudia Local is locked." };
  if (preset.id === "openrouter") {
    const apiKey = vault.get("openrouterKey");
    if (!apiKey) return { error: "Add your OpenRouter key in Settings → Chat model first." };
    return { preset, baseUrl: baseUrl(), apiKey, model: override || cfg.model || DEFAULT_MODEL, usage: preset.usage };
  }
  const apiKey = providerValue(preset.key, "key") || "";
  if (!apiKey && preset.id !== "custom") return { error: `Add your ${preset.name} key in Settings → Keys and providers first.` };
  const url = preset.id === "custom" ? cfg.chat.baseUrl : preset.baseUrl;
  if (!url) return { error: "Set the chat server address in Settings → Chat model first." };
  const model = override || cfg.chat.models?.[preset.id] || "";
  if (!model) return { error: `Pick a ${preset.name} model in Settings → Chat model first.` };
  return { preset, baseUrl: url.replace(/\/+$/, ""), apiKey, model, usage: preset.usage };
}

/** Human label for a model id; the default id is never shown in the dashboard. */
export function modelLabel(id) {
  if (!id || id === DEFAULT_MODEL) return "Default model";
  return String(id).replace(/:free$/, "");
}

export class ModelClient {
  constructor({ apiKey, model, maxTokens = 4096, temperature = 0.6, baseUrl: url, usage = "openrouter", providerName = "OpenRouter" }) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.url = url || baseUrl();
    this.usage = usage;
    this.providerName = providerName;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.noTools = false;
  }

  async *stream(messages, tools, signal) {
    const useTools = !this.noTools && tools && tools.length > 0;
    const body = { model: this.model, messages, stream: true, max_tokens: this.maxTokens, temperature: this.temperature };
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
        if (attempt < 2) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; }
        yield { type: "error", status: 0, error: `Couldn't reach ${this.providerName}: ${e.message}` };
        return;
      }
      if (!res.ok && [429, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
        await res.text().catch(() => "");
        await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      break;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
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
          if (chunk.usage) yield { type: "usage", model, usage: { prompt_tokens: chunk.usage.prompt_tokens || 0, completion_tokens: chunk.usage.completion_tokens || 0 } };
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
    let text = "";
    for await (const c of this.stream(messages, null, signal)) {
      if (c.type === "delta") text += c.text;
      else if (c.type === "error") throw Object.assign(new Error(c.error || "The model returned an error."), { status: c.status || 502 });
    }
    return text;
  }
}

/** A ModelClient for the current chat settings, or { error }. */
export function chatClient(cfg, { model, maxTokens, temperature } = {}) {
  const t = chatTarget(cfg, model);
  if (t.error) return { error: t.error };
  return { client: new ModelClient({ apiKey: t.apiKey, model: t.model, baseUrl: t.baseUrl, usage: t.usage, providerName: t.preset.name, maxTokens: maxTokens ?? cfg.maxTokens, temperature: temperature ?? cfg.temperature }), model: t.model, provider: t.preset };
}

let modelsCache = null;
/** OpenRouter's public model list (no key needed). Fetched only when you open the model picker. */
export async function listModels() {
  if (modelsCache && Date.now() - modelsCache.ts < 10 * 60_000) return modelsCache.models;
  const r = await fetch(`${baseUrl()}/models`, { signal: AbortSignal.timeout(15_000), redirect: "error" });
  if (!r.ok) throw new Error(`OpenRouter answered ${r.status}`);
  const j = await r.json();
  const models = (j.data || []).map(m => {
    const p = Number(m.pricing?.prompt || 0), c = Number(m.pricing?.completion || 0);
    return {
      id: m.id,
      name: String(m.name || m.id).replace(/\s*\(free\)\s*$/i, ""),
      context: m.context_length || null,
      noCost: p === 0 && c === 0,
      promptPerM: Math.round(p * 1e6 * 100) / 100,
      completionPerM: Math.round(c * 1e6 * 100) / 100,
      tools: Array.isArray(m.supported_parameters) ? m.supported_parameters.includes("tools") : null,
    };
  });
  modelsCache = { ts: Date.now(), models };
  return models;
}
