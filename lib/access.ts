/**
 * Cine ce poate face (partea comună client + server, fără importuri de server).
 *
 *  - Administrator = contul cu rolul `super_admin`: face orice și vede tot.
 *  - Ceilalți utilizatori au drepturi pe fiecare pagină, SEPARAT pe acțiuni (matricea pagină × acțiune):
 *      · `view`   = vede pagina și datele ei (citire);
 *      · `edit`   = creează / modifică (numai unde pagina chiar are ce modifica);
 *      · `delete` = șterge;
 *      · `export` = descarcă fișiere (ex. raportul CSV);
 *      · `run`    = rulează procese care scriu în sisteme externe (ex. ChirpStack).
 *    Acțiunile se leagă logic: orice acțiune presupune `view`, iar `run` presupune și `edit` (se completează singure la validare).
 *  - Zona: ce CONTOARE vede (`branches` = filiale întregi, cod FIL ex. „05”; `cities` = orașe dintr-o filială, ca „05|Comrat”; „—” = contoare fără oraș)
 *    sau `allZones` = toate. Paginile care arată date din toate filialele (consum nemăsurat, integrare, rapoarte, LoRaWAN, facturare) cer `allZones`,
 *    altfel un utilizator limitat ar vedea în ele contoare din afara zonei lui.
 *  - Cine are dreptul la «Utilizatori» nu poate da altora mai mult decât are el (vezi `grantable`).
 *  - Un cont fără nimic bifat nu vede nimic.
 */
export const ADMIN_ROLE = "super_admin";
export const NO_CITY = "—";

export type Action = "view" | "edit" | "delete" | "export" | "run" | "impersonate";
export const ACTIONS: Action[] = ["view", "edit", "delete", "export", "run", "impersonate"];
export const ACTION_LABEL: Record<Action, string> = { view: "Vizualizare", edit: "Editare", delete: "Ștergere", export: "Descărcare", run: "Rulare", impersonate: "Simulare" };

