// identity: one swap point for "prove you are one real person". World IdP in production; a clearly
// labelled dev stand-in until World access is sorted. Switch with IDENTITY=world|dev; nothing else changes.
import { createHash } from "node:crypto";
import type * as oidc from "openid-client";
import { finishCheck, newAttempt, startCheck, worldConfig, type Attempt } from "../world/oidc.js";

export type { Attempt };
export { newAttempt };

/** What a successful check proves: this (iss, sub) passed a check at authTime. */
export type Proof = { iss: string; sub: string; authTime: number; provider: "world" | "dev"; acr?: string };

export interface IdentityProvider {
  name: "world" | "dev";
  /** Where to send the browser to run the check. */
  start(a: Attempt, redirectUri: string): Promise<string>;
  /** Validates the callback. Throws on anything off: wrong state, stale check, wrong person. */
  finish(callbackUrl: URL, a: Attempt): Promise<Proof>;
}

export function worldIdentity(): IdentityProvider {
  let config: Promise<oidc.Configuration> | null = null;
  const cfg = () => (config ??= worldConfig().catch(e => { config = null; throw e; }));
  return {
    name: "world",
    start: async (a, redirectUri) => startCheck(await cfg(), redirectUri, a),
    async finish(url, a) {
      const c = await finishCheck(await cfg(), url, a);
      return { iss: c.iss, sub: c.sub, authTime: c.authTime!, acr: c.acr, provider: "world" };
    },
  };
}

export const DEV_ISSUER = "dev:local";

/**
 * Proves nothing about personhood: it exists so the app can be built and tried before World access works.
 * A name maps to the same person each time, so a tester can come back; a re-check returns the signed-in person.
 */
export function devIdentity(base: string): IdentityProvider {
  return {
    name: "dev",
    start: async a => `${base}/api/auth/dev?state=${encodeURIComponent(a.state)}${a.expectedSub ? "&recheck=1" : ""}`,
    async finish(url, a) {
      if (url.searchParams.get("iss") !== DEV_ISSUER) throw new Error("iss_mismatch");
      const name = (url.searchParams.get("dev_name") ?? "").trim().toLowerCase().slice(0, 64);
      const sub = a.expectedSub ?? `dev-${createHash("sha256").update(name || crypto.randomUUID()).digest("hex").slice(0, 24)}`;
      return { iss: DEV_ISSUER, sub, authTime: Math.floor(Date.now() / 1000), provider: "dev" };
    },
  };
}

export function identityFromEnv(base: string): IdentityProvider {
  const which = process.env.IDENTITY ?? "dev";
  if (which === "world") return worldIdentity();
  if (which === "dev") return devIdentity(base);
  throw new Error(`IDENTITY must be world or dev, got ${which}`);
}
