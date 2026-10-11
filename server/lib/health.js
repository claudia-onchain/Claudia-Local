/**
 * health.js — the checks behind the Health page and `claudia-local doctor`.
 *
 * Each check is { id, label, status: "ok" | "warn" | "bad" | "info", detail, fix? }. A `fix` is offered
 * only where it's safe to apply with one click (it always makes things stricter: lock sooner, turn live
 * trading off, ask before posting, lower caps). The server passes what it knows at runtime (where it
 * listens, whether the vault is unlocked); the CLI passes what it can find out from outside.
 */
import { existsSync } from "node:fs";
import { getConfig, updateConfig } from "./store.js";
import * as vault from "./vault.js";
import * as D from "./db.js";
import * as skills from "./skills.js";
import { PROVIDERS, keyMeta, publicProvider } from "./providers.js";
import { servers as mcpServers } from "./mcp-client.js";
import { P } from "./paths.js";

const RELEASES = "https://api.github.com/repos/claudia-onchain/Claudia-Local/releases/latest";
const DAY = 86_400_000;
const SAFE_CAPS = { maxSolPerTrade: 0.05, maxSolPerDay: 0.2, maxEthPerTrade: 0.01, maxEthPerDay: 0.04 };

export const FIXES = {
  "auto-lock": { label: "Lock after 30 idle minutes", patch: { autoLockMinutes: 30 } },
  "live-off": { label: "Turn live trading off", patch: { claudia: { liveTrading: false } } },
  "ask-post": { label: "Ask before every post", patch: { askBeforePost: true } },
  "caps": { label: "Lower caps to the defaults", patch: { claudia: { caps: SAFE_CAPS } } },
  "ask-media": { label: "Ask before the agent makes media", patch: { studio: { askBeforeAgentMedia: true } } },
  "mcp-off": { label: "Turn the local MCP server off", patch: { studio: { mcp: { enabled: false } } } },
};

/** Applies a one-click fix. Returns the patch that was applied. */
export function applyFix(id) {
  const f = FIXES[id];
  if (!f) throw Object.assign(new Error("Unknown fix."), { status: 404 });
  updateConfig(f.patch);
  return f;
}

const cmp = (a, b) => {
  const x = String(a).replace(/^v/, "").split(/[.-]/).map(Number), y = String(b).replace(/^v/, "").split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); }
  return 0;
};

let releaseCache = null;
/** The latest GitHub release tag, or null (no release yet, offline, rate limited: all quiet). */
export async function latestRelease() {
  if (releaseCache && Date.now() - releaseCache.ts < 6 * 3600_000) return releaseCache.v;
  let v = null;
  try {
    const r = await fetch(RELEASES, { headers: { accept: "application/vnd.github+json", "user-agent": "claudia-local" }, signal: AbortSignal.timeout(6000), redirect: "follow" });
    if (r.ok) { const j = await r.json(); v = j.tag_name ? { tag: String(j.tag_name), url: String(j.html_url || "") } : null; }
  } catch { v = null; }
  releaseCache = { ts: Date.now(), v };
  return v;
}

/**
 * Runs every check.
 *   ctx.boundHost   the address the server listens on (server), or ctx.exposed: [addresses that answered] (CLI)
 *   ctx.version     this app's version
 *   ctx.online      false skips the release check
 */
