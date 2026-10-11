/**
 * evm.js — Robinhood Chain (beta) through @useclaudia/sdk/evm (ClaudiaEvm), with your own key.
 *
 * Claudia builds unsigned transactions on its public routes (trade prepare, launch plan); this file checks
 * them (chain, recipients, the ETH they move, token amounts in base units against the token's decimals),
 * simulates the batch in order, and keeps the preview for 60 s. Only a person confirming in the dashboard,
 * with live trading on and inside the ETH caps, makes it sign and send. Amounts are always in ETH.
 * Only coins launched on Claudia can be traded. BNB Chain is coming soon and refused.
 */
import { CHAINS, ROBINHOOD_LAUNCHPADS, chainExplorerUrl, isEvmAddress, toTokenKey, chainOfKey, normalizeTicker, normalizeCoinName } from "@useclaudia/sdk";
import { ClaudiaEvm, sendEvmTransactions } from "@useclaudia/sdk/evm";
import * as wallets from "./wallets.js";
import * as policy from "./policy.js";
import * as chk from "./evm-check.js";
import { getConfig, trackActivity } from "./store.js";

const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const round = (n, d = 6) => Math.round(n * 10 ** d) / 10 ** d;
const FEE_RESERVE_ETH = 0.0005;

let deps = null; // { publicClient, coin, assertOpen, agentGate } from claudia.js (avoids an import cycle)
export function init(d) { deps = d; }

export const rpcUrl = () => getConfig().claudia.hoodRpcUrl || CHAINS.hood.publicRpc;
const pub = () => chk.publicClientFor(rpcUrl());

/** The wallet that signs on Robinhood: the hot wallet when it's switched on, else the Robinhood wallet. */
function signer() {
  const hot = getConfig().claudia.hot.hood && wallets.hasHot("hood");
  const key = hot ? wallets.hotKey("hood") : wallets.evmKey();
  return { key, address: hot ? wallets.hotAddress("hood") : wallets.evmAddress(), hot };
}

export async function balanceOf(address) {
  if (!address) return null;
  return Number(await pub().getBalance({ address })) / 1e18;
}

export async function walletInfo() {
  const address = wallets.evmAddress();
  let balanceEth = null, error = null;
  if (address) { try { balanceEth = await balanceOf(address); } catch (e) { error = String(e.shortMessage || e.message || e).split("\n")[0]; } }
  return { address, balanceEth, error, rpc: new URL(rpcUrl()).host, explorer: address ? chainExplorerUrl("hood", "address", address) : null };
}

/** Token key and address for a Robinhood coin. Refuses other chains here. */
function hoodKey(token) {
  let key;
  try { key = toTokenKey(String(token || ""), "hood"); } catch { throw err(400, "Give a Robinhood Chain coin address (0x…) or hood:0x…."); }
  if (chainOfKey(key) !== "hood") throw err(400, "That isn't a Robinhood Chain coin.");
  return { key, address: key.slice(5) };
}

/** Public quote (nothing signed). */
export async function quote({ token, side, amount, slippageBps }) {
  const { key } = hoodKey(token);
  await deps.coin(key);
  const trader = wallets.hasEvm() ? signer().address : undefined;
  return { chain: "hood", unit: "ETH", quote: await deps.publicClient().quote({ token: key, side, amount: Number(amount), trader, slippageBps: slippageBps ? Number(slippageBps) : undefined }) };
}

