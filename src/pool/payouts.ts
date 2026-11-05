// payouts: earnings sit in the off-chain ledger until claimed. A claim debits the ledger first, in one
// transaction, then creates a fresh account for a key the person's browser made and sends USDC to it.
// Nothing on chain links the claim to the person. Seed people's shares go to one labelled demo treasury.
import { randomUUID } from "node:crypto";
import {
  AccountCreateTransaction, AccountId, Client, Hbar, PublicKey, TokenId, TransferTransaction,
} from "@hiero-ledger/sdk";
import type { Db } from "../db/index.js";
import { Refused } from "./query.js";
import { USDC_TESTNET } from "../hedera/accounts.js";

export const MIN_CLAIM_MICRO = BigInt(process.env.MIN_CLAIM_MICRO ?? 10_000); // $0.01: below this, fees outweigh the payout

/** The two chain actions a payout needs. Hedera in production, a fake in tests. */
export type PayoutChain = {
  createAccount(publicKeyDer: string): Promise<{ accountId: string; tx: string }>;
  sendUsdc(to: string, micro: bigint): Promise<{ tx: string }>;
};

const BALANCE = "SELECT coalesce(sum(CASE kind WHEN 'earning' THEN micro WHEN 'claim' THEN -micro END), 0)::text AS bal FROM ledger WHERE contributor_id = $1";

/** Earned minus claimed. Pending claims count as claimed, so a retry cannot pay twice. */
export async function balanceMicro(db: Pick<Db, "query">, contributorId: string) {
  return BigInt((await db.query<{ bal: string }>(BALANCE, [contributorId])).rows[0].bal);
}

/** Only a fresh secp256k1 key: the account alias is derived from it, so no signature from it is needed. */
export function parseClaimKey(der: unknown) {
  if (typeof der !== "string" || !/^[0-9a-f]{60,200}$/i.test(der)) throw new Refused("bad_public_key", 400);
  let key: PublicKey;
  try { key = PublicKey.fromString(der); } catch { throw new Refused("bad_public_key", 400); }
  if (key.toStringDer() !== der.toLowerCase() || !key.toStringDer().startsWith("302d300706052b8104000a")) throw new Refused("ecdsa_key_required", 400);
  return key.toStringDer();
}

export async function claim(db: Db, chain: PayoutChain, contributorId: string, publicKeyDer: unknown) {
  const pub = parseClaimKey(publicKeyDer);
  const id = randomUUID();
  const micro = await db.transaction(async tx => {
    const who = await tx.query<{ kind: string }>("SELECT kind FROM contributors WHERE id = $1 FOR UPDATE", [contributorId]);
    if (!who.rows[0]) throw new Refused("unknown_contributor", 404);
    if (who.rows[0].kind !== "real") throw new Refused("seed_people_cannot_claim", 403);
    // One key, one account. A key from a failed attempt may be retried, since no account was made for it.
    const used = await tx.query("SELECT 1 FROM claims WHERE public_key = $1 AND status <> 'failed'", [pub]);
    if (used.rows.length) throw new Refused("key_already_used", 409);
    const bal = await balanceMicro(tx, contributorId);
    if (bal < MIN_CLAIM_MICRO) throw new Refused("nothing_to_claim", 409);
    await tx.query("INSERT INTO claims (id, contributor_id, micro, public_key, status) VALUES ($1, $2, $3, $4, 'pending')", [id, contributorId, bal, pub]);
    await tx.query("INSERT INTO ledger (contributor_id, kind, micro, claim_id) VALUES ($1, 'claim', $2, $3)", [contributorId, bal, id]);
    return bal;
  });

  let accountId: string;
  try {
    const acct = await chain.createAccount(pub);
    accountId = acct.accountId;
    await db.query("UPDATE claims SET account_id = $2, create_tx = $3 WHERE id = $1", [id, accountId, acct.tx]);
  } catch (e) {
    // No money has moved yet, so the debit is undone and the person can try again.
    await undo(db, id);
    throw e;
  }
  return { claimId: id, micro: micro.toString(), accountId, ...(await pay(db, chain, id, accountId, micro)) };
}

/** Sends every seed person's unclaimed share to the demo treasury in one transfer. */
export async function sweepSeedShares(db: Db, chain: PayoutChain, treasuryId: string) {
  const id = randomUUID();
  const micro = await db.transaction(async tx => {
    const { rows } = await tx.query<{ contributor_id: string; bal: string }>(
      `SELECT l.contributor_id, sum(CASE l.kind WHEN 'earning' THEN l.micro WHEN 'claim' THEN -l.micro END)::text AS bal
         FROM ledger l JOIN contributors c ON c.id = l.contributor_id AND c.kind = 'seed'
        GROUP BY l.contributor_id`,
    );
    const owed = rows.map(r => ({ id: r.contributor_id, micro: BigInt(r.bal) })).filter(r => r.micro > 0n);
    const total = owed.reduce((a, r) => a + r.micro, 0n);
    if (total === 0n) return 0n;
    await tx.query("INSERT INTO claims (id, contributor_id, micro, account_id, status) VALUES ($1, NULL, $2, $3, 'pending')", [id, total, treasuryId]);
    for (const r of owed) await tx.query("INSERT INTO ledger (contributor_id, kind, micro, claim_id) VALUES ($1, 'claim', $2, $3)", [r.id, r.micro, id]);
    return total;
  });
  if (micro === 0n) return null;
  return { claimId: id, micro: micro.toString(), accountId: treasuryId, ...(await pay(db, chain, id, treasuryId, micro)) };
}

/**
 * A failed transfer leaves the claim pending and the ledger debited: the transfer may have reached consensus
 * even though we saw an error, so it must be checked on the mirror node before any resend. Never pay twice.
 */
async function pay(db: Db, chain: PayoutChain, claimId: string, to: string, micro: bigint) {
  const { tx } = await chain.sendUsdc(to, micro);
  await db.query("UPDATE claims SET transfer_tx = $2, status = 'paid' WHERE id = $1", [claimId, tx]);
  await db.query("UPDATE ledger SET tx = $2 WHERE claim_id = $1", [claimId, tx]);
  return { tx };
}

async function undo(db: Db, claimId: string) {
  await db.transaction(async tx => {
    await tx.query("DELETE FROM ledger WHERE claim_id = $1", [claimId]);
    await tx.query("UPDATE claims SET status = 'failed' WHERE id = $1", [claimId]);
  });
}

/** Hedera testnet: the study account pays for account creation and sends the USDC. */
export function hederaPayouts(client: Client, payFrom: string): PayoutChain {
  const usdc = TokenId.fromString(USDC_TESTNET);
  return {
    async createAccount(publicKeyDer) {
      const res = await new AccountCreateTransaction()
        .setECDSAKeyWithAlias(PublicKey.fromString(publicKeyDer))
        .setMaxAutomaticTokenAssociations(1) // USDC takes the only slot on the first transfer
        .setInitialBalance(new Hbar(1)) // lets the owner pay their own fees later
        .execute(client);
      const receipt = await res.getReceipt(client);
      return { accountId: receipt.accountId!.toString(), tx: res.transactionId.toString() };
    },
    async sendUsdc(to, micro) {
      const res = await new TransferTransaction()
        .addTokenTransfer(usdc, AccountId.fromString(payFrom), -Number(micro))
        .addTokenTransfer(usdc, AccountId.fromString(to), Number(micro))
        .execute(client);
      const receipt = await res.getReceipt(client);
      if (receipt.status.toString() !== "SUCCESS") throw new Error(`transfer ${receipt.status}`);
      return { tx: res.transactionId.toString() };
    },
  };
}
