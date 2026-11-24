import "server-only";
import { cookies, headers } from "next/headers";
import { ObjectId } from "mongodb";
import { actorOf } from "../audit-actor";
import { canImpersonate, IMPERSONATION_TTL_MS, ORIG_SESSION_COOKIE } from "../impersonation";
import { COLLECTIONS, col } from "../mongo";
import { SESSION_COOKIE, SESSION_DAYS, createImpersonationSession, deleteSessionByToken, findSessionByToken, viewerOf, type SessionUser, type UserDoc } from "../session";
import { can } from "../access";
import { logAudit } from "./audit";

/**
 * Simulare de login: sesiunea proprie rămâne neatinsă (tokenul ei se mută în cookie-ul `mg_session_orig`), iar în `mg_session` intră o sesiune NOUĂ a contului simulat,
 * cu `impersonatorId`, care expiră FIX după 6 ore (fără prelungire; cookie-ul dispare odată cu ea). La ieșire sesiunea simulată se șterge și tokenul propriu revine în
 * `mg_session` — nu trebuie să te autentifici din nou; la expirare, proxy.ts face aceeași mutare singur. Ambele capete (intrare / ieșire) rămân în jurnalul de audit,
 * iar tot ce se face în simulare apare acolo ca «<cont> (simulat de <tu>)». Cât ține simularea: fără modificări la conturi, fără altă simulare, fără notificări push.
 */
export type ImpResult = { ok: true; to: string } | { ok: false; error: string; status: number };

async function cookieBase() {
  const h = await headers();
  const https = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https" || (h.get("origin") ?? "").startsWith("https://");
  return { httpOnly: true, sameSite: "lax" as const, path: "/", secure: process.env.NODE_ENV === "production" && https && !process.env.INSECURE_COOKIES };
}

export async function startImpersonation(actor: SessionUser, targetId: string): Promise<ImpResult> {
  if (!ObjectId.isValid(targetId)) return { ok: false, error: "Utilizator invalid.", status: 400 };
  const users = await col<UserDoc>(COLLECTIONS.users);
  const t = await users.findOne({ _id: new ObjectId(targetId) }, { projection: { passwordHash: 0 } });
  if (!t) return { ok: false, error: "Utilizatorul nu există.", status: 404 };
  const v = viewerOf(t);
  const r = canImpersonate(actor, can(actor, "users", "impersonate"), { id: String(t._id), admin: v.admin, disabled: !!t.disabled, access: v.access });
  if (!r.ok) {
    await logAudit(actorOf(actor), { action: "auth.impersonate_start", ok: false, objectId: String(t._id), objectName: t.email, extra: [{ label: "Motiv", value: r.reason }] });
    return { ok: false, error: r.reason, status: r.status };
  }
  const jar = await cookies();
  const own = jar.get(SESSION_COOKIE)?.value;
  const ownDoc = own ? await findSessionByToken(own) : null;
  if (!own || !ownDoc || ownDoc.userId !== actor.id) return { ok: false, error: "Sesiune invalidă. Autentifică-te din nou.", status: 401 };
  const expires = new Date(Date.now() + IMPERSONATION_TTL_MS);
  const token = await createImpersonationSession(String(t._id), actor.id, expires);
  const base = await cookieBase();
  jar.set(ORIG_SESSION_COOKIE, own, { ...base, maxAge: SESSION_DAYS * 86_400 });
  jar.set(SESSION_COOKIE, token, { ...base, expires });
  await logAudit(actorOf(actor), { action: "auth.impersonate_start", objectId: String(t._id), objectName: t.email, extra: [{ label: "Cont simulat", value: `${t.name ?? t.email} (${v.admin ? "administrator" : "limitat"})` }, { label: "Expiră la", value: expires.toISOString() }, { label: "Durată", value: "6 ore, fără prelungire" }] });
  return { ok: true, to: "/" };
}

/** Ieșire din simulare: sesiunea simulată se șterge, cea proprie revine; dacă aceasta nu mai e validă, la autentificare. */
export async function exitImpersonation(): Promise<ImpResult> {
  const jar = await cookies();
  const cur = jar.get(SESSION_COOKIE)?.value;
  const doc = cur ? await findSessionByToken(cur) : null;
  if (doc && !doc.impersonatorId) return { ok: false, error: "Nu ești într-o simulare de login.", status: 400 };
  if (cur) await deleteSessionByToken(cur).catch(() => undefined);
  const base = await cookieBase();
  const orig = jar.get(ORIG_SESSION_COOKIE)?.value;
  const origDoc = orig ? await findSessionByToken(orig) : null;
  jar.delete(ORIG_SESSION_COOKIE);
  const byId = doc?.impersonatorId ?? origDoc?.userId;
  const by = byId && ObjectId.isValid(byId) ? await (await col<UserDoc>(COLLECTIONS.users)).findOne({ _id: new ObjectId(byId) }) : null;
  const target = doc && ObjectId.isValid(doc.userId) ? await (await col<UserDoc>(COLLECTIONS.users)).findOne({ _id: new ObjectId(doc.userId) }) : null;
  if (by) await logAudit({ id: String(by._id), name: by.name || by.email, email: by.email, admin: viewerOf(by).admin }, { action: "auth.impersonate_end", objectId: doc?.userId ?? null, objectName: target?.email ?? null, extra: doc ? [{ label: "A durat", value: `${Math.round((Date.now() - doc.createdAt.getTime()) / 60_000)} min` }] : [] });
  if (orig && origDoc && origDoc.expiresAt.getTime() > Date.now() && (!doc?.impersonatorId || origDoc.userId === doc.impersonatorId) && by && !by.disabled) {
    jar.set(SESSION_COOKIE, orig, { ...base, expires: origDoc.expiresAt });
    return { ok: true, to: "/utilizatori" };
  }
  jar.delete(SESSION_COOKIE);
  return { ok: true, to: "/login" };
}