/** Step 1 of a Robinhood trade: prepare → check → simulate. Nothing is signed or sent. */
export async function previewTrade({ token, side, amount, slippageBps, source = "user" }) {
  if (!["buy", "sell"].includes(side)) throw err(400, "Side must be buy or sell.");
  const n = Number(amount);
  if (!Number.isFinite(n) || n <= 0 || (side === "sell" && n > 100)) throw err(400, side === "buy" ? "Give the amount in ETH, e.g. 0.002." : "Sell a percent between 0 and 100.");
  const { key, address: tokenAddr } = hoodKey(token);
  await deps.assertOpen("hood");
  const detail = await deps.coin(key);
  await deps.agentGate("trade");
  const s = signer();
  if (side === "buy") policy.checkCaps("hood", n, "buy");

  const client = deps.publicClient();
  const evm = new ClaudiaEvm(client, { privateKey: s.key, chain: "hood", rpcUrl: rpcUrl() });
  if (evm.address.toLowerCase() !== s.address.toLowerCase()) throw err(409, "The wallet key doesn't match its address.", "wallet_mismatch");
  const prepared = await evm.prepareTrade(key, side, n, { slippageBps: slippageBps ? Number(slippageBps) : undefined });
  const q = prepared.quote;
  if (!prepared.txs.length) throw err(502, "Claudia returned no transactions for this trade.");
  const valueWei = chk.validate(prepared.txs);

  // Token decimals and balance from the token contract.
  let info;
  try { info = await chk.tokenInfo(pub(), tokenAddr, s.address); } catch (e) { throw err(502, `Couldn't read $${detail.symbol} on Robinhood Chain: ${String(e.shortMessage || e.message).split("\n")[0]}`); }
  const unit = 10n ** BigInt(info.decimals);
  let valueEth;
  if (side === "buy") {
    // What you typed, what the quote says and the ETH the transactions carry must agree.
    policy.checkSpend("hood", n, Number(q.amountIn), "The quote");
    policy.checkSpend("hood", n, chk.weiToEth(valueWei), "These transactions");
    valueEth = n;
  } else {
    if (info.balanceRaw === 0n) throw err(409, `This wallet holds no $${detail.symbol}.`);
    if (q.balanceTokens !== undefined) policy.checkDecimals({ what: "Your balance", ui: q.balanceTokens, raw: info.balanceRaw, decimals: info.decimals, symbol: detail.symbol });
    if (valueWei > 0n) throw err(409, "A sale shouldn't send ETH, but these transactions do. Nothing was signed.", "bad_tx");
    const want = (info.balanceRaw * BigInt(Math.round(n * 1e6))) / 100_000_000n;
    for (const a of chk.approvals(prepared.txs)) {
      if (a.token !== tokenAddr.toLowerCase()) throw err(409, "The approval is for a different token. Nothing was signed.", "bad_tx");
      if (!chk.isUnlimited(a.amount)) policy.checkTokenAmount({ what: "The approval", expected: Number(want) / Number(unit), actual: Number(a.amount) / Number(unit), symbol: detail.symbol });
    }
    valueEth = Number(q.expectedOut);
    policy.checkCaps("hood", valueEth, "sell");
  }

  const sim = await chk.inspect(pub(), prepared.txs, { wallet: s.address, token: tokenAddr });
  const tokens = Number(sim.tokenDeltaRaw) / Number(unit);
  // A passing simulation (or one that only lacked ETH, re-run with enough) must move the amounts the quote promised.
  if (sim.ok === true || sim.fundsShort) {
    if (side === "buy") policy.checkTokenAmount({ what: "Tokens you receive", expected: Number(q.expectedOut), actual: tokens, maxRatio: 2, symbol: detail.symbol });
    else policy.checkTokenAmount({ what: "Tokens you sell", expected: (Number(info.balanceRaw) / Number(unit)) * (n / 100), actual: -tokens, symbol: detail.symbol });
  }

  let balance = null;
  try { balance = await balanceOf(s.address); } catch { /* reported below */ }
  const warnings = [...(q.warnings || [])];
  if (balance === null) warnings.push("Couldn't read the wallet's ETH balance.");
  else if (side === "buy" && balance < n + FEE_RESERVE_ETH) warnings.push(`The wallet has ${round(balance)} ETH; this needs about ${round(n + FEE_RESERVE_ETH)} ETH with gas.`);
  if (policy.needsConfirm(source)) warnings.push("This trade was suggested from outside content. Check it yourself before confirming.");

  const summary = {
    kind: "trade", chain: "hood", chainName: CHAINS.hood.name, unit: "ETH", side, token: key, symbol: detail.symbol, name: detail.name, amount: n,
    quote: q, expectedReceive: side === "buy" ? { amount: Number(q.expectedOut), unit: `$${detail.symbol}`, min: Number(q.minOut) } : { amount: Number(q.expectedOut), unit: "ETH", min: Number(q.minOut) },
    sellTokens: side === "sell" ? round((Number(info.balanceRaw) / Number(unit)) * (n / 100), 4) : undefined,
    valueNative: round(valueEth), txCount: prepared.txs.length, signer: s.address, walletKind: s.hot ? "hot" : "main", balanceNative: balance,
    decimals: info.decimals,
    simulation: { ok: sim.ok, error: sim.error, gasEth: sim.gasWei ? round(chk.weiToEth(sim.gasWei), 8) : null, tokens: sim.tokenDeltaRaw !== 0n ? round(tokens, 4) : null, ethIn: sim.ethInWei ? round(chk.weiToEth(sim.ethInWei), 8) : null },
    caps: policy.capsLeft("hood"), warnings, source, network: "mainnet", liveTrading: getConfig().claudia.liveTrading,
  };
  const { id, expiresAt } = policy.savePreview("trade", "hood", { prepared, summary });
  trackActivity("claudia", `Dry run: ${side} ${side === "buy" ? n + " ETH of" : n + "% of"} $${detail.symbol} on Robinhood Chain`);
  return { id, expiresAt, ...summary };
}