export type PageKey = "meters" | "installer" | "antennas" | "antennaInfo" | "control" | "integration" | "reports" | "module" | "lorawan" | "billing" | "users" | "audit";
/** zone: „meters” = datele paginii sunt contoare filtrate după zona utilizatorului; „global” = date din toate filialele (cere «Toate filialele»); „none” = nu depinde de zonă */
export type PageDef = { key: PageKey; label: string; path: string; desc: string; zone: "meters" | "global" | "none"; actions: Partial<Record<Action, string>> };
export const PAGES: PageDef[] = [
  { key: "meters", label: "Contoare, hartă și grafice", path: "/", desc: "Lista contoarelor, harta, graficele, istoricul și poza fiecărui contor (doar din zona bifată).", zone: "meters",
    actions: { view: "Vede contoarele, harta, graficele, istoricul și pozele din zona lui" } },
  { key: "installer", label: "Instalator (montaj contoare)", path: "/instalator", desc: "Ecranul instalatorului: caută contorul, scanează QR, poză, locație, date de montaj.", zone: "meters",
    actions: { view: "Vede lista contoarelor și datele de montaj", edit: "Salvează date de montaj, locația și poza contorului" } },
  { key: "antennas", label: "Instalator antene", path: "/antene", desc: "Ecranul antenelor (gateway): tabel, poză, locație, instalator, hărți.", zone: "none",
    actions: { view: "Vede antenele, harta și mesajele pe zi", edit: "Salvează datele antenei, locația și poza" } },
  { key: "antennaInfo", label: "Antene: date și hartă", path: "/date-antene", desc: "Pagină separată cu datele fiecărei antene (activitate, contoare auzite, semnal, client, instalator) și harta lor.", zone: "global",
    actions: { view: "Vede datele fiecărei antene, contoarele auzite de ea și harta" } },
  { key: "control", label: "Consum nemăsurat", path: "/control", desc: "Contoare care noaptea nu înregistrează consum (indiciu de consum nemăsurat).", zone: "global",
    actions: { view: "Vede lista contoarelor suspecte și le filtrează după praguri" } },
  { key: "integration", label: "Integrare API", path: "/integration", desc: "Mesajele primite direct de la LoRaWAN / antene: stare, ritm, mesaje păstrate, verificare.", zone: "global",
    actions: { view: "Vede starea, statisticile, mesajele păstrate și verifică un mesaj (nu se salvează nimic)", edit: "Reia datele păstrate (le aplică în cutia de intrare)", delete: "Curăță datele păstrate și resetează contoarele de continuitate" } },
  { key: "reports", label: "Rapoarte (facturare)", path: "/rapoarte", desc: "Raportul de citiri către facturare: generare, descărcare CSV, ștergere.", zone: "global",
    actions: { view: "Vede lista rapoartelor generate", edit: "Generează rapoarte noi (și vede previzualizarea)", delete: "Șterge rapoarte", export: "Descarcă fișierul CSV al raportului" } },
  { key: "module", label: "Module LoRaWAN (ChirpStack)", path: "/module", desc: "Înregistrarea și activarea modulelor în ChirpStack, antene noi.", zone: "none",
    actions: { view: "Vede modulele și antenele din evidență", edit: "Adaugă module / antene și SIMULEAZĂ procesele (doar citiri din ChirpStack)", delete: "Scoate module / antene din evidență", run: "RULEAZĂ procesele (scrie în ChirpStack)" } },
  { key: "lorawan", label: "Dispozitive LoRaWAN", path: "/lorawan", desc: "Datele din lorawandb (primul IP).", zone: "global",
    actions: { view: "Vede lista dispozitivelor din lorawandb" } },
  { key: "billing", label: "Facturare (getmgdb)", path: "/facturare", desc: "Datele din getmgdb (al doilea IP).", zone: "global",
    actions: { view: "Vede lista din getmgdb (facturare)" } },
  { key: "audit", label: "Jurnal de audit", path: "/audit", desc: "Cine a făcut ce, când și de unde: autentificări, conturi, drepturi, rapoarte, module, date modificate, acces refuzat. Nu se poate șterge din aplicație.", zone: "global",
    actions: { view: "Vede jurnalul de audit al tuturor utilizatorilor", export: "Exportă jurnalul (CSV)" } },
  { key: "users", label: "Utilizatori", path: "/utilizatori", desc: "Conturile aplicației și drepturile lor.", zone: "none",
    actions: { view: "Vede conturile pe care le poate gestiona", edit: "Creează conturi și le schimbă drepturile (doar în limita drepturilor proprii)", delete: "Șterge conturi (doar din cele pe care le poate gestiona)", impersonate: "Simulare de login: intră în contul altui utilizator (6 ore) și vede aplicația exact ca el; doar în conturi cu drepturi încadrate în ale lui, nu în administratori (rămâne în jurnal ca «simulat de …»)" } },
];
const PAGE = new Map(PAGES.map((p) => [p.key, p]));
export const pageDef = (k: PageKey): PageDef => PAGE.get(k)!;

export type Perms = Partial<Record<PageKey, Action[]>>;
export type Access = { perms: Perms; allZones: boolean; branches: string[]; cities: string[] };
export type Viewer = { admin: boolean; access: Access };
export const NO_ACCESS: Access = { perms: {}, allZones: false, branches: [], cities: [] };

/** codul filialei dintr-o etichetă „05 · Comrat” (sau dintr-un cod „05”) */
export const filOf = (br: string): string => String(br ?? "").split(" · ")[0].trim();
export const cityKey = (fil: string, city: string): string => `${fil}|${city}`;

/** Utilizatorul poate face `action` pe pagina `page`? (administratorul orice) */
export function can(v: Viewer, page: PageKey, action: Action = "view"): boolean {
  return v.admin || !!v.access.perms[page]?.includes(action);
}
export const canPage = (v: Viewer, page: PageKey): boolean => can(v, page, "view");
/** vede măcar o pagină cu contoare (pentru API-urile folosite de ecranele cu contoare: istoric, poză, detalii) */
export const canSeeMeters = (v: Viewer): boolean => can(v, "meters") || can(v, "installer");
/** are vreun drept? */
export const hasAnyPage = (v: Viewer): boolean => v.admin || PAGES.some((p) => can(v, p.key));
/** prima pagină permisă (pentru redirect după autentificare), sau null */
export function firstPath(v: Viewer): string | null {
  const p = PAGES.find((x) => can(v, x.key));
  return p ? p.path : null;
}
/** calea unei pagini */
export const pathOf = (k: PageKey): string => pageDef(k).path;

