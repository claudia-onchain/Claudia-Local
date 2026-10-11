/**
 * policy.js — the money rules. They live here, in server code, where the model can't change them.
 *
 *  - Caps per chain, in that chain's own coin (SOL on Solana, ETH on Robinhood Chain). Buys count what they
 *    spend; sells count what the quote says they bring back, against the same per-trade cap and their own
 *    daily allowance. Launches count their total cost.
 *  - A prepared trade may not spend more than 5% over the amount you typed.
 *  - Token amounts are checked in base units against the token's decimals (read from the chain, or the SDK
 *    for $CLAUDIA). If the human amount and the raw amount disagree, the trade is refused. (A bot once sent
 *    52M tokens instead of about 4 SOL worth because of a decimals slip.)
 *  - Previews expire after 60 s and can be confirmed once, only from the dashboard, by a person.
 *  - Anything that came from outside content (see untrusted.js) needs the person's confirm.
 */
import { CHAINS } from "@useclaudia/sdk";
import { P } from "./paths.js";
import { getConfig, readJsonFile, writeJsonFile, newId } from "./store.js";
import { mayAct } from "./untrusted.js";

export const PREVIEW_TTL_MS = 60_000;
export const MAX_OVERSPEND = 0.05;     // 5% over the typed amount
export const DECIMALS_TOLERANCE = 0.02; // human vs raw amounts may differ by rounding, not by a power of ten

const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;

/** "SOL" on Solana, "ETH" on Robinhood Chain: amounts always show in the chain's own coin. */
export const unitOf = (chain) => CHAINS[chain]?.nativeSymbol || "SOL";

// ── caps ───────────────────────────────────────────────────────────────────
export function capsFor(chain = "sol") {
  const c = getConfig().claudia.caps;
  if (chain === "sol") return { perTrade: c.maxSolPerTrade, perDay: c.maxSolPerDay, unit: "SOL" };
  if (chain === "hood") return { perTrade: c.maxEthPerTrade, perDay: c.maxEthPerDay, unit: "ETH" };
  throw err(400, `${CHAINS[chain]?.name || chain} is coming soon.`, "chain_coming_soon");
}

// spend.json: { days: { "YYYY-MM-DD": { sol, hood, sold_sol, sold_hood, entries } } }. "sol" is the 0.2 field.
const today = () => new Date().toISOString().slice(0, 10);
const field = (chain, kind) => (kind === "sell" ? `sold_${chain}` : chain);

export function spentToday(chain = "sol", kind = "buy") {
  const f = readJsonFile(P.spend, { days: {} });
  return Number(f.days?.[today()]?.[field(chain, kind)] || 0);
}

export function capsLeft(chain = "sol") {
  const caps = capsFor(chain);
  return {
    ...caps,
    spentToday: round(spentToday(chain, "buy")), soldToday: round(spentToday(chain, "sell")),
    leftToday: round(Math.max(0, caps.perDay - spentToday(chain, "buy"))), sellLeftToday: round(Math.max(0, caps.perDay - spentToday(chain, "sell"))),
  };
}

/** Records a buy / launch (`native` spent) or a sell (`native` received) once it was sent. */
export function recordSpend(chain, kind, entry) {
  const f = readJsonFile(P.spend, { days: {} });
  const d = today();
  const day = f.days[d] || { sol: 0, entries: [] };
  const k = field(chain, kind);
  day[k] = round(Number(day[k] || 0) + Math.max(0, Number(entry.native) || 0), 9);
  day.entries = [...(day.entries || []), { at: new Date().toISOString(), chain, kind, ...entry }];
  f.days[d] = day;
  for (const x of Object.keys(f.days).sort().slice(0, -30)) delete f.days[x];
  writeJsonFile(P.spend, f);
}

/**
 * Throws unless `amount` (in the chain's coin) fits the per-trade cap and what's left today.
 * kind "buy" and "launch" share the spend allowance; "sell" has its own, counted by value.
 */