/** Step 2 (Robinhood): re-check everything that can change, then sign and send. */
export async function confirmTrade(p) {
  const s0 = p.summary;
  if (s0.simulation.ok !== true) throw err(409, "The simulation didn't pass, so this wasn't sent. " + (s0.simulation.error || ""), "simulation_failed");
  await deps.assertOpen("hood");
  await deps.agentGate("trade");
  const s = signer();
  if (s.address.toLowerCase() !== s0.signer.toLowerCase()) throw err(409, `The wallet changed since the dry run (${s0.signer} → ${s.address}). Run the dry run again.`, "wallet_mismatch");
  policy.checkCaps("hood", s0.valueNative, s0.side === "buy" ? "buy" : "sell");
  const hashes = await sendEvmTransactions(p.prepared.txs, s.key, { chain: "hood", rpcUrl: rpcUrl() });
  policy.recordSpend("hood", s0.side, { native: s0.valueNative, token: s0.token, hashes });
  trackActivity("trade", `${s0.side === "buy" ? "Bought" : "Sold"} ${s0.side === "buy" ? s0.amount + " ETH of" : s0.amount + "% of"} $${s0.symbol} on Robinhood Chain (live)`);
  return { ok: true, chain: "hood", signatures: hashes, explorer: hashes.map(h => chainExplorerUrl("hood", "tx", h)) };
}

/** Launchpads open on Robinhood Chain right now (site switches), in the SDK's order. */
export async function launchpads() {
  const st = (await deps.chainList()).find(c => c.id === "hood");
  return ROBINHOOD_LAUNCHPADS.map(lp => {
    const live = st?.launchpads?.find(x => x.launchpad === lp.id);
    return { ...lp, open: live ? live.state === "open" : false, note: live?.note || null };
  });
}

/** Everything that can be checked on this computer before a Robinhood launch uploads anything. */
export async function checkLaunch({ name, symbol, devBuy = 0, launchpad }) {
  await deps.assertOpen("hood");
  const lp = (await launchpads()).find(x => x.id === launchpad);
  if (!lp) throw err(400, `Pick a Robinhood launchpad: ${ROBINHOOD_LAUNCHPADS.map(p => p.id).join(", ")}.`);
  if (!lp.open) throw err(403, `${lp.name} isn't open on Claudia right now.`, "launchpad_closed");
  const nm = normalizeCoinName(String(name || ""));
  if (!nm.ok) throw err(400, nm.error);
  const sym = normalizeTicker(String(symbol || ""), 16);
  if (!sym.ok) throw err(400, sym.error);
  const dev = Number(devBuy) || 0;
  if (dev < 0) throw err(400, "The first buy can't be negative.");
  if (dev > 0 && !lp.devBuy) throw err(400, `${lp.name} launches can't include a first buy.`);
  if (dev > 0) policy.checkCaps("hood", dev, "buy");
  await deps.agentGate("launch");
  signer(); // throws when there's no Robinhood wallet
  return { lp, name: nm.value, symbol: sym.value, dev };
}

