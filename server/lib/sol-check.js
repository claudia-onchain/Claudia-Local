/**
 * sol-check.js — what a prepared Solana trade really does, read from a simulation before anything is signed.
 *
 * For each transaction: resolve every writable account (lookup tables included), read them before, simulate
 * with those accounts returned, and compare. Out of that come the SOL the wallet spends (fees and rent for new
 * accounts counted apart), and the change in the wallet's token balance in raw base units. policy.js then checks
 * those numbers against what you typed and what the quote said, using the token's decimals from the chain.
 */
import { PublicKey, VersionedTransaction } from "@solana/web3.js";
import { fromBase64 } from "@useclaudia/sdk";

export const TOKEN_PROGRAMS = new Set(["TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"]);
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const MAX_RENT_ALLOWANCE = 10_000_000; // 0.01 SOL: new token accounts and trade records, refundable rent

const u64 = (buf, off) => (buf && buf.length >= off + 8 ? Buffer.from(buf).readBigUInt64LE(off) : 0n);
const firstLine = (e) => String(e?.message || e).split("\n")[0].slice(0, 300);

/** Decimals and token program of a mint, from the chain. */
export async function mintInfo(conn, mint) {
  const info = await conn.getAccountInfo(new PublicKey(mint));
  if (!info) throw Object.assign(new Error("That coin's mint doesn't exist on this network."), { status: 404 });
  const program = info.owner.toBase58();
  if (!TOKEN_PROGRAMS.has(program) || info.data.length < 45) throw Object.assign(new Error("That address isn't a token mint."), { status: 400 });
  return { program, decimals: info.data[44], supplyRaw: u64(info.data, 36) };
}

/** The wallet's raw balance of a mint, summed over its token accounts. */
export async function tokenBalanceRaw(conn, owner, mint) {
  const r = await conn.getTokenAccountsByOwner(new PublicKey(owner), { mint: new PublicKey(mint) });
  let raw = 0n;
  for (const a of r.value) raw += u64(a.account.data, 64);
  return raw;
}

/** Network fee of a transaction: 5000 lamports per signature + the priority fee from its compute-budget instructions. */
function networkFee(tx, keys) {
  const msg = tx.message;
  let units = 200_000n, microLamports = 0n;
  for (const ix of msg.compiledInstructions) {
    if (keys[ix.programIdIndex] !== COMPUTE_BUDGET) continue;
    const d = Buffer.from(ix.data);
    if (d[0] === 2 && d.length >= 5) units = BigInt(d.readUInt32LE(1));
    if (d[0] === 3 && d.length >= 9) microLamports = d.readBigUInt64LE(1);
  }
  return BigInt(msg.header.numRequiredSignatures) * 5000n + (units * microLamports + 999_999n) / 1_000_000n;
}

async function accountKeys(conn, tx) {
  const msg = tx.message;
  const keys = msg.staticAccountKeys.map(k => k.toBase58());
  const lookups = msg.addressTableLookups || [];
  if (!lookups.length) return keys;
  const writable = [], readonly = [];
  for (const l of lookups) {
    const t = (await conn.getAddressLookupTable(l.accountKey)).value;
    if (!t) throw new Error(`Lookup table ${l.accountKey.toBase58()} wasn't found`);
    for (const i of l.writableIndexes) writable.push(t.state.addresses[i].toBase58());
    for (const i of l.readonlyIndexes) readonly.push(t.state.addresses[i].toBase58());
  }
  return [...keys, ...writable, ...readonly];
}

/**
 * Simulates each transaction (base64) for `wallet` and returns what it would do:
 *   { ok, error?, logs?, lamportsOut, feesLamports, rentLamports, spendLamports, tokenDeltaRaw }
 * spendLamports = what leaves the wallet minus network fees and (up to 0.01 SOL of) rent for new accounts.
 * tokenDeltaRaw = change of the wallet's balance of `mint` in base units (negative when tokens leave).
 */
export async function inspect(conn, txs, { wallet, mint }) {
  const out = { ok: true, lamportsOut: 0n, feesLamports: 0n, rentLamports: 0n, spendLamports: 0n, tokenDeltaRaw: 0n };
  const host = (() => { try { return new URL(conn.rpcEndpoint).host; } catch { return "your RPC"; } })();
  try {
    for (const t of txs) {
      const tx = VersionedTransaction.deserialize(fromBase64(t.base64));
      const keys = await accountKeys(conn, tx);
      const writable = [...new Set(keys.filter((_, i) => tx.message.isAccountWritable(i)))];
      if (!writable.includes(wallet)) writable.unshift(wallet);
      const before = await conn.getMultipleAccountsInfo(writable.map(k => new PublicKey(k)));
      const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: "processed", accounts: { encoding: "base64", addresses: writable } });
      if (r.value.err) {
        const why = JSON.stringify(r.value.err);
        const plain = /AccountNotFound/.test(why) ? "the wallet has no SOL yet" : /InsufficientFunds|insufficient lamports/i.test(why + (r.value.logs || []).join(" ")) ? "the wallet doesn't have enough SOL" : why;
        return { ...out, ok: false, error: `"${t.description}" would fail: ${plain}`, logs: (r.value.logs || []).slice(-6) };
      }
      const after = r.value.accounts || [];
      const fee = networkFee(tx, keys);
      out.feesLamports += fee;
      for (let i = 0; i < writable.length; i++) {
        const pre = before[i], post = after[i];
        const preL = BigInt(pre?.lamports || 0), postL = BigInt(post?.lamports || 0);
        if (writable[i] === wallet) { out.lamportsOut += preL - postL; continue; }
        if (!pre && postL > 0n) out.rentLamports += postL;
        // Token accounts of the wallet for this mint (SPL Token and Token-2022 share the first 72 bytes).
        const owner = post?.owner || pre?.owner?.toBase58?.();
        if (!TOKEN_PROGRAMS.has(String(owner))) continue;
        const postData = post?.data ? Buffer.from(post.data[0], "base64") : null;
        const preData = pre?.data ? Buffer.from(pre.data) : null;
        const sample = postData && postData.length >= 72 ? postData : preData;
        if (!sample || sample.length < 72) continue;
        if (new PublicKey(sample.subarray(0, 32)).toBase58() !== mint || new PublicKey(sample.subarray(32, 64)).toBase58() !== wallet) continue;
        out.tokenDeltaRaw += u64(postData, 64) - u64(preData, 64);
      }
    }
  } catch (e) {
    return { ...out, ok: null, error: `Couldn't simulate on ${host}: ${firstLine(e)}` };
  }
  const rent = out.rentLamports < BigInt(MAX_RENT_ALLOWANCE) ? out.rentLamports : BigInt(MAX_RENT_ALLOWANCE);
  const spend = out.lamportsOut - out.feesLamports - rent;
  out.spendLamports = spend > 0n ? spend : 0n;
  return out;
}

/** JSON-safe numbers for the confirm card. */
export const lamportsToSol = (l) => Number(l) / 1e9;
