import { associateUsdc, usdcMicroBalance } from "../src/hedera/accounts.js";
for (const [name, id, key] of [["buyer", process.env.BUYER_ACCOUNT_ID!, process.env.BUYER_PRIVATE_KEY!], ["study", process.env.STUDY_ACCOUNT_ID!, process.env.STUDY_PRIVATE_KEY!]] as const) {
  console.log(name, id, await associateUsdc(id, key));
  await new Promise((r) => setTimeout(r, 6000));
  console.log(name, "USDC micro", (await usdcMicroBalance(id)).toString());
}
