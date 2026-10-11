/**
 * evm-check.js — what a prepared Robinhood Chain transaction batch really does, before anything is signed.
 *
 * Every transaction is checked for the right chain, a valid recipient and calldata. The batch is simulated in
 * order with eth_simulateV1 (state carries over, so a sale after its approval simulates correctly) with
 * transfer tracing on, which reports every token and ETH movement. Out of that come the ETH the wallet sends
 * and the change in its token balance in raw base units, for policy.js to check against what you typed, the
 * quote and the token's decimals (read from the token contract).
 */
import { createPublicClient, http, isAddress, isHex } from "viem";
import { CHAINS } from "@useclaudia/sdk";
import { robinhoodChain } from "@useclaudia/sdk/evm";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // eth_simulateV1 logs native transfers from this address
const APPROVE = "0x095ea7b3";
const MAX_UINT = (1n << 256n) - 1n;
const ERC20 = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
];

const firstLine = (e) => String(e?.details || e?.shortMessage || e?.message || e).split("\n")[0].slice(0, 300);
const err = (status, message, code) => Object.assign(new Error(message), { status, code });
const lc = (s) => String(s || "").toLowerCase();
const topicAddr = (t) => "0x" + String(t).slice(-40).toLowerCase();

export function publicClientFor(rpcUrl) {
  return createPublicClient({ chain: robinhoodChain, transport: http(rpcUrl || CHAINS.hood.publicRpc, { timeout: 20_000 }) });
}

/** Decimals and the wallet's raw balance, read from the token contract. */
export async function tokenInfo(pub, token, wallet) {
  const address = token;
  const [decimals, balance] = await Promise.all([
    pub.readContract({ address, abi: ERC20, functionName: "decimals" }),
    pub.readContract({ address, abi: ERC20, functionName: "balanceOf", args: [wallet] }),
  ]);
  return { decimals: Number(decimals), balanceRaw: BigInt(balance) };
}

/** Throws unless every transaction is a well-formed call on Robinhood Chain. Returns the summed ETH value (wei). */
export function validate(txs) {
  let value = 0n;
  txs.forEach((tx, i) => {
    const tag = `Transaction ${i + 1} of ${txs.length}`;
    if (tx.kind !== "evm") throw err(409, `${tag} isn't an EVM transaction.`, "wrong_chain");
    if (tx.chainId !== CHAINS.hood.evmChainId) throw err(409, `${tag} targets chain ${tx.chainId}, not Robinhood Chain (${CHAINS.hood.evmChainId}).`, "wrong_chain");
    if (!isAddress(tx.to)) throw err(409, `${tag} has an invalid recipient.`, "bad_tx");
    if (tx.data && !isHex(tx.data)) throw err(409, `${tag} has invalid calldata.`, "bad_tx");
    try { value += BigInt(tx.value || "0"); } catch { throw err(409, `${tag} has an invalid value.`, "bad_tx"); }
  });
  return value;
}

/** Approvals in the batch: [{ token, spender, amount }] (amount in raw base units; MAX means unlimited). */
export function approvals(txs) {
  const out = [];
  for (const tx of txs) {
    const d = lc(tx.data);
    if (!d.startsWith(APPROVE) || d.length < 10 + 128) continue;
    out.push({ token: lc(tx.to), spender: "0x" + d.slice(10 + 24, 10 + 64), amount: BigInt("0x" + d.slice(10 + 64, 10 + 128)) });
  }
  return out;
}
export const isUnlimited = (a) => a >= MAX_UINT / 2n;

/**
 * Simulates the batch in order for `wallet`. Returns
 *   { ok, error?, valueWei, gasUsed, gasWei, tokenDeltaRaw, ethInWei }
 * tokenDeltaRaw: change of the wallet's balance of `token` (negative when tokens leave).
 * ethInWei: native coin the wallet receives (a sale's proceeds).
 */
export async function inspect(pub, txs, { wallet, token }) {
  const valueWei = validate(txs);
  const base = { ok: true, valueWei, gasUsed: 0n, gasWei: 0n, tokenDeltaRaw: 0n, ethInWei: 0n };
  const w = lc(wallet), t = lc(token);
  const calls = txs.map(tx => ({ from: wallet, to: tx.to, data: tx.data || "0x", value: "0x" + BigInt(tx.value || "0").toString(16), ...(tx.gas ? { gas: "0x" + BigInt(tx.gas).toString(16) } : {}) }));
  const run = (overrides) => pub.request({ method: "eth_simulateV1", params: [{ blockStateCalls: [{ ...(overrides ? { stateOverrides: overrides } : {}), calls }], traceTransfers: true, validation: false }, "latest"] });
  let res, short = null;
  try {
    res = await run();
  } catch (e) {
    // An empty or underfunded wallet: report it, and still simulate with enough ETH so the amounts can be checked.
    if (!/insufficient funds/i.test(`${e?.details} ${e?.message} ${e?.cause?.message}`)) return { ...base, ok: null, error: `Couldn't simulate on Robinhood Chain: ${firstLine(e)}` };
    short = "The wallet doesn't have enough ETH for this (amount plus gas).";
    try { res = await run({ [wallet]: { balance: "0x" + (valueWei + 10n ** 17n).toString(16) } }); } catch (e2) { return { ...base, ok: false, error: short + " " + firstLine(e2) }; }
  }
  const results = res?.[0]?.calls || [];
  for (let i = 0; i < results.length; i++) {
    const c = results[i];
    if (c.status !== "0x1") return { ...base, ok: false, error: `${short ? short + " Also, " : ""}"${txs[i].description || `Transaction ${i + 1}`}" would fail: ${c.error?.message || "reverted"}` };
    base.gasUsed += BigInt(c.gasUsed || "0x0");
    for (const log of c.logs || []) {
      if (lc(log.topics?.[0]) !== TRANSFER || (log.topics || []).length < 3) continue;
      const from = topicAddr(log.topics[1]), to = topicAddr(log.topics[2]);
      const amount = BigInt(log.data && log.data !== "0x" ? log.data : "0x0");
      const src = lc(log.address);
      if (src === t) { if (to === w) base.tokenDeltaRaw += amount; if (from === w) base.tokenDeltaRaw -= amount; }
      if (src === NATIVE && to === w && from !== w) base.ethInWei += amount;
    }
  }
  try { base.gasWei = base.gasUsed * (await pub.getGasPrice()); } catch { /* shown as unknown */ }
  if (short) { base.ok = false; base.error = short; base.fundsShort = true; }
  return base;
}

export const weiToEth = (w) => Number(w) / 1e18;
