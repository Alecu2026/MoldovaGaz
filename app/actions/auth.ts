"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { hashPassword, verifyPassword } from "@/lib/password";
import { clearFails, isBlocked, recordFail } from "@/lib/rate-limit";
import { ADMIN_ROLE } from "@/lib/access";
import { getCurrentUser } from "@/lib/dal";
import { actorOf } from "@/lib/audit-actor";
import { logAudit, logAuditOnce } from "@/lib/services/audit";
import { exitImpersonation } from "@/lib/services/impersonation";
import { SESSION_COOKIE, SESSION_DAYS, createSession, destroySession, findUserByEmail } from "@/lib/session";

export type LoginState = { error?: string; email?: string } | null;

let dummyHash: Promise<string> | null = null;

export async function loginAction(_prev: LoginState, form: FormData): Promise<LoginState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  const password = String(form.get("password") ?? "");
  if (!email || !password) return { error: "Introdu emailul și parola.", email };
  if (email.length > 254 || password.length > 200) return { error: "Email sau parolă incorecte.", email };

  const h = await headers();
  const ip = h.get("x-forwarded-for")?.split(",")[0]?.trim() || h.get("x-real-ip") || "local";
  const key = `${ip}|${email}`;
  if (isBlocked(key)) {
    await logAuditOnce(`blocked|${key}`, 60_000, null, { action: "auth.login_blocked", ok: false, anonName: email, objectName: email, extra: [{ label: "Motiv", value: "prea multe încercări eșuate de la aceeași adresă pentru același cont" }] });
    return { error: "Prea multe încercări eșuate. Încearcă din nou peste câteva minute.", email };
  }

  const user = await findUserByEmail(email);
  // și când contul nu există calculăm un hash, ca timpul de răspuns să nu arate dacă emailul e înregistrat
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await (dummyHash ??= hashPassword("dummy"))), false);
  if (!user || !ok || user.disabled) {
    recordFail(key);
    await logAuditOnce(`fail|${key}|${Math.floor(Date.now() / 5000)}`, 5000, null, { action: "auth.login_failed", ok: false, anonName: email, objectName: email, extra: [{ label: "Motiv", value: !user ? "cont inexistent" : user.disabled ? "cont dezactivat" : "parolă greșită" }] });
    return { error: "Email sau parolă incorecte.", email };
  }
  clearFails(key);

  const { token, expires } = await createSession(String(user._id), { ua: h.get("user-agent"), ip });
  await logAudit({ id: String(user._id), name: user.name || user.email, email: user.email, admin: user.role === ADMIN_ROLE }, { action: "auth.login", objectName: user.email });
  // Secure doar când cererea vine pe HTTPS (Origin-ul trimis de browser sau X-Forwarded-Proto de la proxy): pe HTTP simplu, ex. IP din LAN, browserul ar refuza cookie-ul Secure
  const https = (h.get("x-forwarded-proto") ?? "").split(",")[0].trim() === "https" || (h.get("origin") ?? "").startsWith("https://");
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && https && !process.env.INSECURE_COOKIES,
    path: "/",
    expires,
    maxAge: SESSION_DAYS * 86_400,
  });
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  const me = token ? await getCurrentUser().catch(() => null) : null;
  // în simulare «Ieșire» înseamnă ieșirea din simulare (te întorci în contul tău), nu delogarea contului simulat
  if (me?.impersonation) { const r = await exitImpersonation(); redirect(r.ok ? r.to : "/login"); }
  if (me) await logAudit(actorOf(me), { action: "auth.logout", objectName: me.email });
  if (token) await destroySession(token).catch(() => {});
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
