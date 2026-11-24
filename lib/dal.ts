import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { can, firstPath, pathOf, type Action, type PageKey } from "./access";
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

/**
 * Pagini: utilizatorul trebuie să aibă dreptul la pagină (vizualizare; „admin” = doar administratorii). Restul acțiunilor (editare, ștergere…) se verifică la API-uri și se transmit paginii prin `can`.
 * Fără drept: merge la prima pagină permisă lui sau, dacă n-are niciuna, la /acces.
 */
export async function requirePage(need: PageKey | "admin", action: Action = "view"): Promise<SessionUser> {
  const user = await requireUser();
  if (need === "admin" ? user.admin : can(user, need, action)) return user;
  const to = firstPath(user);
  redirect(to && to !== (need === "admin" ? "/" : pathOf(need)) ? to : "/acces");
}
