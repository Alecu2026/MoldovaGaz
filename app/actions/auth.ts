"use server";

import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { hashPassword, verifyPassword } from "@/lib/password";
import { clearFails, isBlocked, recordFail } from "@/lib/rate-limit";
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
  if (isBlocked(key)) return { error: "Prea multe încercări eșuate. Încearcă din nou peste câteva minute.", email };

  const user = await findUserByEmail(email);
  // și când contul nu există calculăm un hash, ca timpul de răspuns să nu arate dacă emailul e înregistrat
  const ok = user ? await verifyPassword(password, user.passwordHash) : (await verifyPassword(password, await (dummyHash ??= hashPassword("dummy"))), false);
  if (!user || !ok || user.disabled) {
    recordFail(key);
    return { error: "Email sau parolă incorecte.", email };
  }
  clearFails(key);

  const { token, expires } = await createSession(String(user._id));
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
  if (token) await destroySession(token).catch(() => {});
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
