import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { COLLECTIONS, col } from "./mongo";

/**
 * Sesiuni în baza de date: în cookie stă un token aleatoriu, în DB doar hash-ul lui (un dump al bazei nu dă sesiuni valide).
 * Validările recente se țin 30 s în memorie — API-ul de date e interogat des (polling) și nu trebuie să lovească DB-ul de fiecare dată.
 */
export const SESSION_COOKIE = "mg_session";
export const SESSION_DAYS = 14;
const CACHE_MS = 30_000;

export type SessionUser = { id: string; email: string; name: string };
type UserDoc = { _id: ObjectId; email: string; name?: string; passwordHash: string; disabled?: boolean };
type SessionDoc = { tokenHash: string; userId: string; createdAt: Date; expiresAt: Date };

const g = globalThis as unknown as { __sessCache?: Map<string, { user: SessionUser; until: number }> };
const cache = (g.__sessCache ??= new Map());

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

export async function findUserByEmail(email: string): Promise<UserDoc | null> {
  return (await col<UserDoc>(COLLECTIONS.users)).findOne({ email });
}

export async function createSession(userId: string): Promise<{ token: string; expires: Date }> {
  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const expires = new Date(now.getTime() + SESSION_DAYS * 86_400_000);
  await (await col<SessionDoc>(COLLECTIONS.sessions)).insertOne({ tokenHash: hashToken(token), userId, createdAt: now, expiresAt: expires });
  return { token, expires };
}

export async function validateSession(token: string): Promise<SessionUser | null> {
  const th = hashToken(token);
  const hit = cache.get(th);
  if (hit && hit.until > Date.now()) return hit.user;
  cache.delete(th);
  const s = await (await col<SessionDoc>(COLLECTIONS.sessions)).findOne({ tokenHash: th, expiresAt: { $gt: new Date() } });
  if (!s || !ObjectId.isValid(s.userId)) return null;
  const u = await (await col<UserDoc>(COLLECTIONS.users)).findOne({ _id: new ObjectId(s.userId) });
  if (!u || u.disabled) return null;
  const user: SessionUser = { id: String(u._id), email: u.email, name: u.name || u.email };
  cache.set(th, { user, until: Date.now() + CACHE_MS });
  if (cache.size > 500) for (const [k, v] of cache) if (v.until < Date.now()) cache.delete(k);
  return user;
}

export async function destroySession(token: string): Promise<void> {
  const th = hashToken(token);
  cache.delete(th);
  await (await col<SessionDoc>(COLLECTIONS.sessions)).deleteOne({ tokenHash: th });
}