/** Step 1 of a Robinhood launch: plan with Claudia (your 0x wallet is the creator), check, keep for 60 s. */
export async function previewLaunch({ name, symbol, description, imageUri, devBuy = 0, launchpad, twitter, telegram, website, source = "user" }) {
  const { lp, name: nmv, symbol: symv, dev } = await checkLaunch({ name, symbol, devBuy, launchpad });
  const nm = { value: nmv }, sym = { value: symv };
  const s = signer();
  const evm = new ClaudiaEvm(deps.publicClient(), { privateKey: s.key, chain: "hood", rpcUrl: rpcUrl() });
  const planned = await evm.planLaunch({
    launchpad: lp.id, name: nm.value, symbol: sym.value, imageUri, description: description ? String(description).slice(0, 500) : undefined,
    socials: { twitter: twitter || undefined, telegram: telegram || undefined, website: website || undefined }, devBuyNative: dev,
  });
  const plan = planned.plan;
  if (plan.request.creator.toLowerCase() !== s.address.toLowerCase()) throw err(409, "Claudia planned this launch for a different wallet.", "wallet_mismatch");
  if (!plan.txs.length) throw err(502, "Claudia couldn't build the launch transactions. " + [...(plan.split.warnings || []), plan.simulation?.error].filter(Boolean).join(" "));
  const valueWei = chk.validate(plan.txs);
  const total = plan.fees.totalNative;
  // The ETH the transactions carry may not exceed the plan's own total by more than 5%.
  policy.checkSpend("hood", Math.max(total, dev), chk.weiToEth(valueWei), "This launch");
  const left = policy.capsLeft("hood").leftToday;
  let balance = null;
  try { balance = await balanceOf(s.address); } catch { /* */ }
  const warnings = [...(plan.split.warnings || [])];
  if (total > left + 1e-12) warnings.push(`This costs about ${round(total)} ETH, more than what's left of your daily cap (${round(left)} ETH).`);
  if (balance !== null && balance < total + FEE_RESERVE_ETH) warnings.push(`The wallet has ${round(balance)} ETH; this needs about ${round(total + FEE_RESERVE_ETH)} ETH.`);
  if (policy.needsConfirm(source)) warnings.push("This launch was suggested from outside content. Check it yourself before confirming.");
  const summary = {
    kind: "launch", chain: "hood", chainName: CHAINS.hood.name, unit: "ETH", launchpad: lp.id, launchpadName: lp.name, name: nm.value, symbol: sym.value, imageUri,
    token: plan.predicted.token || null, mint: plan.predicted.token || null, splitter: plan.predicted.splitter || null, devBuy: dev, fees: plan.fees,
    split: { creatorPct: plan.split.creatorBps / 100, platformPct: plan.split.platformBps / 100, creator: plan.split.creator, mechanism: plan.split.mechanism },
    devBuyPreview: plan.devBuyPreview, simulation: plan.simulation || null, warnings, balanceNative: balance, overCap: total > left + 1e-12,
    caps: policy.capsLeft("hood"), signer: s.address, walletKind: s.hot ? "hot" : "main", txCount: plan.txs.length, source, network: "mainnet", liveTrading: getConfig().claudia.liveTrading,
  };
  const { id, expiresAt } = policy.savePreview("launch", "hood", { planned, summary });
  trackActivity("claudia", `Dry run: launch $${sym.value} on ${lp.name}, Robinhood Chain`);
  return { id, expiresAt, ...summary };
}

