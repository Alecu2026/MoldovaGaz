import type { SortKey } from "@/lib/meter-filter";

/**
 * Coloanele tabelului de contoare. Prima parte e ce se vedea deja; restul sunt coloanele din lista SCADA („Device List”): SPID, cont personal, contor SN,
 * litri la instalare, aragaz / cazan / încălzire, adresă, bloc, apartament, data calibrării, latitudine / longitudine. Utilizatorul alege ce vede (butonul „Coloane”),
 * alegerea se reține în browser. Fiecare coloană are filtru în antet (ColumnFilters).
 */
export type ColKey =
  | "ts" | "ac" | "at" | "dev" | "br" | "ct" | "gw" | "rssi" | "bat" | "val" | "dc" | "ty" | "st"
  | "mg" | "xsp" | "xcp" | "xsn" | "il" | "xar" | "xcz" | "xin" | "xsr" | "xhs" | "xap" | "cal" | "la" | "lo";

export type ColDef = { col: ColKey; label: string; key: SortKey | null; w: string; min: number; cls?: string; group: "base" | "ids" | "install" | "address" | "coords"; def: boolean };

/** În ordinea afișării (ca în SCADA: contorul, activ, activitate, apoi identificatorii, instalarea, adresa…). */
export const ALL_COLUMNS: ColDef[] = [
  { col: "dev", label: "Contor", key: "dev", w: "minmax(220px, 1.3fr)", min: 220, group: "base", def: true },
  { col: "ac", label: "Activ", key: null, w: "96px", min: 96, group: "base", def: true },
  { col: "at", label: "Activitate", key: null, w: "118px", min: 118, group: "base", def: true },
  { col: "ts", label: "Ultima citire", key: "ts", w: "132px", min: 132, group: "base", def: true },
  { col: "mg", label: "Mesaje", key: "mg", w: "112px", min: 112, cls: "num", group: "base", def: true },
  { col: "xsp", label: "SPID", key: null, w: "124px", min: 124, group: "ids", def: false },
  { col: "xcp", label: "Cont personal", key: null, w: "128px", min: 128, group: "ids", def: false },
  { col: "xsn", label: "Contor SN", key: null, w: "112px", min: 112, group: "ids", def: false },
  { col: "il", label: "Litri instalare", key: null, w: "124px", min: 124, cls: "num", group: "install", def: false },
  { col: "xar", label: "Aragaz", key: null, w: "84px", min: 84, group: "install", def: false },
  { col: "xcz", label: "Cazan", key: null, w: "84px", min: 84, group: "install", def: false },
  { col: "xin", label: "Încălzire", key: null, w: "92px", min: 92, group: "install", def: false },
  { col: "cal", label: "Data calibrării", key: null, w: "230px", min: 230, group: "install", def: false },
  { col: "br", label: "Filială", key: "br", w: "150px", min: 150, group: "base", def: true },
  { col: "ct", label: "Oraș", key: null, w: "130px", min: 130, group: "base", def: true },
  { col: "xsr", label: "Adresă", key: null, w: "190px", min: 190, group: "address", def: false },
  { col: "xhs", label: "Bloc / casă", key: null, w: "96px", min: 96, group: "address", def: false },
  { col: "xap", label: "Apartament", key: null, w: "104px", min: 104, group: "address", def: false },
  { col: "gw", label: "Concentrator", key: "gw", w: "minmax(160px, 1fr)", min: 160, group: "base", def: true },
  { col: "rssi", label: "Semnal", key: "rssi", w: "132px", min: 132, group: "base", def: true },
  { col: "bat", label: "Baterie", key: "bat", w: "122px", min: 122, group: "base", def: true },
  { col: "val", label: "Volume (m³)", key: "val", w: "140px", min: 140, cls: "num", group: "base", def: true },
  { col: "dc", label: "Consum zi (L)", key: "dc", w: "140px", min: 140, cls: "num", group: "base", def: true },
  { col: "la", label: "Latitudine", key: null, w: "124px", min: 124, group: "coords", def: false },
  { col: "lo", label: "Longitudine", key: null, w: "124px", min: 124, group: "coords", def: false },
  { col: "ty", label: "Tip mesaj", key: null, w: "150px", min: 150, group: "base", def: true },
  { col: "st", label: "Stare", key: null, w: "minmax(170px, 1fr)", min: 170, group: "base", def: true },
];

export const GROUP_LABELS: Record<ColDef["group"], string> = { base: "Coloanele de bază", ids: "Identificatori", install: "Instalare", address: "Adresă", coords: "Coordonate" };
export const DEFAULT_COLS: ColKey[] = ALL_COLUMNS.filter((c) => c.def).map((c) => c.col);
const STORE = "mg:cols:v1";

const KNOWN = "mg:cols:known";
/** coloanele care existau înainte să se țină evidența celor «cunoscute» (alegerile vechi nu le conțineau pe cele noi) */
const LEGACY_NEW = new Set<string>(["mg"]);

/** Coloanele alese (în ordinea din ALL_COLUMNS); fără alegere salvată sau invalidă ⇒ cele implicite. Coloanele implicite apărute după alegerea salvată se adaugă o singură dată. */
export function readCols(): ColKey[] {
  try {
    const raw = localStorage.getItem(STORE);
    if (!raw) return DEFAULT_COLS;
    const want = new Set(JSON.parse(raw) as string[]);
    let known: Set<string>;
    try { known = new Set(JSON.parse(localStorage.getItem(KNOWN) ?? "null") as string[]); if (known.size === 0) throw new Error("fără"); } catch { known = new Set(ALL_COLUMNS.map((c) => c.col).filter((c) => !LEGACY_NEW.has(c))); }
    for (const c of ALL_COLUMNS) if (c.def && !known.has(c.col)) want.add(c.col);
    try { localStorage.setItem(KNOWN, JSON.stringify(ALL_COLUMNS.map((c) => c.col))); } catch { /* nu se reține */ }
    const out = ALL_COLUMNS.filter((c) => want.has(c.col)).map((c) => c.col);
    return out.length >= 2 && out.includes("dev") ? out : DEFAULT_COLS;
  } catch {
    return DEFAULT_COLS;
  }
}
export function saveCols(cols: ColKey[]): void {
  try {
    localStorage.setItem(STORE, JSON.stringify(cols));
    localStorage.setItem(KNOWN, JSON.stringify(ALL_COLUMNS.map((c) => c.col)));
  } catch {
    /* alegerea nu se reține */
  }
}
