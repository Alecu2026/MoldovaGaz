import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Cheile LoRaWAN (APPKEY / APPSKEY / NWKSKEY) se păstrează în baza noastră DOAR criptate (AES-256-GCM), cu un secret care stă în mediu (LORAWAN_KEY_SECRET în .env.local),
 * nu în baza de date: o copie a bazei nu dezvăluie cheile. Format: v1.<iv>.<tag>.<text criptat> (base64url).
 */
const key = (secret: string): Buffer => createHash("sha256").update(`moldovagaz-lorawan|${secret}`).digest();
export const secretOk = (s: string | undefined): s is string => typeof s === "string" && s.length >= 24;

export function encryptJson(value: unknown, secret: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(secret), iv);
  const ct = Buffer.concat([c.update(JSON.stringify(value), "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}
export function decryptJson<T>(blob: string, secret: string): T {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Format necunoscut.");
  const d = createDecipheriv("aes-256-gcm", key(secret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8")) as T;
}