export async function runChecks(ctx = {}) {
  const cfg = getConfig();
  const out = [];
  const add = (id, label, status, detail, fix) => out.push({ id, label, status, detail, ...(fix ? { fix: { id: fix, label: FIXES[fix].label } } : {}) });

  // Network
  // In the Docker image (CLAUDIA_LOCAL_DOCKER=1) the server has to listen beyond loopback inside the container;
  // what keeps it private there is publishing the port on the host's 127.0.0.1 only (compose.yaml does).
  const docker = process.env.CLAUDIA_LOCAL_DOCKER === "1";
  const DOCKER_NOTE = "That's expected inside the Docker container. Publish it on 127.0.0.1 only (\"127.0.0.1:3939:3939\", as compose.yaml does), never on 0.0.0.0 or a public address.";
  if (ctx.boundHost !== undefined) {
    const loop = ctx.boundHost === "127.0.0.1" || ctx.boundHost === "::1";
    add("bound", "Only this computer can reach it", loop ? "ok" : docker ? "warn" : "bad", loop ? "Listening on 127.0.0.1 only." : docker ? `Listening on ${ctx.boundHost}, beyond loopback. ${DOCKER_NOTE}` : `Listening on ${ctx.boundHost}. It should be 127.0.0.1.`);
  } else if (ctx.exposed) add("bound", "Only this computer can reach it", ctx.exposed.length ? (docker ? "warn" : "bad") : ctx.running ? "ok" : "info", ctx.exposed.length ? `It answered on ${ctx.exposed.join(", ")}.${docker ? " " + DOCKER_NOTE : ""}` : ctx.running ? "It answers on 127.0.0.1 and not on your network addresses." : "The app isn't running, so this wasn't checked.");

  // Node
  const [maj, min] = process.versions.node.split(".").map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 13);
  add("node", "Node.js version", nodeOk ? "ok" : "bad", `Node ${process.versions.node}${nodeOk ? "" : ". Claudia Local needs 22.13 or newer."}${D.db ? "" : ` SQLite isn't available (${D.error || "unknown"}), so chats use JSON files and memory search is simpler.`}`);

  // Vault and lock
  if (!existsSync(P.vault)) add("vault", "Vault", "info", "Not set up yet.");
  else {
    const unlocked = ctx.unlocked === undefined ? vault.isUnlocked() : ctx.unlocked;
    add("vault", "Vault", "ok", `Encrypted with your passphrase (scrypt + AES-256-GCM).${unlocked === null ? "" : unlocked ? " Unlocked now." : " Locked now."}`);
  }
  const lock = cfg.autoLockMinutes;
  add("auto-lock", "Auto-lock", lock === 0 ? "warn" : lock > 240 ? "warn" : "ok", lock === 0 ? "It stays unlocked until you lock it or quit." : `Locks after ${lock} idle minutes.`, lock === 0 || lock > 240 ? "auto-lock" : undefined);

  // MCP exposure
  const m = cfg.studio.mcp;
  if (!m.enabled) add("mcp-server", "Local MCP server", "ok", "Off. No other app can use your studio.");
  else if (!m.tokenHash) add("mcp-server", "Local MCP server", "bad", `On (port ${m.port}) but there's no token, so no app can use it. Turn it off or make a token.`, "mcp-off");
  else add("mcp-server", "Local MCP server", "info", `On at 127.0.0.1:${m.port} while the app is unlocked. Apps with your token can make media and draft posts; publishing still needs you.`);
  const stdio = mcpServers(cfg).filter(s => s.kind === "stdio");
  if (stdio.length) add("mcp-stdio", "Programs started for MCP", stdio.some(s => s.enabled) ? "warn" : "info", `${stdio.length} MCP server${stdio.length > 1 ? "s" : ""} run${stdio.length > 1 ? "" : "s"} a program on this computer: ${stdio.map(s => `${s.name} (${s.command}${s.enabled ? ", on" : ", off"})`).join("; ")}.`);

  // Keys tested
  const meta = keyMeta();
  if (vault.isUnlocked()) {
    const set = PROVIDERS.filter(p => p.check && !p.readonly).map(publicProvider).filter(p => p.configured);
    const stale = set.filter(p => !p.lastTested || Date.now() - p.lastTested > 30 * DAY);
    const failing = set.filter(p => p.testOk === false);
    if (!set.length) add("keys", "Keys", "info", "No keys with a test yet.");
    else if (failing.length) add("keys", "Keys", "bad", `The last test failed for ${failing.map(p => p.name).join(", ")}.`);
    else add("keys", "Keys", stale.length ? "warn" : "ok", stale.length ? `Not tested in the last 30 days: ${stale.map(p => p.name).join(", ")}. Test them under Settings → Keys.` : `All ${set.length} tested in the last 30 days.`);
  } else {
    const tested = Object.entries(meta).filter(([, v]) => v.lastTested);
    add("keys", "Keys", "info", tested.length ? `Last tests: ${tested.map(([k, v]) => `${k} ${new Date(v.lastTested).toISOString().slice(0, 10)}${v.testOk === false ? " (failed)" : ""}`).join(", ")}.` : "No key tests recorded.");
  }

  // Skills
  const sk = skills.list({ check: true });
  const changed = sk.filter(s => s.changed);
  add("skills", "Installed skills", changed.length ? "bad" : "ok", !sk.length ? "None installed." : changed.length ? `Changed on disk since install: ${changed.map(s => s.slug).join(", ")}. Review them on the Skills page; the agent won't load them until then.` : `${sk.length} installed, all match their pins.`);

  // Dangerous settings
  const c = cfg.claudia;
  add("live", "Live trading", c.liveTrading ? "warn" : "ok", c.liveTrading ? "On. Real trades still need your confirmation each time." : "Off.", c.liveTrading ? "live-off" : undefined);
  add("ask-post", "Ask before posting", cfg.askBeforePost ? "ok" : "warn", cfg.askBeforePost ? "The agent asks before every Claudia post." : "Off: the agent can post on Claudia on its own.", cfg.askBeforePost ? undefined : "ask-post");
  const eth = c.caps.maxEthPerTrade !== undefined;
  const high = c.caps.maxSolPerTrade > 0.5 || c.caps.maxSolPerDay > 2 || (eth && (c.caps.maxEthPerTrade > 0.1 || c.caps.maxEthPerDay > 0.4));
  add("caps", "Wallet caps", high ? "warn" : "ok", `Solana: ${c.caps.maxSolPerTrade} SOL per trade, ${c.caps.maxSolPerDay} SOL per day.${eth ? ` Robinhood Chain: ${c.caps.maxEthPerTrade} ETH per trade, ${c.caps.maxEthPerDay} ETH per day.` : ""}${high ? " That's high for an agent wallet." : ""}`, high ? "caps" : undefined);
  add("ask-media", "Ask before agent media", cfg.studio.askBeforeAgentMedia ? "ok" : "warn", cfg.studio.askBeforeAgentMedia ? "Media from the agent waits for your approval." : "Off: the agent can spend on media up to your caps.", cfg.studio.askBeforeAgentMedia ? undefined : "ask-media");

  // Version
  if (ctx.online !== false && ctx.version) {
    const rel = await latestRelease();
    if (rel) {
      const newer = cmp(rel.tag, ctx.version) > 0;
      add("version", "Version", newer ? "warn" : "ok", newer ? `You have ${ctx.version}; ${rel.tag} is out.${rel.url ? " " + rel.url : ""}` : `${ctx.version} is the latest release.`);
    } else add("version", "Version", "info", `You have ${ctx.version}. No published release to compare with.`);
  }
  const rank = { bad: 0, warn: 1, info: 2, ok: 3 };
  return { checks: out, summary: { bad: out.filter(x => x.status === "bad").length, warn: out.filter(x => x.status === "warn").length, worst: out.reduce((w, x) => (rank[x.status] < rank[w] ? x.status : w), "ok") } };
}
