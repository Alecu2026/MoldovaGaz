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
/** „Alertă” = baterie slabă sau contor offline. */
export const ALERT_FLAGS = FLAG.BATT | FLAG.OFFLINE;
/** „Probleme” raportate de contor (baterie, offline, buton, magnet). „OK” = are raport de stare și niciuna dintre ele. */
export const PROBLEM_FLAGS = FLAG.BATT | FLAG.OFFLINE | FLAG.BTN | FLAG.MAG;
export const isStatusOk = (fl: number): boolean => (fl & FLAG.STATUS) !== 0 && (fl & PROBLEM_FLAGS) === 0;

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
