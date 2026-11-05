import { randomBytes } from "node:crypto";
import * as oidc from "openid-client";

export const ATTEMPT_TTL_S = 600;
export const ORB_ACR = "https://world.org/oidc/acr/orb";
const accepted = () => (process.env.WORLD_ACCEPTED_ACR ?? ORB_ACR).split(",");

export class Blocked extends Error {}

export type Attempt = { state: string; nonce: string; verifier: string; createdAt: number; fresh: boolean; expectedSub: string | null; expectedIss: string | null };

export async function worldConfig() {
  const config = await oidc.discovery(
    new URL(process.env.WORLD_ISSUER!),
    process.env.WORLD_CLIENT_ID!,
    undefined,
    oidc.ClientSecretBasic(process.env.WORLD_CLIENT_SECRET!),
  );
  oidc.enableNonRepudiationChecks(config); // signature validation is opt-in
  return config;
}

export function newAttempt(a: { fresh: boolean; expectedSub?: string | null; expectedIss?: string | null }): Attempt {
  const r = () => randomBytes(32).toString("base64url");
  return { state: r(), nonce: r(), verifier: r(), createdAt: Date.now() / 1000, fresh: a.fresh, expectedSub: a.expectedSub ?? null, expectedIss: a.expectedIss ?? null };
}

export async function startCheck(config: oidc.Configuration, redirectUri: string, a: Attempt) {
  return oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: "openid",
    state: a.state,
    nonce: a.nonce,
    code_challenge: await oidc.calculatePKCECodeChallenge(a.verifier),
    code_challenge_method: "S256",
    max_age: "0", // a reused session must not count as the check
    claims: JSON.stringify({ id_token: { acr: { essential: true, values: accepted() } } }),
  }).href;
}

// Fails closed at each step. Tokens are discarded; only these claims are returned.
export async function finishCheck(config: oidc.Configuration, callbackUrl: URL, a: Attempt) {
  if (callbackUrl.searchParams.get("iss") !== config.serverMetadata().issuer) throw new Blocked("iss_mismatch");
  const err = callbackUrl.searchParams.get("error");
  if (err) throw new Blocked(err);
  if (Date.now() / 1000 > a.createdAt + ATTEMPT_TTL_S) throw new Blocked("attempt_expired");
  const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
    pkceCodeVerifier: a.verifier,
    expectedState: a.state,
    expectedNonce: a.nonce,
    maxAge: ATTEMPT_TTL_S, // presence and upper bound; our own check below enforces freshness
  });
  const c = tokens.claims()!;
  const now = Date.now() / 1000;
  const claims = { iss: c.iss, sub: c.sub, acr: c.acr as string | undefined, amr: c.amr as string[] | undefined, authTime: c.auth_time as number | undefined, ageS: typeof c.auth_time === "number" ? Math.round(now - c.auth_time) : null };
  if (typeof c.auth_time !== "number" || c.auth_time < a.createdAt - 30 || c.auth_time > now + 30) throw Object.assign(new Blocked("not_fresh"), { claims });
  if (typeof c.acr !== "string" || !accepted().includes(c.acr)) throw Object.assign(new Blocked("acr_not_accepted"), { claims });
  if (Array.isArray(c.amr) && c.amr.includes("mfa")) throw Object.assign(new Blocked("passkey_not_fresh"), { claims });
  if (a.expectedSub !== null && (c.iss !== a.expectedIss || c.sub !== a.expectedSub)) throw Object.assign(new Blocked("wrong_account"), { claims });
  return claims;
}
