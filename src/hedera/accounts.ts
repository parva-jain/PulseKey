import { AccountId, Client, PrivateKey, TokenAssociateTransaction, TokenId } from "@x402/hedera";

export const USDC_TESTNET = "0.0.429274";
const MIRROR = "https://testnet.mirrornode.hedera.com/api/v1";

export function testnetClient(accountId: string, privateKey: string) {
  return Client.forTestnet().setOperator(AccountId.fromString(accountId), PrivateKey.fromStringECDSA(privateKey));
}

// Safe to run twice: an account that is already associated counts as done.
export async function associateUsdc(accountId: string, privateKey: string) {
  const client = testnetClient(accountId, privateKey);
  try {
    const tx = await new TokenAssociateTransaction()
      .setAccountId(AccountId.fromString(accountId))
      .setTokenIds([TokenId.fromString(USDC_TESTNET)])
      .execute(client);
    return (await tx.getReceipt(client)).status.toString();
  } catch (e: any) {
    if (String(e?.message).includes("TOKEN_ALREADY_ASSOCIATED_TO_ACCOUNT")) return "ALREADY_ASSOCIATED";
    throw e;
  } finally {
    client.close();
  }
}

// Mirror node, because AccountBalanceQuery is no longer available on consensus nodes.
export async function usdcMicroBalance(accountId: string): Promise<bigint> {
  const r = await fetch(`${MIRROR}/accounts/${accountId}/tokens?token.id=${USDC_TESTNET}`);
  if (!r.ok) throw new Error(`mirror ${r.status}`);
  const { tokens } = (await r.json()) as { tokens: { balance: number }[] };
  return BigInt(tokens[0]?.balance ?? 0);
}
