// One-time testnet setup: the buyer agent's audit topic and the labelled demo treasury for seed shares.
// Appends the new IDs to .env and skips anything already set. Never prints a private key.
import { appendFileSync, readFileSync } from "node:fs";
import { AccountCreateTransaction, Client, Hbar, PrivateKey } from "@hiero-ledger/sdk";
import { createAuditTopic } from "../src/hedera/audit.js";

const env = (k: string) => process.env[k];
const save = (lines: string[]) => {
  const cur = readFileSync(".env", "utf8");
  appendFileSync(".env", (cur.endsWith("\n") ? "" : "\n") + lines.join("\n") + "\n");
};

if (!env("HCS_TOPIC_ID")) {
  const key = PrivateKey.fromStringECDSA(env("BUYER_PRIVATE_KEY")!);
  const client = Client.forTestnet().setOperator(env("BUYER_ACCOUNT_ID")!, key);
  const topic = await createAuditTopic(client, key.publicKey);
  save([`HCS_TOPIC_ID=${topic}`]);
  console.log(`audit topic ${topic}: https://hashscan.io/testnet/topic/${topic}`);
  client.close();
} else console.log(`audit topic already set: ${env("HCS_TOPIC_ID")}`);

if (!env("DEMO_TREASURY_ID")) {
  const client = Client.forTestnet().setOperator(env("STUDY_ACCOUNT_ID")!, PrivateKey.fromStringECDSA(env("STUDY_PRIVATE_KEY")!));
  const key = PrivateKey.generateECDSA();
  const res = await new AccountCreateTransaction()
    .setECDSAKeyWithAlias(key.publicKey)
    .setMaxAutomaticTokenAssociations(1)
    .setInitialBalance(new Hbar(2))
    .setAccountMemo("PulseKey demo treasury: synthetic contributors' shares")
    .execute(client);
  const id = (await res.getReceipt(client)).accountId!.toString();
  // The key is kept so testnet USDC can be moved back to the buyer between rehearsals.
  save([`DEMO_TREASURY_ID=${id}`, `DEMO_TREASURY_KEY=${key.toStringDer()}`]);
  console.log(`demo treasury ${id}: https://hashscan.io/testnet/account/${id}`);
  client.close();
} else console.log(`demo treasury already set: ${env("DEMO_TREASURY_ID")}`);
