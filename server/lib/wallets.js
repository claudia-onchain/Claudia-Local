/**
 * wallets.js — the extra wallets Claudia Local keeps in the vault, next to the Solana agent wallet.
 *
 *   wallets.evm        Robinhood Chain (beta) wallet: 0x private key, signs EVM transactions locally
 *   wallets.hot.sol    optional small hot wallet on Solana (base58 secret key)
 *   wallets.hot.hood   optional small hot wallet on Robinhood Chain (0x private key)
 *
 * They live in the vault's "wallets" group (encrypted with your passphrase like every other secret). 0.2
 * vaults simply don't have the group yet; it's created the first time you add one of these wallets.
 * Only addresses leave this file; secret keys are shown only through the export routes, after your passphrase.
 */
import { evmAddressOf, generateEvmWallet, generateWallet, normalizeEvmKey, publicKeyOf } from "@useclaudia/sdk";
import * as vault from "./vault.js";
import { trackActivity } from "./store.js";

const BUCKET = "wallets";
const err = (status, message, code) => Object.assign(new Error(message), { status, code });

const NAMES = { evm: "evm", "hot:sol": "hot.sol", "hot:hood": "hot.hood" };
const read = (name) => vault.getKey(NAMES[name], BUCKET);
const write = (name, value) => vault.setKeys({ [NAMES[name]]: value }, BUCKET);

// ── Robinhood Chain wallet ─────────────────────────────────────────────────
export const hasEvm = () => !!read("evm");
export const evmKey = () => { const k = read("evm"); if (!k) throw err(409, "There's no Robinhood Chain wallet yet. Create or import one under Claudia → Your agent.", "no_evm_wallet"); return k; };
export const evmAddress = () => { const k = read("evm"); return k ? evmAddressOf(k) : null; };

/** Creates a new EVM wallet, or imports `importKey` (0x + 64 hex). Refuses to replace one unless `force`. */
export function setEvm({ importKey, force = false } = {}) {
  if (hasEvm() && !force) throw err(409, "You already have a Robinhood Chain wallet. Replacing it loses access to whatever is in it unless you backed it up.");
  let key;
  if (importKey !== undefined) {
    try { key = normalizeEvmKey(String(importKey).trim()); } catch { throw err(400, "That isn't a valid EVM private key (0x followed by 64 hex characters)."); }
  } else key = generateEvmWallet().privateKey;
  write("evm", key);
  trackActivity("claudia", `${importKey !== undefined ? "Imported" : "Created"} a Robinhood Chain wallet ${evmAddressOf(key)}`);
  return { address: evmAddressOf(key) };
}

export function removeEvm() {
  write("evm", null);
  trackActivity("claudia", "Removed the Robinhood Chain wallet from this app");
}

// ── hot wallets (one per chain, optional) ──────────────────────────────────
export const hasHot = (chain) => !!read(`hot:${chain}`);
export function hotAddress(chain) {
  const k = read(`hot:${chain}`);
  if (!k) return null;
  return chain === "sol" ? publicKeyOf(k) : evmAddressOf(k);
}
export function hotKey(chain) {
  const k = read(`hot:${chain}`);
  if (!k) throw err(409, "There's no hot wallet on this chain yet.", "no_hot_wallet");
  return k;
}

export function createHot(chain, { force = false } = {}) {
  if (!["sol", "hood"].includes(chain)) throw err(400, "Hot wallets work on Solana and Robinhood Chain.");
  if (hasHot(chain) && !force) throw err(409, "You already have a hot wallet on this chain. Sweep it back before making a new one.");
  const key = chain === "sol" ? generateWallet().secretKey : generateEvmWallet().privateKey;
  write(`hot:${chain}`, key);
  trackActivity("claudia", `Created a hot wallet on ${chain === "sol" ? "Solana" : "Robinhood Chain"}: ${hotAddress(chain)}`);
  return { address: hotAddress(chain) };
}

export function removeHot(chain) {
  write(`hot:${chain}`, null);
  trackActivity("claudia", `Removed the ${chain === "sol" ? "Solana" : "Robinhood Chain"} hot wallet from this app`);
}

/** Secret keys for backup (the route checks the passphrase first). */
export function exportKey(which) {
  if (which === "evm") return { address: evmAddress(), secretKey: evmKey() };
  if (which === "hot:sol" || which === "hot:hood") { const chain = which.slice(4); return { address: hotAddress(chain), secretKey: hotKey(chain) }; }
  throw err(400, "Unknown wallet.");
}