/** Contorul (filiala = eticheta din `br`, orașul din `ct`) intră în zona utilizatorului? */
export function allowsMeter(v: Viewer, br: string, ct: string): boolean {
  if (v.admin || v.access.allZones) return true;
  const fil = filOf(br);
  if (!fil) return false;
  return v.access.branches.includes(fil) || v.access.cities.includes(cityKey(fil, ct || NO_CITY));
}

/** cheie stabilă pentru zona unui utilizator (aceeași zonă ⇒ aceeași cheie ⇒ aceleași liste în memorie) */
export function scopeKey(v: Viewer): string {
  if (v.admin || v.access.allZones) return "";
  return `${[...v.access.branches].sort().join(",")}#${[...v.access.cities].sort().join(",")}`;
}

/** Legătura dintre acțiuni: ce trebuie să existe ca să aibă sens acțiunea. */
const NEEDS: Record<Action, Action[]> = { view: [], edit: ["view"], delete: ["view"], export: ["view"], run: ["edit", "view"], impersonate: ["view"] };

/** Drepturile unui document de utilizator (rol + access): administrator sau limitat; ce nu se poate citi = fără acces. Citirea e îngăduitoare (nu blochează contul). */
export function viewerFromDoc(u: { role?: string; access?: unknown }): Viewer {
  if (u.role === ADMIN_ROLE) return { admin: true, access: NO_ACCESS };
  const c = cleanAccess(u.access ?? {}, false);
  return { admin: false, access: "access" in c ? c.access : NO_ACCESS };
}

/** Drepturile vechi (listă de pagini) → matricea nouă: Instalator și Instalator antene puteau și salva, restul doar vedeau. */
function fromLegacyPages(pages: unknown[]): Perms {
  const out: Perms = {};
  for (const p of pages) {
    if (p === "meters") out.meters = ["view"];
    else if (p === "installer") out.installer = ["view", "edit"];
    else if (p === "antennas") out.antennas = ["view", "edit"];
  }
  return out;
}

/**
 * Validează și curăță ce vine de la client (la creare / modificare utilizator) sau din baza de date.
 * `strict` (la scriere): paginile care cer «Toate filialele» fără ea ⇒ eroare explicită; la citire ele doar se ignoră.
 */
export function cleanAccess(raw: unknown, strict = true): { access: Access } | { error: string } {
  if (!raw || typeof raw !== "object") return { error: "Drepturi invalide." };
  const b = raw as Record<string, unknown>;
  const arr = (v: unknown): string[] | null => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : null);
  const branches = arr(b.branches ?? []), cities = arr(b.cities ?? []);
  if (!branches || !cities) return { error: "Drepturi invalide." };
  if (branches.length > 100 || cities.length > 5000) return { error: "Prea multe elemente bifate." };
  let rawPerms: Record<string, unknown>;
  if (b.perms !== undefined) {
    if (!b.perms || typeof b.perms !== "object" || Array.isArray(b.perms)) return { error: "Drepturi invalide." };
    rawPerms = b.perms as Record<string, unknown>;
  } else {
    const pages = b.pages ?? [];
    if (!Array.isArray(pages)) return { error: "Drepturi invalide." };
    rawPerms = fromLegacyPages(pages);
  }
  const allZones = b.allZones === true;
  const perms: Perms = {};
  for (const def of PAGES) {
    const given = rawPerms[def.key];
    if (given === undefined) continue;
    if (!Array.isArray(given) || !given.every((x) => typeof x === "string")) return { error: "Drepturi invalide." };
    const set = new Set<Action>();
    for (const a of given) if (ACTIONS.includes(a as Action) && def.actions[a as Action]) set.add(a as Action);
    for (const a of [...set]) for (const n of NEEDS[a]) set.add(n);
    if (!set.size) continue;
    if (def.zone === "global" && !allZones) {
      if (strict) return { error: `Pagina «${def.label}» arată date din toate filialele: bifează «Toate filialele» sau scoate pagina.` };
      continue;
    }
    perms[def.key] = ACTIONS.filter((a) => set.has(a));
  }
  const okBranches = [...new Set(branches.map((x) => x.trim()))].filter((x) => /^\d{1,3}$/.test(x));
  const okCities = [...new Set(cities)].filter((x) => /^\d{1,3}\|.{1,80}$/.test(x) && !x.includes("\n"));
  // un oraș dintr-o filială deja bifată întreagă nu mai are sens separat; cu «Toate filialele» filialele / orașele bifate nu mai contează
  const cityOnly = allZones ? [] : okCities.filter((c) => !okBranches.includes(c.split("|")[0]));
  return { access: { perms, allZones, branches: allZones ? [] : okBranches, cities: cityOnly } };
}

