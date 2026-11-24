import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { COLLECTIONS, col } from "./mongo";
import { viewerFromDoc, type Viewer } from "./access";
import type { ImpersonationInfo } from "./impersonation";
import { cleanNotify, type NotifyType } from "./notify";

/**
 * Sesiuni în baza de date: în cookie stă un token aleatoriu, în DB doar hash-ul lui (un dump al bazei nu dă sesiuni valide).
 * Validările recente se țin 30 s în memorie — API-ul de date e interogat des (polling) și nu trebuie să lovească DB-ul de fiecare dată.
 */
export const SESSION_COOKIE = "mg_session";
export const SESSION_DAYS = 14;
const CACHE_MS = 30_000;

export type SessionUser = Viewer & { id: string; email: string; name: string; /** tipurile de notificări pe care le primește */ notify: NotifyType[];
  /** setat doar în simulare de login: contul real care a intrat «ca» acesta, și până când ține simularea */ impersonation?: ImpersonationInfo };
export type UserDoc = { _id: ObjectId; email: string; name?: string; role?: string; access?: unknown; notify?: unknown; passwordHash: string; disabled?: boolean; createdAt?: Date; updatedAt?: Date };
type SessionDoc = { tokenHash: string; userId: string; createdAt: Date; expiresAt: Date; /** simulare de login: id-ul contului real */ impersonatorId?: string };

const g = globalThis as unknown as { __sessCache?: Map<string, { user: SessionUser; until: number }> };
const cache = (g.__sessCache ??= new Map());

const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");

/** Drepturile din documentul utilizatorului: administrator (rol super_admin) sau limitat la ce e bifat; fără nimic bifat = fără acces. */
export function viewerOf(u: Pick<UserDoc, "role" | "access">): Viewer {
  return viewerFromDoc(u);
}

/** Tipurile de notificări bifate la cont (necunoscutele se ignoră). */
export function notifyOf(u: Pick<UserDoc, "notify">): NotifyType[] {
  const c = cleanNotify(u.notify);
  return "notify" in c ? c.notify : [];
}

/** După o modificare a unui utilizator: sesiunile lui din memorie se citesc din nou la următoarea cerere (nu așteaptă cele 30 s). */
export function forgetUser(userId: string): void {
  for (const [k, v] of cache) if (v.user.id === userId) cache.delete(k);
}

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

/** Sesiune de simulare: contul `userId` văzut de `byId`; expiră FIX la `expires` (fără prelungire). */
export async function createImpersonationSession(userId: string, byId: string, expires: Date): Promise<string> {
  const token = randomBytes(32).toString("base64url");
  await (await col<SessionDoc>(COLLECTIONS.sessions)).insertOne({ tokenHash: hashToken(token), userId, createdAt: new Date(), expiresAt: expires, impersonatorId: byId });
  return token;
}
/** sesiunea unui token (pentru ieșirea din simulare / verificarea sesiunii proprii) */
export async function findSessionByToken(token: string): Promise<SessionDoc | null> {
  return (await col<SessionDoc>(COLLECTIONS.sessions)).findOne({ tokenHash: hashToken(token) });
}
export async function deleteSessionByToken(token: string): Promise<void> {
  cache.delete(hashToken(token));
  await (await col<SessionDoc>(COLLECTIONS.sessions)).deleteOne({ tokenHash: hashToken(token) });
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
  const user: SessionUser = { id: String(u._id), email: u.email, name: u.name || u.email, notify: notifyOf(u), ...viewerOf(u) };
  if (s.impersonatorId) {
    // simulare: contul real trebuie să existe și să fie activ, altfel simularea nu mai e valabilă
    const by = ObjectId.isValid(s.impersonatorId) ? await (await col<UserDoc>(COLLECTIONS.users)).findOne({ _id: new ObjectId(s.impersonatorId) }) : null;
    if (!by || by.disabled) return null;
    user.impersonation = { byId: String(by._id), byName: by.name || by.email, byEmail: by.email, expiresAt: s.expiresAt.getTime() };
  }
  cache.set(th, { user, until: Math.min(Date.now() + CACHE_MS, s.expiresAt.getTime()) });
  if (cache.size > 500) for (const [k, v] of cache) if (v.until < Date.now()) cache.delete(k);
  return user;
}

export async function destroySession(token: string): Promise<void> {
  const th = hashToken(token);
  cache.delete(th);
  await (await col<SessionDoc>(COLLECTIONS.sessions)).deleteOne({ tokenHash: th });
}
