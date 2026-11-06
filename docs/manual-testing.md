# Manual testing

How to walk the whole PulseKey flow by hand on Hedera testnet. Everything here uses your `.env` (buyer and study accounts, `POOL_KEK`, `ZG_SK`, `HCS_TOPIC_ID`).

## 1. Start it

```bash
cd ~/Desktop/health-data-pool
npm run web:build
PER_PERSON_MICRO=1000 MIN_CLAIM_MICRO=100 npm run serve
```

Open http://localhost:4021.

- `PER_PERSON_MICRO=1000` prices answers at about $0.001 a person. At the default ($0.02) a 200-person answer costs about $4.44, which is over the agent's $3 per-question limit, so it would skip every question.
- `MIN_CLAIM_MICRO=100` lets you claim the tiny testnet earnings. The default minimum is $0.01.
- Sign-in is the labelled dev stand-in until World ID access works (`IDENTITY=world` switches it).

To use your **real ring**, Ultrahuman needs an HTTPS address. Start ngrok to the port and tell the server its public URL:

```bash
PORT=3000 API_BASE=https://<your-ngrok-domain> PER_PERSON_MICRO=1000 MIN_CLAIM_MICRO=100 npm run serve
```

Then use the ngrok URL in the browser. Stop the server when you're done: with dev sign-in, anyone with the URL can type a name and get in.

## 2. Contributor sign-up (sample data, no ring needed)

1. **Landing** `/`: check the live strip shows real totals and recent paid answers with HashScan links. Click **Try with sample data**.
2. **Verify**: click **Verify with World ID**. On the dev page, type a name (the same name always returns the same account; use a new one for a fresh run) and **Continue**. You should see "You're signed in" and step 1 checked. **Continue**.
3. **Connect**: click **Use labelled sample data**, then **Choose what to share**.
4. **Share**: leave Sleep and HRV on, pick 30, 60 or 90 days, tick both boxes, **Confirm with World ID**. You land on Today.
5. **Today**: a brief written by the sealed model on 0G from this person's own nights, with a "Sealed on 0G" request id; a chart of their last nights; earnings $0; the grant card.

## 3. Make an agent pay

In a second terminal (takes about a minute; spends roughly $0.70 of testnet USDC from the buyer account):

```bash
API_BASE=http://localhost:4021 npx tsx --env-file=.env src/x402/agent.ts
```

It asks three questions: typical sleep, share with HRV under 40 ms, and the pattern "does HRV drop the night after short sleep?" (one sealed read per person on 0G). Each prints its answer and a HashScan link.

Back in the browser:

- **Activity**: three rows with route chips, group size, ε, your days and earnings. Click a row, then **Open the public proof**: payment confirmed on the mirror node, the split, sealed request ids and 0G's attestation verdicts.
- **Today**: "Recently counted" now lists them; the privacy budget on Activity reads 2.0 of 10.

## 4. Claim

**Earnings** → **Claim $…**. If you signed in more than 10 minutes ago, you are sent through "Confirm it's still you" first and the claim resumes on its own. Expect: "$… sent to 0.0.xxxxxxx", a HashScan link, and **Download my key** (a JSON file with the private key; PulseKey has no copy). Open the account on HashScan: it holds exactly the claimed USDC. A second claim should say there's nothing to claim.

## 5. Manage the grant

On **Grant**:

- **Sync now** (allowed once a minute).
- Turn **Resting heart rate** on: widening needs a fresh check if your last one is older than 10 minutes. Turning it off never does.
- **Extend 30 days**, then **Stop** (no new nights; you're left out of new answers).
- **Withdraw** → confirm. Your key and records are destroyed; you can still sign in and claim anything left.

## 6. Public pages (no sign-in)

| Page | What to check |
|---|---|
| `/audit` | Totals, paid queries with route chips, privacy budget histogram, agent spending log: chain intact and every debit matched |
| `/proof/agent` | Every HCS log entry and the reconciliation against real USDC debits |
| `/proof/queries/<id>` | One answer's full proof (open from Activity or Live audit) |
| `/catalog` | What an agent sees: endpoints, prices, metrics, the pattern template |

## 7. Failure states worth seeing

- `/signup/verify?check=cancelled`: "Verification didn't finish."
- `/signup/failed?check=expired`: "Your check expired" with nothing collected.
- Real ring: deny access on Ultrahuman's page and you return to Connect with "access wasn't approved".

## Housekeeping

- **Real ring**: on Connect choose **Connect Ultrahuman**, sign in on Ultrahuman's page, tick "I trust …", approve. Do the whole flow in one browser tab.
- **Fresh demo pool** (keeps real people and their ring): stop the server, then `npm run reseed`.
- **Clean spending log for a demo**: `npx tsx --env-file=.env scripts/setup-payouts.ts --new-topic`.
- **Automated tests**: `npm test` (45 local tests, no network).
- The brief is made once a day per person, so a second visit the same day shows the cached one.
