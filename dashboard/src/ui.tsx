// Small UI pieces shared by the pages.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { imageUrl } from "./lib";

export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
      <span className="track" />
      {label && <span>{label}</span>}
    </label>
  );
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <div className="hint">{hint}</div>}
    </div>
  );
}

export function PageHead({ title, sub, children }: { title: ReactNode; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="grow">
        <h1>{title}</h1>
        {sub && <p>{sub}</p>}
      </div>
      {children}
    </div>
  );
}

export function Modal({ title, onClose, children, wide }: { title: ReactNode; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onClose]);
  return (
    <div className="scrim" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" style={wide ? { maxWidth: 640 } : undefined}>
        <div className="row" style={{ marginBottom: 14 }}>
          <h2 className="grow" style={{ fontSize: 17 }}>{title}</h2>
          <button className="btn ghost sm" onClick={onClose} aria-label="Close">Close</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Coin picture, or the ticker's first letters when pictures are off or missing. */
export function CoinImg({ src, symbol, base, show = true, lg }: { src?: string | null; symbol?: string; base?: string; show?: boolean; lg?: boolean }) {
  const [broken, setBroken] = useState(false);
  const url = show && !broken ? imageUrl(src, base) : null;
  if (!url) return <span className={`coin-img${lg ? " lg" : ""}`} aria-hidden>{(symbol || "?").replace(/^\$/, "").slice(0, 2).toUpperCase()}</span>;
  return <img className={`coin-img${lg ? " lg" : ""}`} src={url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} />;
}

export function Face({ size = 32, src }: { size?: number; src?: string | null }) {
  return <img className="face" src={src || (size > 64 ? "/claudia/avatar-256.webp" : "/claudia/avatar-96.webp")} width={size} height={size} alt="" />;
}

export function Copyable({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <span className="row gap-4" style={{ display: "inline-flex", minWidth: 0 }}>
      <span className="mono small break">{label ?? text}</span>
      <button className="linkbtn small nowrap" onClick={() => { navigator.clipboard?.writeText(text).catch(() => {}); setDone(true); setTimeout(() => setDone(false), 1200); }}>{done ? "Copied" : "Copy"}</button>
    </span>
  );
}

// ── toasts ─────────────────────────────────────────────────────────────────
type Toast = { id: number; text: string; tone?: "ok" | "bad" };
const ToastCtx = createContext<(text: string, tone?: "ok" | "bad") => void>(() => {});
export const useToast = () => useContext(ToastCtx);
export function ToastProvider({ children }: { children: ReactNode }) {
  const [list, setList] = useState<Toast[]>([]);
  const push = useCallback((text: string, tone?: "ok" | "bad") => {
    const id = Date.now() + Math.random();
    setList(l => [...l.slice(-3), { id, text, tone }]);
    setTimeout(() => setList(l => l.filter(t => t.id !== id)), tone === "bad" ? 6000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toast-wrap" role="status" aria-live="polite">
        {list.map(t => <div key={t.id} className={`toast ${t.tone || ""}`}>{t.text}</div>)}
      </div>
    </ToastCtx.Provider>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const run = useCallback(() => {
    setLoading(true);
    return fn().then(d => { setData(d); setError(null); }).catch(e => setError(e?.message || String(e))).finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { data, error, loading, reload: run, setData };
}
