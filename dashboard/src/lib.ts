// Shared client helpers: the JSON API, formatting, and the app-wide event bus.

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export const bus = new EventTarget();

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method || (opts.body !== undefined ? "POST" : "GET"),
    headers: opts.body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: "same-origin",
  });
  let data: any = null;
  try { data = await res.json(); } catch { /* not json */ }
  if (!res.ok) {
    if (res.status === 401 && data?.locked) bus.dispatchEvent(new Event("locked"));
    throw new ApiError(res.status, data?.error || `Request failed (${res.status})`, data?.code);
  }
  return data as T;
}

export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function usd(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const a = Math.abs(n);
  if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (a >= 1e4) return `$${(n / 1e3).toFixed(1)}k`;
  if (a >= 1) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (a === 0) return "$0";
  return `$${n.toPrecision(3)}`;
}
export function pct(n: number | null | undefined, sign = false) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const v = Math.round(n * 10) / 10;
  return `${sign && v > 0 ? "+" : ""}${v}%`;
}
export function sol(n: number | null | undefined, digits = 4) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  return `${Number(n.toFixed(digits)).toLocaleString("en-US", { maximumFractionDigits: digits })} SOL`;
}
export function num(n: number | null | undefined) {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (Math.abs(n) >= 1e4) return `${(n / 1e3).toFixed(1)}k`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}
export function ago(t: string | number | null | undefined) {
  if (!t) return "";
  const ms = Date.now() - (typeof t === "number" ? t : Date.parse(t));
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86400)} d ago`;
}
export const short = (s: string | null | undefined, n = 4) => (!s ? "" : s.length <= n * 2 + 1 ? s : `${s.slice(0, n)}…${s.slice(-n)}`);
export const signClass = (n: number | null | undefined) => (n === null || n === undefined || !Number.isFinite(n) || n === 0 ? "" : n > 0 ? "buy" : "sell");

/** Only plain https images (coin pictures); relative paths are resolved against the Claudia server. */
export function imageUrl(src: string | null | undefined, base?: string) {
  if (!src) return null;
  if (src.startsWith("/claudia/")) return src; // bundled locally
  if (src.startsWith("/") && base) return base.replace(/\/+$/, "") + src;
  if (/^ipfs:\/\//i.test(src)) return `https://ipfs.io/ipfs/${src.slice(7)}`;
  return /^https:\/\//i.test(src) || (base?.startsWith("http://") && src.startsWith(base)) ? src : null;
}

export function copy(text: string) {
  navigator.clipboard?.writeText(text).catch(() => {});
}
