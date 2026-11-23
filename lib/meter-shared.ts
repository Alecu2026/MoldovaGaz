/**
 * Modelul „contor” comun serverului și browserului (fără importuri de server).
 *
 * Un rând = un contor de gaz (dispozitiv ThingsBoard) cu starea lui CURENTĂ: ultima citire (Volume_m3_Total), semnal, baterie, filiala, adresa etc.
 * Lista circulă COLOANAR: câte un vector pe coloană. Numele repetitive (aplicație, concentrator, filială, oraș, profil, tip mesaj) NU se repetă pe rând:
 * rândurile au doar indici într-un dicționar care vine o singură dată și doar crește. Rândurile se pot MODIFICA (contorul raportează din nou):
 * serverul numără modificările cu un `seq` global, iar browserul cere doar rândurile cu seq mai mare decât cel pe care îl are (upsert după id).
 */

/** Biți din `fl` (stare a rândului). DUP = seria (numărul radio) apare la mai multe dispozitive din ThingsBoard. */
export const FLAG = { DUP: 1, BATT: 2, BTN: 4, MAG: 8, OFFLINE: 16, STATUS: 32, INACTIVE: 64, BILLED: 128 } as const;
/**
 * „Alertă” = baterie slabă sau contor INACTIV în SCADA (atributul `active` = false, calculat de platformă din activitate), ca în SCADA.
 * Câmpul `offline` pe care contorul îl trimite în propriul mesaj (FLAG.OFFLINE) NU e o alertă: 57% dintre contoare îl trimit chiar în mesajul cu citirea de azi.
 */
export const ALERT_FLAGS = FLAG.BATT | FLAG.INACTIVE;
/** „Probleme” raportate de contor (baterie, buton, magnet). „OK” = are raport de stare, niciuna dintre ele și nu e inactiv. */
export const PROBLEM_FLAGS = FLAG.BATT | FLAG.BTN | FLAG.MAG;
export const isStatusOk = (fl: number): boolean => (fl & FLAG.STATUS) !== 0 && (fl & (PROBLEM_FLAGS | FLAG.INACTIVE)) === 0;

/** Treptele de activitate, ca în raportul din SCADA, după ultima citire: activ 24 h · avertizare 1–7 zile · critic peste 7 zile · fără nicio citire. */
export const ACT = { ACTIVE: 0, WARN: 1, CRIT: 2, NONE: 3 } as const;
export const DAY_MS = 86_400_000;
export const activityOf = (ts: number, now: number): 0 | 1 | 2 | 3 => (ts <= 0 ? 3 : now - ts < DAY_MS ? 0 : now - ts < 7 * DAY_MS ? 1 : 2);

/** Tipurile de mesaj (ieType) se țin într-o mască pe 32 de biți: primele 31 au bitul lor, restul se strâng în ultimul (index 31). */
export const TYPE_SLOTS = 31;
export const OTHER_TYPE = "(altele)";

export type Dict = { ap: string[]; gw: string[]; ty: string[]; br: string[]; ct: string[]; pf: string[] };
export const emptyDict = (): Dict => ({ ap: [], gw: [], ty: [], br: [], ct: [], pf: [] });

