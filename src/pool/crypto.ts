// crypto: one random AES-256-GCM key per person, wrapped by POOL_KEK.
// The AAD binds each record to (person, day, group), so a blob copied onto another row fails to open.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALG = "aes-256-gcm";

export function poolKek(b64 = process.env.POOL_KEK): Buffer {
  const k = b64 ? Buffer.from(b64, "base64") : null;
  if (!k || k.length !== 32) throw new Error("POOL_KEK must be 32 bytes, base64");
  return k;
}

function seal(key: Buffer, plain: Buffer, aad: string) {
  const iv = randomBytes(12);
  const c = createCipheriv(ALG, key, iv).setAAD(Buffer.from(aad));
  const blob = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
  return { iv, blob };
}

function open(key: Buffer, iv: Uint8Array, blob: Uint8Array, aad: string): Buffer {
  const b = Buffer.from(blob);
  const d = createDecipheriv(ALG, key, Buffer.from(iv)).setAAD(Buffer.from(aad));
  d.setAuthTag(b.subarray(b.length - 16));
  return Buffer.concat([d.update(b.subarray(0, b.length - 16)), d.final()]);
}

/** Returns iv || ciphertext || tag in one buffer, bound to the person's id. */
export function wrapPersonKey(kek: Buffer, personId: string) {
  const key = randomBytes(32);
  const { iv, blob } = seal(kek, key, `key:${personId}`);
  return { key, wrapped: Buffer.concat([iv, blob]) };
}

export function unwrapPersonKey(kek: Buffer, personId: string, wrapped: Uint8Array): Buffer {
  const w = Buffer.from(wrapped);
  return open(kek, w.subarray(0, 12), w.subarray(12), `key:${personId}`);
}

const recordAad = (personId: string, day: string, grp: string) => `rec:${personId}:${day}:${grp}`;

export function sealRecord(key: Buffer, personId: string, day: string, grp: string, values: Record<string, number>) {
  return seal(key, Buffer.from(JSON.stringify(values)), recordAad(personId, day, grp));
}

export function openRecord(key: Buffer, personId: string, day: string, grp: string, iv: Uint8Array, blob: Uint8Array): Record<string, number> {
  return JSON.parse(open(key, iv, blob, recordAad(personId, day, grp)).toString("utf8"));
}