export function checkCaps(chain, amount, kind = "buy") {
  const caps = capsFor(chain);
  const u = caps.unit;
  if (!Number.isFinite(amount) || amount < 0) throw err(400, `The amount must be a positive number of ${u}.`);
  const what = kind === "sell" ? "This sale is worth about" : "";
  if (kind !== "launch" && amount > caps.perTrade + 1e-12) {
    throw err(403, `${what ? `${what} ${round(amount)} ${u}, which is` : `${round(amount)} ${u} is`} over your per-trade cap of ${caps.perTrade} ${u}. Change it under Claudia → Your agent → Limits.`, "cap_exceeded");
  }
  const left = Math.max(0, caps.perDay - spentToday(chain, kind === "sell" ? "sell" : "buy"));
  if (amount > left + 1e-12) {
    throw err(403, `${what ? `${what} ${round(amount)} ${u}; that` : `${round(amount)} ${u}`} would go over your daily ${kind === "sell" ? "sell " : ""}cap of ${caps.perDay} ${u} (${round(left)} ${u} left today).`, "cap_exceeded");
  }
  return { left: round(left) };
}

/** A prepared trade may spend at most 5% more than what you typed. */
export function checkSpend(chain, typed, actual, what = "This trade") {
  const u = unitOf(chain);
  if (!(typed > 0) || !Number.isFinite(actual)) return;
  if (actual > typed * (1 + MAX_OVERSPEND) + 1e-12) {
    throw err(409, `${what} would spend ${round(actual)} ${u}, more than 5% over the ${round(typed)} ${u} you typed. Nothing was signed.`, "overspend");
  }
}

/**
 * Compares a human amount with raw base units using the token's decimals. Refuses when they disagree by more
 * than rounding (a decimals slip is off by a power of ten, not by a percent).
 */
export function checkDecimals({ what, ui, raw, decimals, symbol = "" }) {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw err(409, `Couldn't read the decimals of ${symbol ? "$" + symbol : "this token"}, so the amount can't be checked. Nothing was signed.`, "decimals_unknown");
  const fromRaw = Number(BigInt(raw)) / 10 ** decimals;
  const want = Number(ui);
  if (!Number.isFinite(want)) return { fromRaw };
  const scale = Math.max(Math.abs(want), Math.abs(fromRaw));
  if (scale === 0) return { fromRaw };
  if (Math.abs(fromRaw - want) / scale > DECIMALS_TOLERANCE) {
    throw err(409, `${what}: ${fmt(want)} tokens expected, but the raw amount is ${String(raw)} base units = ${fmt(fromRaw)} tokens at ${decimals} decimals. They don't match, so nothing was signed.`, "decimals_mismatch");
  }
  return { fromRaw };
}

/** A token amount from a simulation must be in the same range as the quote (refuses a decimals slip). */
export function checkTokenAmount({ what, expected, actual, maxRatio = 1 + MAX_OVERSPEND, minRatio = 0.5, symbol = "" }) {
  if (!(expected > 0) || !Number.isFinite(actual)) return;
  const r = actual / expected;
  if (r > maxRatio || r < minRatio) {
    throw err(409, `${what}: the transaction moves ${fmt(actual)} ${symbol ? "$" + symbol : "tokens"}, but the quote says about ${fmt(expected)}. That doesn't match, so nothing was signed.`, "amount_mismatch");
  }
}

const fmt = (n) => (Math.abs(n) >= 1000 ? Math.round(n).toLocaleString("en-US") : String(round(n)));

/** The person must confirm anything that came from outside content. */
export const needsConfirm = (source) => !mayAct(source || "user");

// ── previews: made by a dry run, confirmed once by a person ────────────────
const previews = new Map(); // id -> { kind, chain, data, summary, expires }
setInterval(() => { const now = Date.now(); for (const [k, v] of previews) if (v.expires < now) previews.delete(k); }, 30_000).unref();

export function savePreview(kind, chain, payload) {
  const id = newId("pv_");
  const expires = Date.now() + PREVIEW_TTL_MS;
  previews.set(id, { kind, chain, ...payload, expires });
  return { id, expiresAt: expires };
}

/** Takes a preview out (single use). `confirm` must be literally true: the dashboard sends it, a model can't. */
export function takePreview(id, kind, confirm) {
  if (confirm !== true) throw err(400, "Not confirmed.");
  if (!getConfig().claudia.liveTrading) throw err(403, "Live trading is off. Switch it on under Claudia → Your agent → Limits first.", "live_off");
  const p = previews.get(String(id || ""));
  if (!p || p.kind !== kind || p.expires < Date.now()) { previews.delete(String(id || "")); throw err(410, "This preview expired. Run the dry run again.", "preview_expired"); }
  previews.delete(String(id));
  return p;
}