export async function confirmLaunch(p) {
  const s0 = p.summary;
  if (s0.overCap) throw err(403, "This launch is over your daily cap.", "cap_exceeded");
  if (s0.simulation && s0.simulation.ok === false) throw err(409, "The simulation failed, so this wasn't sent.", "simulation_failed");
  await deps.assertOpen("hood");
  await deps.agentGate("launch");
  const s = signer();
  if (s.address.toLowerCase() !== s0.signer.toLowerCase()) throw err(409, "The wallet changed since the dry run. Run it again.", "wallet_mismatch");
  policy.checkCaps("hood", s0.fees.totalNative, "launch");
  const evm = new ClaudiaEvm(deps.publicClient(), { privateKey: s.key, chain: "hood", rpcUrl: rpcUrl() });
  const r = await evm.executeLaunch(p.planned);
  policy.recordSpend("hood", "launch", { native: s0.fees.totalNative, token: r.token ? `hood:${r.token}` : undefined, hashes: r.hashes });
  trackActivity("trade", `Launched $${s0.symbol} on ${s0.launchpadName}, Robinhood Chain (live)`);
  return { ok: true, chain: "hood", mint: r.token || s0.mint, token: r.token ? `hood:${String(r.token).toLowerCase()}` : null, signatures: r.hashes, explorer: r.hashes.map(h => chainExplorerUrl("hood", "tx", h)) };
}

/** ETH transfer of (nearly) everything in the hot wallet back to your main wallet, prepared and simulated. */
export async function prepareSweep(to) {
  if (!isEvmAddress(to)) throw err(400, "The main wallet must be a 0x address.");
  const from = wallets.hotAddress("hood");
  if (!from) throw err(409, "There's no Robinhood hot wallet.");
  if (from.toLowerCase() === to.toLowerCase()) throw err(400, "The main wallet is the hot wallet itself.");
  const c = pub();
  const [bal, gasPrice] = await Promise.all([c.getBalance({ address: from }), c.getGasPrice()]);
  // Arbitrum-style chains charge an L1 part on top of 21000 gas; estimate it and keep a margin.
  let gas = 21000n;
  try { gas = await c.estimateGas({ account: from, to, value: 0n }); } catch { gas = 100000n; }
  const feeWei = (gas * gasPrice * 3n) / 2n;
  const valueWei = bal > feeWei ? bal - feeWei : 0n;
  const sim = valueWei > 0n ? await c.call({ account: from, to, value: valueWei }).then(() => ({ ok: true }), (e) => ({ ok: false, error: String(e.shortMessage || e.message).split("\n")[0] })) : { ok: false, error: "The hot wallet is empty (or holds only enough for gas)." };
  const summary = { kind: "sweep", chain: "hood", unit: "ETH", from, to, amount: round(chk.weiToEth(valueWei), 8), feeEth: round(chk.weiToEth(feeWei), 8), simulation: sim, liveTrading: getConfig().claudia.liveTrading };
  const tx = { kind: "evm", chainId: CHAINS.hood.evmChainId, to, data: "0x", value: valueWei.toString(), gas: gas.toString(), description: "Sweep the hot wallet back to your main wallet" };
  const { id, expiresAt } = policy.savePreview("sweep", "hood", { tx, summary });
  return { id, expiresAt, ...summary };
}

export async function confirmSweep(p) {
  if (p.summary.simulation.ok !== true) throw err(409, "The simulation didn't pass, so nothing was sent.", "simulation_failed");
  if (wallets.hotAddress("hood")?.toLowerCase() !== p.summary.from.toLowerCase()) throw err(409, "The hot wallet changed. Prepare the sweep again.");
  const hashes = await sendEvmTransactions([p.tx], wallets.hotKey("hood"), { chain: "hood", rpcUrl: rpcUrl() });
  trackActivity("trade", `Swept ${p.summary.amount} ETH from the Robinhood hot wallet to ${p.summary.to} (live)`);
  return { ok: true, signatures: hashes, explorer: hashes.map(h => chainExplorerUrl("hood", "tx", h)) };
}
