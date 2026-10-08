/**
 * studio-media.js — the only file that talks to @useclaudia/media.
 *
 * The package does the real work (provider connectors, cost estimates, spending caps, the job queue,
 * downloads into <data>/media/library/YYYY-MM/). This adapter:
 *   - loads the package on first use with a dynamic import, so Claudia Local still starts (and the
 *     dashboard shows "not installed") when it's missing,
 *   - hands it a KeyProvider backed by the encrypted vault (providers.js → createKeyProvider),
 *   - passes your spending caps from Settings, and recreates the instance when they change,
 *   - forwards job events to the dashboard.
 *
 * Swapping the media layer: point CLAUDIA_LOCAL_MEDIA_PKG at another module (a package name or a path
 * to an .js file) that exports createMedia() with the same API (see CONTRACTS in the package README).
 */
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { HOME } from "./paths.js";
import { getConfig } from "./store.js";
import { createKeyProvider } from "./providers.js";

const PKG = "@useclaudia/media";
const SPEC = process.env.CLAUDIA_LOCAL_MEDIA_PKG?.trim() || PKG;

let mod = null;
let loadError = null;
let loading = null;
let inst = null;
const listeners = new Set();

const toSpecifier = (s) => (isAbsolute(s) || s.startsWith(".") ? pathToFileURL(s).href : s);

async function load() {
  if (mod || loadError) return mod;
  loading ||= import(toSpecifier(SPEC)).then((m) => { mod = m; }, (e) => { loadError = e; });
  await loading;
  return mod;
}

export class NotInstalled extends Error {
  constructor() {
    super(`The media studio needs ${PKG}. Install it with: npm install ${PKG}`);
    this.status = 503; this.code = "not_installed";
  }
}

/** { installed, package, version?, error? } — what the dashboard shows. */
export async function status() {
  await load();
  if (mod) return { installed: true, package: PKG, version: mod.VERSION || mod.version || null };
  const missing = loadError?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(String(loadError?.message));
  return { installed: false, package: PKG, install: `npm install ${PKG}`, error: missing ? "Not installed." : `Couldn't load it: ${loadError?.message}` };
}

/** Limits from Settings, in the package's SpendLimits shape. 0 means "no cap" for the caps, "always ask" is not a thing. */
function limits() {
  const L = getConfig().studio.limits;
  const cap = (v) => (Number(v) > 0 ? Number(v) : undefined);
  return { perJobUsd: cap(L.perJobUsd), perDayUsd: cap(L.perDayUsd), perMonthUsd: cap(L.perMonthUsd), approveAboveUsd: Number(L.approveAboveUsd) >= 0 ? Number(L.approveAboveUsd) : undefined };
}

/** The Media instance. Throws NotInstalled when the package is missing. */
export async function media() {
  await load();
  if (!mod) throw new NotInstalled();
  if (!inst) {
    inst = await mod.createMedia({
      keys: createKeyProvider(),
      dataDir: HOME,               // → ~/.claudia-local/media (jobs.json, library/)
      limits: limits(),
      // concurrency: { fal: 2, google: 1 },   // per provider, if you want to change the package default
    });
    inst.on?.("job", (j) => { for (const f of listeners) { try { f(j); } catch { /* */ } } });
  }
  return inst;
}

/** Recreate the instance (after the caps change). Jobs persist in jobs.json and resume. */
export async function reconfigure() {
  const old = inst;
  inst = null;
  if (old) await old.close?.().catch(() => {});
  if (mod) await media();
}

export function onJob(cb) { listeners.add(cb); return () => listeners.delete(cb); }

export const isDryRun = (x) => !!(x && x.dryRun === true);

export async function close() { if (inst) { const i = inst; inst = null; await i.close?.().catch(() => {}); } }
