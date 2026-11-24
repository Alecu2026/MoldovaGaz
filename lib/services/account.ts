import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { ObjectId } from "mongodb";
import { actorOf } from "../audit-actor";
import { esc, appUrl, mailConfigured, sendMail } from "../mailer";
import { passwordProblem } from "../password-rules";
import { hashPassword, verifyPassword } from "../password";
import { clearFails, hit, isBlocked, recordFail } from "../rate-limit";
import { forgetUser, revokeSessions, viewerOf, type SessionUser, type UserDoc } from "../session";
import { COLLECTIONS, col, getDb } from "../mongo";
import { logAudit, logAuditOnce } from "./audit";

/**
 * Contul propriu: schimbarea parolei (pagina Securitate) și «Ai uitat parola?» prin e-mail (SMTP).
 *
 * Resetarea: un token aleatoriu de 256 de biți merge în e-mail, iar în baza de date stă doar hash-ul lui (colecția `password_resets`, ștearsă singură după expirare, 60 de minute).
 * Un singur link valabil pe cont (unul nou îl anulează pe cel vechi), de unică folosință; după resetare toate sesiunile contului se închid. Răspunsul la cerere e MEREU același, indiferent
 * dacă adresa există (nu se poate afla ce conturi există), cu limitare: 3 cereri / 15 min pentru o adresă și 10 / 15 min de la un IP. Parolele nu intră niciodată în jurnalul de audit.
 */
export const RESETS = "password_resets";
const TTL_MS = 60 * 60_000;
type Reset = { _id: string; userId: string; email: string; createdAt: Date; expiresAt: Date; ip: string | null };
const hashToken = (t: string) => createHash("sha256").update(t).digest("hex");
const EMAIL = /^[^\s@]{1,100}@[^\s@]{1,150}\.[^\s@]{2,40}$/;

let idx: Promise<unknown> | null = null;
async function resets() {
  const db = await getDb();
  idx ??= db.collection(RESETS).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }).catch(() => { idx = null; });
  await idx;
  return db.collection<Reset>(RESETS);
}

export type ResetRequest = { ok: true } | { ok: false; error: string; status: number };

function mailBody(link: string, name: string): { subject: string; text: string; html: string } {
  const subject = "Resetarea parolei — Moldovagaz";
  const text = `Bună, ${name}!\n\nAi cerut resetarea parolei pentru contul tău Moldovagaz. Deschide linkul de mai jos și alege o parolă nouă (valabil 60 de minute, o singură dată):\n\n${link}\n\nDacă nu ai cerut tu asta, ignoră mesajul: parola ta rămâne neschimbată.\n`;
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;color:#121c2b;max-width:520px"><h2 style="margin:0 0 12px">Resetarea parolei</h2><p>Bună, ${esc(name)}!</p><p>Ai cerut resetarea parolei pentru contul tău Moldovagaz. Apasă butonul și alege o parolă nouă (linkul e valabil <b>60 de minute</b> și se poate folosi <b>o singură dată</b>).</p><p style="margin:22px 0"><a href="${esc(link)}" style="background:#0b64c9;color:#fff;text-decoration:none;padding:11px 20px;border-radius:8px;display:inline-block">Alege o parolă nouă</a></p><p style="color:#5b697d;font-size:13px">Dacă butonul nu merge, copiază adresa în browser:<br><span style="word-break:break-all">${esc(link)}</span></p><p style="color:#5b697d;font-size:13px">Dacă nu ai cerut tu asta, ignoră mesajul: parola ta rămâne neschimbată.</p></div>`;
  return { subject, text, html };
}

/** «Ai uitat parola?»: trimite linkul dacă adresa e a unui cont activ. Răspunde la fel în toate cazurile (în afară de configurare lipsă / limită depășită). */
export async function requestPasswordReset(emailRaw: string, ip: string | null, req?: Request): Promise<ResetRequest> {
  if (!mailConfigured()) return { ok: false, error: "Trimiterea de e-mailuri nu este configurată pe server. Cere unui administrator să-ți schimbe parola.", status: 503 };
  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) return { ok: false, error: "Introdu o adresă de e-mail validă.", status: 400 };
  if (!hit(`fp-ip|${ip ?? "?"}`, 10, 15 * 60_000) || !hit(`fp-em|${email}`, 3, 15 * 60_000)) {
    await logAuditOnce(`fp-limit|${email}`, 60_000, null, { action: "auth.password_reset_request", ok: false, req, anonName: email, objectName: email, extra: [{ label: "Motiv", value: "prea multe cereri (limita depășită)" }] });
    return { ok: false, error: "Prea multe cereri. Încearcă din nou peste câteva minute.", status: 429 };
  }
  const user = await (await col<UserDoc>(COLLECTIONS.users)).findOne({ email });
  if (!user || user.disabled) {
    await logAudit(null, { action: "auth.password_reset_request", ok: false, req, anonName: email, objectName: email, extra: [{ label: "Motiv", value: user ? "cont dezactivat — nu s-a trimis nimic" : "cont inexistent — nu s-a trimis nimic" }] });
    return { ok: true };
  }
  const token = randomBytes(32).toString("base64url");
  const c = await resets();
  await c.deleteMany({ userId: String(user._id) });
  await c.insertOne({ _id: hashToken(token), userId: String(user._id), email, createdAt: new Date(), expiresAt: new Date(Date.now() + TTL_MS), ip });
  try {
    const m = mailBody(`${appUrl()}/reset-parola?token=${token}`, user.name || email);
    await sendMail({ to: email, ...m });
    await logAudit({ id: String(user._id), name: user.name || email, email, admin: viewerOf(user).admin }, { action: "auth.password_reset_request", req, objectName: email, extra: [{ label: "Link valabil", value: "60 de minute, o singură dată" }] });
  } catch (e) {
    await c.deleteOne({ _id: hashToken(token) });
    console.error("[parola] e-mailul de resetare nu a plecat:", (e as Error).message);
    await logAudit(null, { action: "auth.password_reset_request", ok: false, req, anonName: email, objectName: email, extra: [{ label: "Motiv", value: `e-mailul nu a putut fi trimis: ${(e as Error).message}` }] });
    return { ok: false, error: "Nu am putut trimite e-mailul acum. Încearcă mai târziu sau cere unui administrator să-ți schimbe parola.", status: 502 };
  }
  return { ok: true };
}

