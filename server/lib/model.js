/**
 * model.js — streaming chat completions from OpenRouter with the user's own key.
 *
 * OpenAI-compatible SSE. Tool calls arrive in fragments and are stitched together by index.
 * If the chosen model can't use tools, the turn is retried once without tools.
 *
 * CLAUDIA_LOCAL_OPENROUTER_BASE points the client at another OpenAI-compatible endpoint (a local
 * mock for tests, a proxy). Only https:// or a loopback http:// URL is accepted.
 */
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

/** Human label for a model id; the default id is never shown in the dashboard. */
export function modelLabel(id) {
  if (!id || id === DEFAULT_MODEL) return "Default model";
  return String(id).replace(/:free$/, "");
}

export class ModelClient {
  constructor({ apiKey, model, maxTokens = 4096, temperature = 0.6 }) {
    this.apiKey = apiKey;
    this.model = model || DEFAULT_MODEL;
    this.maxTokens = maxTokens;
    this.temperature = temperature;
    this.noTools = false;
  }

  async *stream(messages, tools, signal) {
    const useTools = !this.noTools && tools && tools.length > 0;
    const body = { model: this.model, messages, stream: true, max_tokens: this.maxTokens, temperature: this.temperature, usage: { include: true } };
    if (useTools) { body.tools = tools; body.tool_choice = "auto"; }
    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.apiKey}`,
      "HTTP-Referer": "https://useclaudia.xyz",
      "X-Title": "Claudia Local",
    };

    let res;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const timeout = AbortSignal.timeout(120_000);
        res = await fetch(`${baseUrl()}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout, redirect: "error" });
      } catch (e) {
        if (signal?.aborted) return;
        if (attempt < 2) { await new Promise(r => setTimeout(r, 800 * (attempt + 1))); continue; }
        yield { type: "error", status: 0, error: `Couldn't reach OpenRouter: ${e.message}` };
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
