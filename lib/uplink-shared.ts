/**
 * Tipuri și constante comune serverului și browserului (fără importuri de server).
 *
 * Lista de mesaje circulă COLOANAR: nu un obiect pe rând, ci câte un vector pe coloană (ts[], dev[], rssi[]…). Numele (dispozitiv, aplicație,
 * gateway, tip de mesaj) NU se repetă pe rând: rândurile au doar indici într-un dicționar care vine o singură dată și doar crește (append-only).
 * Așa JSON-ul e mic și se comprimă bine, iar în browser coloanele devin direct vectori tipizați (Float64Array, Int32Array…), fără obiecte pe rând.
 */

/** Biți din `fl` (stare a rândului). */
export const FLAG = { ADR: 1, BATT: 2, BTN: 4, MAG: 8, OFFLINE: 16, STATUS: 32 } as const;
/** „Alertă” = baterie slabă sau dispozitiv offline. */
export const ALERT_FLAGS = FLAG.BATT | FLAG.OFFLINE;

/** Tipurile de mesaj se țin într-o mască pe 32 de biți: primele 31 au bitul lor, restul se strâng în ultimul (index 31). */
export const TYPE_SLOTS = 31;
export const OTHER_TYPE = "(altele)";

/** [nume dispozitiv, devEUI, index aplicație] */
export type DevEntry = [name: string, eui: string, app: number];
export type Dict = { dev: DevEntry[]; gw: string[]; ap: string[]; ty: string[] };

export type ColsWire = {
  id: string[];
  /** momentul mesajului (ms) */
  ts: number[];
  dev: number[];
  /** index gateway (cel mai bun semnal), -1 = necunoscut */
  gw: number[];
  rssi: (number | null)[];
  snr: (number | null)[];
  /** frecvența în kHz */
  fr: number[];
  dr: number[];
  fl: number[];
  fc: number[];
  pt: number[];
  /** masca tipurilor de mesaj (vezi TYPE_SLOTS) */
  tm: number[];
  /** valoarea principală din mesaj (ultima citire), dacă există */
  val: (number | null)[];
  /** câte gateway-uri au auzit mesajul */
  gn: number[];
};

/** Lista completă (/api/uplinks/dataset). */
export type DatasetWire = { v: 2; gen: string; head: number; total: number; dict: Dict; cols: ColsWire };
/** Doar ce e nou de la poziția `after` (/api/uplinks/delta). `dict` conține DOAR intrările adăugate de la lungimile trimise de client. */
export type DeltaWire = { v: 2; gen: string; head: number; total: number; dict: Dict; cols: ColsWire };
export type DeltaFull = { v: 2; full: true };

/** Un rând gata de afișat (construit doar pentru rândurile vizibile). */
export type RowView = {
  id: string;
  ts: number;
  dev: string;
  eui: string;
  app: string;
  gw: string | null;
  gn: number;
  rssi: number | null;
  snr: number | null;
  freqKhz: number;
  dr: number;
  fl: number;
  fc: number;
  pt: number;
  types: string[];
  val: number | null;
};

/** Rezumatul compact salvat în fiecare document (`s`): tot ce trebuie ca lista să se construiască fără să citim payload-ul întreg. */
export type UplinkSummary = {
  /** ts (ms) */ t: number;
  /** nume dispozitiv */ d: string;
  /** devEUI */ e: string;
  /** aplicație */ a: string;
  /** cel mai bun gateway */ g: string | null;
  /** nr. gateway-uri */ gn: number;
  r: number | null;
  n: number | null;
  /** kHz */ f: number;
  dr: number;
  fl: number;
  fc: number;
  pt: number;
  /** tipuri de mesaj */ ty: string[];
  v: number | null;
};

export const emptyDict = (): Dict => ({ dev: [], gw: [], ap: [], ty: [] });
