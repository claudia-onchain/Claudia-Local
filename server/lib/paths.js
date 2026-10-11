/**
 * paths.js — where Claudia Local keeps its data.
 *
 *   ~/.claudia-local/          0700  (override with CLAUDIA_LOCAL_HOME)
 *     vault.json               0600  secrets, AES-256-GCM, key from your passphrase (scrypt)
 *     config.json              0600  settings (no secrets)
 *     memory.json  chats.json  usage.json  activity.json  paper.json  spend.json  proposals.json
 *     workspace/               the only folder the agent's file tools can see
 *     brand.json               your brand kit (name, tone, topics, banned phrases, portraits, look, voice)
 *     brand/  uploads/         brand portraits and reference files you upload in the studio
 *     media/                   @useclaudia/media: jobs.json, library/YYYY-MM/ (generated files)
 *     social/                  @useclaudia/social: accounts, posts, audit.jsonl
 *     media-requests.json      media the agent, MCP or a campaign asked for, waiting for you
 *     campaigns.json           campaign plans
 *     studio-log.jsonl         action log for the studio (export from Settings → Safety)
 *     claudia.db               SQLite (node:sqlite): chats and the memory search index
 *     memory/                  MEMORY.md (facts), USER.md (about you), YYYY-MM-DD.md daily notes,
 *                              quarantine.json (memory proposed from outside content, waiting for you)
 *     skills/<slug>/           installed Agent Skills (SKILL.md + files); skills.json holds the pins
 *     key-meta.json            when each key was last used and tested (no secrets)
 *     model-spend.json         estimated chat model spend per month and provider
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";

export const HOME = resolve(process.env.CLAUDIA_LOCAL_HOME?.trim() || join(homedir(), ".claudia-local"));

export const P = {
  home: HOME,
  vault: join(HOME, "vault.json"),
  config: join(HOME, "config.json"),
  memory: join(HOME, "memory.json"),
  chats: join(HOME, "chats.json"),
  usage: join(HOME, "usage.json"),
  activity: join(HOME, "activity.json"),
  paper: join(HOME, "paper.json"),
  spend: join(HOME, "spend.json"),
  proposals: join(HOME, "proposals.json"),
  workspace: join(HOME, "workspace"),
  log: join(HOME, "server.log"),
  brand: join(HOME, "brand.json"),
  brandDir: join(HOME, "brand"),
  uploads: join(HOME, "uploads"),
  media: join(HOME, "media"),
  social: join(HOME, "social"),
  requests: join(HOME, "media-requests.json"),
  campaigns: join(HOME, "campaigns.json"),
  studioLog: join(HOME, "studio-log.jsonl"),
  db: join(HOME, "claudia.db"),
  memoryDir: join(HOME, "memory"),
  skillsDir: join(HOME, "skills"),
  skills: join(HOME, "skills.json"),
  keyMeta: join(HOME, "key-meta.json"),
  modelSpend: join(HOME, "model-spend.json"),
};

export function ensurePrivateDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch { /* not ours to fix (e.g. Windows) */ }
}

/** A path for showing: "~/…" on macOS and Linux; the full path on Windows, where "~" doesn't work in a shell. */
export function tilde(p) {
  const h = homedir();
  return process.platform !== "win32" && h && (p === h || p.startsWith(h + "/")) ? "~" + p.slice(h.length) : p;
}

/**
 * renameSync that replaces the target. On Windows a virus scanner or the search indexer can hold a file for a
 * moment (EPERM / EBUSY / EACCES), so it retries briefly there before giving up.
 */
export function replaceFile(from, to) {
  for (let i = 0; ; i++) {
    try { return renameSync(from, to); } catch (e) {
      if (process.platform !== "win32" || i >= 8 || !["EPERM", "EBUSY", "EACCES"].includes(e.code)) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25 * (i + 1));
    }
  }
}

export function ensureHome() {
  ensurePrivateDir(HOME);
  ensurePrivateDir(P.workspace);
}
