import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { SESSION_COOKIE, validateSession, type SessionUser } from "./session";

/** Data Access Layer: SINGURUL loc care răspunde la „cine e utilizatorul?”. Proxy-ul face doar o verificare optimistă (prezența cookie-ului). */
export const getCurrentUser = cache(async (): Promise<SessionUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return null;
  // validarea sesiunii citește ceasul (expirare) și baza de date: doar la cererea reală, niciodată în prerandare
  await connection();
  return validateSession(token);
});

export async function requireUser(): Promise<SessionUser> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return user;
}
