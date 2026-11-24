import type { SessionUser } from "./session";
import type { AuditActor } from "./services/audit";

/** Utilizatorul din sesiune, în forma din jurnal (numele și e-mailul de acum, ca să rămână în jurnal chiar dacă contul se șterge sau se redenumește). */
export const actorOf = (u: Pick<SessionUser, "id" | "name" | "email" | "admin"> & { impersonation?: { byId: string; byName: string; byEmail: string } }): AuditActor => ({ id: u.id, name: u.name, email: u.email, admin: u.admin, ...(u.impersonation ? { sim: { id: u.impersonation.byId, name: u.impersonation.byName, email: u.impersonation.byEmail } } : {}) });