export type ColsWire = {
  id: string[];
  /** ultima citire / ultimul mesaj (ms); 0 = niciodată */
  ts: number[];
  /** numele dispozitivului, devEUI și textul de căutare (număr radio, cont, adresă, consumator…) */
  nm: string[];
  eu: string[];
  q: string[];
  /** index aplicație, concentrator (gateway), filială, oraș, profil; -1 = necunoscut */
  ap: number[];
  gw: number[];
  br: number[];
  ct: number[];
  pf: number[];
  rssi: (number | null)[];
  snr: (number | null)[];
  /** frecvența în kHz (0 = necunoscută) */
  fr: number[];
  fl: number[];
  /** fCnt (-1 = necunoscut), fPort (-1 = necunoscut) */
  fc: number[];
  pt: number[];
  /** masca tipurilor de mesaj */
  tm: number[];
  /** Volume (m3) — Volume_m3_Total, ultima citire */
  val: (number | null)[];
  /** baterie rămasă, % */
  bat: (number | null)[];
  /** consum zilnic / lunar, în litri */
  dc: (number | null)[];
  mc: (number | null)[];
  /** începutul perioadei (ms, ca în SCADA) la care se referă dc / mc: ziua / luna calendaristică; null = necunoscut. Doar valorile din perioada CURENTĂ se adună în „Consum”. */
  dt: (number | null)[];
  mt: (number | null)[];
  /** coordonate (grade): latitudine / longitudine; null = fără coordonate */
  la: (number | null)[];
  lo: (number | null)[];
};

/** Lista completă (/api/meters/dataset). `head` = ultimul seq inclus. */
export type DatasetWire = { v: 3; gen: string; head: number; total: number; dict: Dict; cols: ColsWire };
/** Doar rândurile modificate / noi după `after`. `dict` conține DOAR intrările adăugate peste lungimile trimise de client. */
export type DeltaWire = DatasetWire;
export type DeltaFull = { v: 3; full: true };

/** Un rând gata de afișat (construit doar pentru rândurile vizibile). */
export type RowView = {
  id: string;
  ts: number;
  name: string;
  eui: string;
  app: string;
  gw: string | null;
  rssi: number | null;
  snr: number | null;
  freqKhz: number;
  fl: number;
  fc: number;
  pt: number;
  types: string[];
  val: number | null;
  bat: number | null;
  dc: number | null;
  mc: number | null;
  lat: number | null;
  lon: number | null;
  branch: string | null;
  city: string | null;
  profile: string | null;
};

/** Rezumatul compact salvat în fiecare document (`s`): tot ce trebuie ca lista să se construiască fără să citim restul documentului. */
export type MeterSummary = {
  t: number;
  n: string;
  e: string;
  q: string;
  a: string;
  g: string | null;
  r: number | null;
  sn: number | null;
  f: number;
  fl: number;
  fc: number;
  pt: number;
  ty: string | null;
  v: number | null;
  b: number | null;
  dc: number | null;
  mc: number | null;
  /** latitudine / longitudine din atributele ThingsBoard (null = lipsesc sau sunt invalide) */
  la: number | null;
  lo: number | null;
  br: string;
  ct: string;
  pf: string;
};

/** Filialele Moldovagaz după codul FIL din facturare (ex. FIL 05 = Comrat). */
export const BRANCHES: Record<string, string> = {
  "01": "Chișinău",
  "05": "Comrat",
  "10": "Edineț",
  "11": "Cahul",
  "20": "Orhei",
  "27": "Taraclia",
  "31": "Florești",
  "33": "Cimișlia",
  "35": "Ștefan Vodă",
  "36": "Ialoveni",
};
export const branchLabel = (fil: string | null | undefined): string => {
  const f = (fil ?? "").trim();
  return f ? `${f} · ${BRANCHES[f] ?? "filială necunoscută"}` : "Nedeterminată";
};

/** Contorul → model și an din nume (ex. „S2154_00070948_2022” → model 2154, serie 00070948, an 2022). */
export const METER_NAME = /^(?:S|SN)?(\d{4})_(\d{8})_(\d{4})$/;

/** Coordonate valide: în limitele globului și nu (0, 0). Folosit la sincronizare și la corectarea documentelor existente. */
export function validCoords(la: unknown, lo: unknown): [number, number] | null {
  const a = typeof la === "number" ? la : typeof la === "string" && la.trim() !== "" ? Number(la) : NaN;
  const b = typeof lo === "number" ? lo : typeof lo === "string" && lo.trim() !== "" ? Number(lo) : NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a) > 90 || Math.abs(b) > 180 || (a === 0 && b === 0)) return null;
  return [a, b];
}
