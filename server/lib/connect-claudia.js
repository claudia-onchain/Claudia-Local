/**
 * connect-claudia.js — one-click connect to a Claudia agent, with a code exchange so no key travels in a URL.
 *
 *  1. start(): makes sure this app has a device key, then creates a random `state` and a PKCE pair
 *     (code_verifier stays here; code_challenge = base64url(SHA-256(verifier))). The dashboard opens
 *     https://useclaudia.xyz/connect/local?callback=http://127.0.0.1:<port>/oauth/claudia&state=…&device=…&challenge=…&name=…
 *  2. On the site you sign in with your wallet, pick or create the agent and approve. The site registers this
 *     device key on the agent and redirects back here with a one-time `code` (5 minutes, single use).
 *  3. callback(): checks `state`, then POSTs { code, code_verifier, device } to /api/connect/local/exchange
 *     and gets { agentSlug, agentName, apiKey }. The key goes straight into the vault.
 *
 * The callback is a cross-site navigation, so the session cookie isn't sent: the random state (kept in memory,
 * single use, 10 minutes) and the verifier that never left this process are what tie it to you.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as vault from "./vault.js";
import { getConfig, saveConfig, trackActivity } from "./store.js";
import * as deps from "./claudia.js";

const TTL_MS = 10 * 60_000;
const pending = new Map(); // state -> { verifier, device, baseUrl, createdAt }
setInterval(() => { const now = Date.now(); for (const [k, v] of pending) if (now - v.createdAt > TTL_MS) pending.delete(k); }, 60_000).unref();

const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const b64url = (buf) => Buffer.from(buf).toString("base64url");

/** Starts a connect: returns the site URL to open. `name` is a suggested agent name. */
export function start({ port, name } = {}) {
  if (!vault.isUnlocked()) throw err(423, "Unlock Claudia Local first.");
  const device = deps.ensureDeviceKey();
  const baseUrl = getConfig().claudia.baseUrl.replace(/\/+$/, "");
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(32)); // 43 characters, as PKCE asks
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  if (pending.size > 20) pending.delete(pending.keys().next().value);
  pending.set(state, { verifier, device, baseUrl, createdAt: Date.now() });
  const u = new URL(`${baseUrl}/connect/local`);
  u.searchParams.set("callback", `http://127.0.0.1:${port}/oauth/claudia`);
  u.searchParams.set("state", state);
  u.searchParams.set("device", device);
  u.searchParams.set("challenge", challenge);
  const nm = String(name || "").replace(/[^\p{L}\p{N} ._-]/gu, "").trim().slice(0, 40);
  if (nm) u.searchParams.set("name", nm);
  trackActivity("claudia", "Started connecting to Claudia (one click)");
  return { url: u.toString(), state, expiresAt: Date.now() + TTL_MS };
}

function takeState(state) {
  const s = String(state || "");
  for (const [k, v] of pending) {
    const a = Buffer.from(k), b = Buffer.from(s);
    if (a.length === b.length && timingSafeEqual(a, b)) { pending.delete(k); return Date.now() - v.createdAt > TTL_MS ? null : v; }
  }
  return null;
}

/** GET /oauth/claudia?code=…&state=… — finishes the exchange. Returns { ok, title, text }. */
export async function callback(query) {
  const state = query.get("state") || "", code = query.get("code") || "", error = query.get("error") || "";
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(state)) return { ok: false, title: "Not connected", text: "This link is missing its state or it's malformed. Start again from Claudia Local." };
  const p = takeState(state);
  if (!p) return { ok: false, title: "Not connected", text: "This connect link expired or was already used. Start again from Claudia Local." };
  if (error) return { ok: false, title: "Not connected", text: error === "access_denied" ? "You didn't approve the connection. Nothing changed." : `Claudia said: ${error.slice(0, 200)}` };
  if (!code || code.length > 512 || !/^[A-Za-z0-9_.~-]+$/.test(code)) return { ok: false, title: "Not connected", text: "The sign-in code is missing. Start again from Claudia Local." };
  if (!vault.isUnlocked()) return { ok: false, title: "Unlock first", text: "Claudia Local is locked, so it can't finish connecting. Unlock it and click Connect again." };
  if (deps.devicePublicKey() !== p.device) return { ok: false, title: "Not connected", text: "The device key changed while you were on Claudia. Start again." };
  if (getConfig().claudia.baseUrl.replace(/\/+$/, "") !== p.baseUrl) return { ok: false, title: "Not connected", text: "The Claudia address changed while you were on Claudia. Start again." };

  let r;
  try {
    const res = await fetch(`${p.baseUrl}/api/connect/local/exchange`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, redirect: "error",
      body: JSON.stringify({ code, code_verifier: p.verifier, device: p.device }), signal: AbortSignal.timeout(20_000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, title: "Not connected", text: `Claudia refused the code: ${String(body.message || body.error || res.status).slice(0, 200)}. Start again.` };
    r = body;
  } catch (e) {
    return { ok: false, title: "Not connected", text: `Couldn't reach ${new URL(p.baseUrl).host}: ${String(e.message || e).slice(0, 160)}` };
  }
  const apiKey = String(r.apiKey || "");
  if (!/^ck_(live|test)_[A-Za-z0-9_-]{8,200}$/.test(apiKey)) return { ok: false, title: "Not connected", text: "Claudia's answer didn't contain a valid API key." };
  vault.set({ claudiaApiKey: apiKey });
  const cfg = getConfig();
  cfg.claudia.source = "one-click";
  cfg.claudia.agent = null;
  saveConfig(cfg);
  let name = String(r.agentName || r.agentSlug || "your agent").slice(0, 80);
  try { const me = await deps.refreshMe(); name = me.name || name; } catch (e) {
    trackActivity("claudia", `Connected to Claudia, but couldn't load the agent yet: ${deps.explain(e).message}`);
  }
  trackActivity("claudia", `Connected as ${name} (one click)`);
  return { ok: true, title: "Connected", text: `Claudia Local is connected as ${name}. You can close this tab.`, agent: name };
}
