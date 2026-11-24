import { grantable, type Access, type Viewer } from "./access";

/**
 * Simulare de login: un cont intră în aplicație „ca” altul, ca să vadă exact ce vede el (pagini, zonă, butoane). Regulile (cine pe cine) sunt aici, fără importuri de server.
 *  • dreptul «Utilizatori → Simulare» (administratorii îl au implicit);
 *  • nu în propriul cont, nu într-un cont dezactivat, nu în timpul unei alte simulări;
 *  • administratorul poate intra în orice cont activ; ceilalți NU pot intra în conturi de administrator, iar un cont limitat se poate simula doar dacă drepturile lui
 *    (pagini, acțiuni, zonă) se încadrează în ale celui care simulează — altfel ar obține, prin simulare, drepturi pe care nu le are (vezi `grantable`).
 */
export const IMPERSONATION_HOURS = 6;
export const IMPERSONATION_TTL_MS = IMPERSONATION_HOURS * 3_600_000;
/** cookie-ul în care stă sesiunea proprie cât ține simularea */
export const ORIG_SESSION_COOKIE = "mg_session_orig";

export type ImpersonationInfo = { byId: string; byName: string; byEmail: string; expiresAt: number };
export type ImpActor = { id: string; admin: boolean; access: Access; impersonation?: ImpersonationInfo };
export type ImpTarget = { id: string; admin: boolean; disabled: boolean; access: Access };
export type CanResult = { ok: true } | { ok: false; reason: string; status: number };

export function canImpersonate(actor: ImpActor & Pick<Viewer, "admin">, hasRight: boolean, target: ImpTarget): CanResult {
  if (actor.impersonation) return { ok: false, reason: "Ieși mai întâi din simularea curentă.", status: 409 };
  if (!hasRight) return { ok: false, reason: "Nu ai dreptul de simulare de login.", status: 403 };
  if (target.id === actor.id) return { ok: false, reason: "Nu poți intra în propriul cont.", status: 400 };
  if (target.disabled) return { ok: false, reason: "Contul este dezactivat.", status: 409 };
  if (actor.admin) return { ok: true };
  if (target.admin) return { ok: false, reason: "Doar un administrator poate intra într-un cont de administrator.", status: 403 };
  if (!grantable({ admin: false, access: actor.access }, target.access)) return { ok: false, reason: "Contul are drepturi pe care tu nu le ai (poți intra doar în conturile cu drepturi mai mici sau egale).", status: 403 };
  return { ok: true };
}

/** «5 h 12 min» / «48 min» / «sub 1 min» */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "0 min";
  const min = Math.floor(ms / 60_000);
  if (min < 1) return "sub 1 min";
  const h = Math.floor(min / 60);
  return h > 0 ? `${h} h ${String(min % 60).padStart(2, "0")} min` : `${min} min`;
}