/** Aceleași drepturi? (pentru a vedea dacă un utilizator își schimbă propriile drepturi) */
export function sameAccess(a: Access, b: Access): boolean {
  const ser = (x: Access) => JSON.stringify([PAGES.map((p) => [p.key, x.perms[p.key] ?? []]), x.allZones, [...x.branches].sort(), [...x.cities].sort()]);
  return ser(a) === ser(b);
}

/**
 * „Cine poate da ce”: `actor` poate acorda `target` doar dacă nu depășește propriile drepturi (nici acțiuni, nici zonă). Administratorul poate orice.
 * Așa cineva cu dreptul «Utilizatori → Editare» nu își poate crea un cont mai puternic decât al lui.
 */
export function grantable(actor: Viewer, target: Access): boolean {
  if (actor.admin) return true;
  for (const def of PAGES) for (const a of target.perms[def.key] ?? []) if (!can(actor, def.key, a)) return false;
  if (actor.access.allZones) return true;
  if (target.allZones) return false;
  for (const f of target.branches) if (!actor.access.branches.includes(f)) return false;
  for (const c of target.cities) if (!actor.access.cities.includes(c) && !actor.access.branches.includes(c.split("|")[0])) return false;
  return true;
}

/** Rețete gata făcute (se aplică și apoi se pot ajusta): fiecare e o combinație cu sens. */
export type Preset = { key: string; label: string; desc: string; perms: Perms; allZones: boolean };
export const PRESETS: Preset[] = [
  { key: "viewer", label: "Doar vizualizare contoare", desc: "Contoare, hartă, grafice — în zona bifată.", perms: { meters: ["view"] }, allZones: false },
  { key: "installer", label: "Instalator contoare", desc: "Ecranul de montaj: vede și salvează date, poză, locație — în zona bifată.", perms: { installer: ["view", "edit"] }, allZones: false },
  { key: "antenna-installer", label: "Instalator antene", desc: "Ecranul antenelor: vede și salvează date, poză, locație.", perms: { antennas: ["view", "edit"] }, allZones: false },
  { key: "analyst", label: "Analist (doar citire, toate filialele)", desc: "Vede contoarele, consumul nemăsurat, integrarea, rapoartele, LoRaWAN și facturarea; nu modifică nimic.", perms: { meters: ["view"], control: ["view"], integration: ["view"], reports: ["view"], lorawan: ["view"], billing: ["view"] }, allZones: true },
  { key: "reports", label: "Operator rapoarte", desc: "Generează și descarcă rapoarte de facturare; nu le șterge.", perms: { meters: ["view"], reports: ["view", "edit", "export"] }, allZones: true },
  { key: "lorawan", label: "Operator LoRaWAN", desc: "Adaugă module și antene, simulează procesele; nu rulează în ChirpStack și nu șterge.", perms: { module: ["view", "edit"], antennas: ["view", "edit"] }, allZones: false },
  { key: "lorawan-full", label: "Operator LoRaWAN (cu rulare)", desc: "Ca mai sus, plus rulează procesele în ChirpStack (scrie acolo).", perms: { module: ["view", "edit", "run"], antennas: ["view", "edit"] }, allZones: false },
];

/** Ce poate face utilizatorul pe o pagină, ca obiect simplu (se trimite componentelor client ca să ascundă butoanele care n-ar merge oricum; serverul verifică oricum fiecare cerere). */
export type Can = Record<Action, boolean>;
export const canOf = (v: Viewer, page: PageKey): Can => ({ view: can(v, page, "view"), edit: can(v, page, "edit"), delete: can(v, page, "delete"), export: can(v, page, "export"), run: can(v, page, "run"), impersonate: can(v, page, "impersonate") });
