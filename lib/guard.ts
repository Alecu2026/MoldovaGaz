import "server-only";
import { getCurrentUser } from "./dal";
import { canPage, type PageKey } from "./access";
import { meterAllowed } from "./services/meter-dataset";
import type { SessionUser } from "./session";

/**
 * Verificările de acces pentru API-uri (răspund cu JSON, nu cu redirect).
 *  - 401: nu e autentificat; 403: autentificat, dar nu are dreptul (pagina nu e bifată la el, sau contorul nu e în zona lui).
 *  - „admin”: doar administratorii (paginile de administrare); „meters” / „installer”: pagina bifată la utilizator.
 */
export type Guard = { user: SessionUser } | { res: Response };
const NO_LOGIN = () => Response.json({ error: "Autentificare necesară." }, { status: 401 });
const FORBIDDEN = () => Response.json({ error: "Nu ai acces la aceste date." }, { status: 403 });

export async function apiGuard(need: PageKey | "admin" | "any"): Promise<Guard> {
  const user = await getCurrentUser();
  if (!user) return { res: NO_LOGIN() };
  const ok = need === "admin" ? user.admin : need === "any" ? user.admin || user.access.pages.length > 0 : canPage(user, need);
  return ok ? { user } : { res: FORBIDDEN() };
}

/** Ca `apiGuard`, plus: contorul trebuie să fie în zona utilizatorului. */
export async function apiMeterGuard(need: PageKey | "any", id: string): Promise<Guard> {
  const g = await apiGuard(need);
  if ("res" in g) return g;
  return (await meterAllowed(g.user, id)) ? g : { res: FORBIDDEN() };
}
