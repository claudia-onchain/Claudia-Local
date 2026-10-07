/**
 * paths.js — where Claudia Local keeps its data.
 *
 *   ~/.claudia-local/          0700  (override with CLAUDIA_LOCAL_HOME)
 *     vault.json               0600  secrets, AES-256-GCM, key from your passphrase (scrypt)
 *     config.json              0600  settings (no secrets)
 *     memory.json  chats.json  usage.json  activity.json  paper.json  spend.json  proposals.json
 *     workspace/               the only folder the agent's file tools can see
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";

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
};

export function ensurePrivateDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    if ((statSync(dir).mode & 0o077) !== 0) chmodSync(dir, 0o700);
  } catch { /* not ours to fix (e.g. Windows) */ }
}

export function ensureHome() {
  ensurePrivateDir(HOME);
  ensurePrivateDir(P.workspace);
}
