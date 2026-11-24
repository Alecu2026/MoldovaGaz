/**
 * Cine ce poate vedea (partea comună client + server, fără importuri de server).
 *
 *  - Administrator = contul cu rolul `super_admin`: vede tot și administrează utilizatorii.
 *  - Ceilalți utilizatori sunt LIMITAȚI: văd doar paginile bifate la ei (`pages`) și doar contoarele din zona bifată (pagina «Instalator antene» nu depinde de zonă: antenele nu aparțin unei filiale):
 *      · `branches` = filiale întregi (cod FIL, ex. „05”);
 *      · `cities`   = orașe dintr-o filială, ca „05|Comrat” (orașul din facturare; „—” = contoare fără oraș).
 *    Un cont fără nimic bifat nu vede nimic.
 *  - Paginile de administrare (Consum nemăsurat, Integrare, Rapoarte, Dispozitive LoRaWAN, Facturare, Utilizatori) sunt doar pentru administratori.
 */
export const ADMIN_ROLE = "super_admin";
export const NO_CITY = "—";

export type PageKey = "meters" | "installer" | "antennas";
export const PAGES: { key: PageKey; label: string; path: string }[] = [
  { key: "meters", label: "Contoare, hartă și grafice", path: "/" },
  { key: "installer", label: "Instalator", path: "/instalator" },
  { key: "antennas", label: "Instalator antene", path: "/antene" },
];

export type Access = { pages: PageKey[]; branches: string[]; cities: string[] };
export type Viewer = { admin: boolean; access: Access };
export const NO_ACCESS: Access = { pages: [], branches: [], cities: [] };

/** codul filialei dintr-o etichetă „05 · Comrat” (sau dintr-un cod „05”) */
export const filOf = (br: string): string => String(br ?? "").split(" · ")[0].trim();
export const cityKey = (fil: string, city: string): string => `${fil}|${city}`;

export function canPage(v: Viewer, page: PageKey): boolean {
  return v.admin || v.access.pages.includes(page);
}
/** prima pagină permisă (pentru redirect după autentificare), sau null */
export function firstPath(v: Viewer): string | null {
  if (v.admin) return "/";
  const p = PAGES.find((x) => v.access.pages.includes(x.key));
  return p ? p.path : null;
}

/** Contorul (filiala = eticheta din `br`, orașul din `ct`) intră în zona utilizatorului? */
export function allowsMeter(v: Viewer, br: string, ct: string): boolean {
  if (v.admin) return true;
  const fil = filOf(br);
  if (!fil) return false;
  return v.access.branches.includes(fil) || v.access.cities.includes(cityKey(fil, ct || NO_CITY));
}

/** cheie stabilă pentru zona unui utilizator (aceeași zonă ⇒ aceeași cheie ⇒ aceleași liste în memorie) */
export function scopeKey(v: Viewer): string {
  if (v.admin) return "";
  return `${[...v.access.branches].sort().join(",")}#${[...v.access.cities].sort().join(",")}`;
}

/** Validează și curăță ce vine de la client (la creare / modificare utilizator). */
export function cleanAccess(raw: unknown): { access: Access } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Drepturi invalide." };
  const b = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
  const pages = arr(b.pages), branches = arr(b.branches), cities = arr(b.cities);
  if (!pages || !branches || !cities) return { error: "Drepturi invalide." };
  if (branches.length > 100 || cities.length > 5000) return { error: "Prea multe elemente bifate." };
  const okPages = [...new Set(pages)].filter((p): p is PageKey => PAGES.some((x) => x.key === p));
  const okBranches = [...new Set(branches.map((x) => x.trim()))].filter((x) => /^\d{1,3}$/.test(x));
  const okCities = [...new Set(cities)].filter((x) => /^\d{1,3}\|.{1,80}$/.test(x) && !x.includes("\n"));
  // un oraș dintr-o filială deja bifată întreagă nu mai are sens separat
  const cityOnly = okCities.filter((c) => !okBranches.includes(c.split("|")[0]));
  return { access: { pages: okPages, branches: okBranches, cities: cityOnly } };
}
