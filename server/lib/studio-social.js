/**
 * studio-social.js — the only file that talks to @useclaudia/social.
 *
 * The package does the real work (network connectors, OAuth, previews with labels, caps, duplicate
 * checks, the kill switch, scheduled posts, audit log in <data>/social/audit.jsonl). This adapter:
 *   - loads the package on first use with a dynamic import ("not installed" state when missing),
 *   - hands it a KeyProvider backed by the encrypted vault,
 *   - tells it where OAuth comes back: http://127.0.0.1:<port>/oauth/callback directly, or through
 *     https://useclaudia.xyz/relay/oauth/callback for networks that refuse loopback redirect URIs,
 *   - gives it the short-lived media relay (https://useclaudia.xyz/relay/media) for networks that pull
 *     media from a public URL, authenticated with your Claudia agent key when you connected one,
 *   - forwards post and account events to the dashboard.
 *
 * Swapping the social layer: point CLAUDIA_LOCAL_SOCIAL_PKG at another module exporting createSocial().
 */
import { pathToFileURL } from "node:url";
import { isAbsolute } from "node:path";
import { HOME } from "./paths.js";
import { getConfig } from "./store.js";
import { createKeyProvider } from "./providers.js";
import * as vault from "./vault.js";

const PKG = "@useclaudia/social";
const SPEC = process.env.CLAUDIA_LOCAL_SOCIAL_PKG?.trim() || PKG;

let mod = null;
let loadError = null;
let loading = null;
let inst = null;
let port = 3939;
const listeners = { post: new Set(), account: new Set(), warning: new Set() };

const toSpecifier = (s) => (isAbsolute(s) || s.startsWith(".") ? pathToFileURL(s).href : s);

async function load() {
  if (mod || loadError) return mod;
  loading ||= import(toSpecifier(SPEC)).then((m) => { mod = m; }, (e) => { loadError = e; });
  await loading;
  return mod;
}

export class NotInstalled extends Error {
  constructor() {
    super(`Socials need ${PKG}. Install it with: npm install ${PKG}`);
    this.status = 503; this.code = "not_installed";
  }
}

export function setPort(p) { port = p; }

/** The site that hosts the relays (https://useclaudia.xyz unless you changed the Claudia address). */
export function relayBase() {
  const b = process.env.CLAUDIA_BASE_URL?.trim() || getConfig().claudia.baseUrl || "https://useclaudia.xyz";
  return b.replace(/\/+$/, "");
}
export const loopbackRedirect = () => `http://127.0.0.1:${port}/oauth/callback`;
export const relayRedirect = () => `${relayBase()}/relay/oauth/callback`;

export async function status() {
  await load();
  if (mod) return { installed: true, package: PKG, version: mod.VERSION || mod.version || null };
  const missing = loadError?.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (module|package)/.test(String(loadError?.message));
  return { installed: false, package: PKG, install: `npm install ${PKG}`, error: missing ? "Not installed." : `Couldn't load it: ${loadError?.message}` };
}

/** The Social instance. Throws NotInstalled when the package is missing. */
export async function social() {
  await load();
  if (!mod) throw new NotInstalled();
  if (!creating) creating = create().then((i) => (inst = i), (e) => { creating = null; throw e; });
  return creating;
}

let creating = null; // Promise<Social>, so parallel first calls share one instance
async function create() {
  {
    const inst = await mod.createSocial({
      keys: createKeyProvider(),
      dataDir: HOME,                       // → ~/.claudia-local/social
      loopbackPort: port,
      relayUrl: relayRedirect(),
      // Your Claudia agent key + device-key signature (the site's X-Claudia-* scheme), only when connected.
      mediaRelay: {
        url: `${relayBase()}/relay/media`,
        token: async () => (vault.isUnlocked() ? vault.get("claudiaApiKey") || null : null),
        sign: async ({ method, path, body }) => {
          if (!vault.isUnlocked() || !vault.has("deviceKey")) return {};
          const { createSigner, signRequest } = await import("@useclaudia/sdk");
          const h = await signRequest(await createSigner(vault.get("deviceKey")), method, path, body);
          return { "X-Claudia-Timestamp": h["X-Claudia-Timestamp"], "X-Claudia-Nonce": h["X-Claudia-Nonce"], "X-Claudia-Signature": h["X-Claudia-Signature"] };
        },
      },
    });
    await inst.ready?.();
    inst.killSwitch?.(!!getConfig().studio.killSwitch.posting);
    inst.on?.("post", (p) => { for (const f of listeners.post) { try { f(p); } catch { /* */ } } });
    inst.on?.("account", (a) => { for (const f of listeners.account) { try { f(a); } catch { /* */ } } });
    inst.on?.("warning", (w) => { for (const f of listeners.warning) { try { f(w); } catch { /* */ } } });
    return inst;
  }
}

/** The instance if it's already loaded (for the 30 s tick), or null. */
export const loaded = () => inst;

export function on(ev, cb) { listeners[ev]?.add(cb); return () => listeners[ev]?.delete(cb); }

export const isDryRun = (x) => !!(x && x.dryRun === true);

export async function close() { if (inst) { const i = inst; inst = null; creating = null; await i.close?.().catch(() => {}); } }
