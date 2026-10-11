/**
 * http.js — JSON helpers and the local-only request checks.
 *
 * The server listens on 127.0.0.1 only. On top of that:
 *  - Host must be 127.0.0.1:<port> or localhost:<port> (blocks DNS-rebinding pages),
 *  - writes must come from our own origin (or from no browser at all),
 *  - WebSocket upgrades must come from our own origin,
 *  - everything except /api/health, /api/state, /api/setup, /api/unlock and GET /oauth/callback (see
 *    routes-studio.js: protected by the one-time OAuth state + PKCE) needs the session cookie
 *    that unlocking sets (HttpOnly, SameSite=Strict).
 *  - sessions expire: after SESSION_IDLE_MS without a request, and SESSION_MAX_MS after unlocking at the
 *    latest. The vault's own auto-lock (Settings → Lock) still applies on top.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_IDLE_MS = 12 * 60 * 60_000;
export const SESSION_MAX_MS = 24 * 60 * 60_000;

export class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

export function json(res, code, body) {
  if (res.headersSent) return;
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

export function readJson(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0, tooLarge = false;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (tooLarge) { if (size > limit + 8 * 1024 * 1024) req.destroy(); return; }
      if (size > limit) { tooLarge = true; chunks.length = 0; reject(new HttpError(413, `That's too big (max ${Math.round(limit / 1024)} KB).`)); return; }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) return resolve({});
      try {
        const v = JSON.parse(raw);
        resolve(v && typeof v === "object" && !Array.isArray(v) ? v : {});
      } catch { reject(new HttpError(400, "Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

export function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (k) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

export function createGuards(port) {
  const hosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  const origins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`]);
  const cookieName = `cl_session_${port}`;
  let sessions = new Map(); // token -> { created, seen }
  const alive = (s, now) => now - s.seen < SESSION_IDLE_MS && now - s.created < SESSION_MAX_MS;

  return {
    cookieName,
    hostAllowed(req) {
      return hosts.has(String(req.headers.host || "").toLowerCase());
    },
    /** For writes: same origin, or no Origin header at all (curl / scripts on this machine). */
    originAllowed(req) {
      const origin = String(req.headers.origin || "").toLowerCase();
      if (origin) return origins.has(origin);
      const site = String(req.headers["sec-fetch-site"] || "");
      return !site || site === "same-origin" || site === "none";
    },
    /** WebSocket: browsers always send Origin; it must be ours. */
    wsOriginAllowed(req) {
      const origin = String(req.headers.origin || "").toLowerCase();
      return !origin || origins.has(origin);
    },
    newSession() {
      const t = randomBytes(32).toString("base64url");
      const now = Date.now();
      for (const [k, s] of sessions) if (!alive(s, now)) sessions.delete(k);
      sessions.set(t, { created: now, seen: now });
      return t;
    },
    sessionCookie(token, maxAgeSec = token ? SESSION_MAX_MS / 1000 : undefined) {
      return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict${maxAgeSec !== undefined ? `; Max-Age=${maxAgeSec}` : ""}`;
    },
    hasSession(req) {
      const t = parseCookies(req.headers.cookie)[cookieName];
      if (!t) return false;
      const now = Date.now();
      for (const [k, s] of sessions) {
        const a = Buffer.from(k), b = Buffer.from(t);
        if (a.length === b.length && timingSafeEqual(a, b)) {
          if (!alive(s, now)) { sessions.delete(k); return false; }
          s.seen = now;
          return true;
        }
      }
      return false;
    },
    sessionCount() { const now = Date.now(); return [...sessions.values()].filter(s => alive(s, now)).length; },
    endAllSessions() { sessions = new Map(); },
  };
}

export function securityHeaders(res, port) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), microphone=(), payment=()");
  // Coin pictures load from their own https hosts (switch off under Settings → Privacy).
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self'",
    `connect-src 'self' ws://127.0.0.1:${port} ws://localhost:${port}`,
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; "));
}

export function createRateLimiter() {
  const buckets = new Map();
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();
  return (k, limit, windowMs) => {
    const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(k, b); }
    b.count++;
    return { ok: b.count <= limit, retryAfterSec: Math.ceil((b.reset - now) / 1000) };
  };
}