/** Linkul din e-mail e valid (există, nu a expirat, contul e activ)? Nu îl consumă. */
export async function checkResetToken(token: string): Promise<{ email: string } | null> {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return null;
  const d = await (await resets()).findOne({ _id: hashToken(token) });
  if (!d || d.expiresAt.getTime() < Date.now()) return null;
  const u = ObjectId.isValid(d.userId) ? await (await col<UserDoc>(COLLECTIONS.users)).findOne({ _id: new ObjectId(d.userId) }, { projection: { disabled: 1 } }) : null;
  return u && !u.disabled ? { email: d.email } : null;
}

/** Alege parola nouă cu linkul din e-mail: parola se schimbă, linkul se consumă, toate sesiunile contului se închid. */
export async function completePasswordReset(token: string, password: string, ip: string | null, req?: Request): Promise<{ ok: true } | { ok: false; error: string; status: number }> {
  if (!hit(`rs-ip|${ip ?? "?"}`, 20, 15 * 60_000)) return { ok: false, error: "Prea multe încercări. Încearcă din nou peste câteva minute.", status: 429 };
  const t = await checkResetToken(token);
  if (!t) return { ok: false, error: "Linkul nu mai este valabil (a expirat sau a fost deja folosit). Cere unul nou de la «Ai uitat parola?».", status: 410 };
  const problem = passwordProblem(password, { email: t.email });
  if (problem) return { ok: false, error: problem, status: 400 };
  const c = await resets();
  const used = await c.findOneAndDelete({ _id: hashToken(token) }); // unică folosință, chiar dacă două cereri vin deodată
  if (!used) return { ok: false, error: "Linkul a fost deja folosit.", status: 410 };
  const users = await col<UserDoc>(COLLECTIONS.users);
  const u = await users.findOne({ _id: new ObjectId(used.userId) });
  if (!u || u.disabled) return { ok: false, error: "Contul nu este activ.", status: 403 };
  await users.updateOne({ _id: u._id }, { $set: { passwordHash: await hashPassword(password), updatedAt: new Date() } });
  await c.deleteMany({ userId: used.userId });
  await (await col(COLLECTIONS.sessions)).deleteMany({ $or: [{ userId: used.userId }, { impersonatorId: used.userId }] });
  forgetUser(used.userId);
  clearFails(`pw|${used.userId}`);
  await logAudit({ id: String(u._id), name: u.name || u.email, email: u.email, admin: viewerOf(u).admin }, { action: "auth.password_reset", req, objectName: u.email, extra: [{ label: "Notă", value: "Valoarea parolei nu se păstrează. Toate sesiunile contului au fost închise." }] });
  return { ok: true };
}

/** Schimbarea parolei proprii (pagina Securitate): cere parola veche; celelalte sesiuni se închid, cea curentă rămâne. */
export async function changeOwnPassword(user: SessionUser, current: string, next: string, currentToken: string | undefined, req?: Request): Promise<{ ok: true; closed: number } | { ok: false; error: string; status: number }> {
  if (user.impersonation) return { ok: false, error: "Indisponibil în simulare de login.", status: 403 };
  const key = `pw|${user.id}`;
  if (isBlocked(key)) return { ok: false, error: "Prea multe încercări cu parola veche greșită. Încearcă din nou peste câteva minute.", status: 429 };
  const users = await col<UserDoc>(COLLECTIONS.users);
  const u = await users.findOne({ _id: new ObjectId(user.id) });
  if (!u) return { ok: false, error: "Contul nu există.", status: 404 };
  if (!(await verifyPassword(current, u.passwordHash))) {
    recordFail(key);
    await logAudit(actorOf(user), { action: "auth.password_change", ok: false, req, objectName: user.email, extra: [{ label: "Motiv", value: "parola veche introdusă greșit" }] });
    return { ok: false, error: "Parola veche nu este corectă.", status: 400 };
  }
  const problem = passwordProblem(next, { email: user.email, current });
  if (problem) return { ok: false, error: problem, status: 400 };
  clearFails(key);
  await users.updateOne({ _id: u._id }, { $set: { passwordHash: await hashPassword(next), updatedAt: new Date() } });
  const closed = await revokeSessions(user.id, { keepToken: currentToken });
  await logAudit(actorOf(user), { action: "auth.password_change", req, objectName: user.email, extra: [{ label: "Sesiuni închise", value: `${closed} (cea curentă a rămas)` }, { label: "Notă", value: "Valoarea parolei nu se păstrează." }] });
  return { ok: true, closed };
}
