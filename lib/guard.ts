import "server-only";
import { getCurrentUser } from "./dal";
import { can, canSeeMeters, hasAnyPage, type Action, type PageKey } from "./access";
import { meterAllowed } from "./services/meter-dataset";
import { actorOf } from "./audit-actor";
import { logDenied } from "./services/audit";
import type { SessionUser } from "./session";

/**
 * Verificările de acces pentru API-uri (răspund cu JSON, nu cu redirect).
 *  - 401: nu e autentificat; 403: autentificat, dar nu are dreptul (pagina nu e bifată la el, sau contorul nu e în zona lui).
 *  - Dreptul se cere pe pagină ȘI acțiune (matricea din lib/access.ts): apiGuard("reports", "delete"); fără acțiune = „view” (citire).
 *  - „admin”: doar administratorii; „any”: orice cont cu vreo pagină.
 */
export type Guard = { user: SessionUser } | { res: Response };
const NO_LOGIN = () => Response.json({ error: "Autentificare necesară." }, { status: 401 });
const FORBIDDEN = () => Response.json({ error: "Nu ai acces la aceste date." }, { status: 403 });

export async function apiGuard(need: PageKey | "admin" | "any", action: Action = "view"): Promise<Guard> {
  const user = await getCurrentUser();
  if (!user) return { res: NO_LOGIN() };
  const ok = need === "admin" ? user.admin : need === "any" ? hasAnyPage(user) : can(user, need, action);
  // în simulare de login conturile nu se modifică (nici drepturi, nici parole, nici alte simulări)
  const simBlocked = ok && !!user.impersonation && need === "users" && action !== "view";
  if (!ok || simBlocked) void logDenied(actorOf(user), need, simBlocked ? `${action} (în simulare de login)` : action); // în jurnalul de audit (cel mult o dată pe minut pentru aceeași cerere)
  return ok && !simBlocked ? { user } : { res: simBlocked ? Response.json({ error: "Indisponibil în simulare de login." }, { status: 403 }) : FORBIDDEN() };
}

/** Ca `apiGuard`, plus: contorul trebuie să fie în zona utilizatorului („any” = orice pagină cu contoare: Contoare sau Instalator). */
export async function apiMeterGuard(need: PageKey | "any", id: string, action: Action = "view"): Promise<Guard> {
  const user = await getCurrentUser();
  if (!user) return { res: NO_LOGIN() };
  const ok = need === "any" ? canSeeMeters(user) : can(user, need, action);
  const allowed = ok && (await meterAllowed(user, id));
  if (!allowed) void logDenied(actorOf(user), need, ok ? `${action} (contor în afara zonei)` : action);
  return allowed ? { user } : { res: FORBIDDEN() };
}
