/**
 * Pagina „pe sursă”: Facturare — doar datele din getmgdb.
 * Tipuri comune serverului și browserului; nimic de aici nu atinge rețeaua sau baza de date.
 */

export type SourceId = "billing";
export const SOURCE_IDS: SourceId[] = ["billing"];
export const isSourceId = (s: string): s is SourceId => (SOURCE_IDS as string[]).includes(s);

/** dict: valori cu puține variante (filtrare cu bife, grafic cu bare) · text: șiruri libere · num: număr · date: moment (ms) */
export type ColKind = "dict" | "text" | "num" | "date";

export type ColDef = {
  key: string;
  label: string;
  kind: ColKind;
  /** apare în tabel (restul se văd în panoul de detalii și în „Mai multe filtre”) */
  show?: boolean;
  /** lățimea coloanei în tabel (px) */
  w?: number;
  /** intră în căutarea liberă */
  search?: boolean;
  mono?: boolean;
  /** date personale: nu intră în exportul CSV */
  pii?: boolean;
  /** card în fila Grafice (dict: bare, date: pe zile / luni / ani) */
  chart?: boolean;
  /** în bara de sus, ca listă derulantă (doar dict) */
  main?: boolean;
  /** în totaluri: câte valori distincte au rândurile filtrate (textul = numele cardului) */
  kpi?: string;
  /** coloană Da / Nu: în totaluri apare câte rânduri au „Da” (textul = numele cardului) */
  yes?: string;
  /** afișează doar primele N caractere (UUID-uri); valoarea întreagă rămâne la hover și în detalii */
  short?: number;
  /** date: afișează și ora */
  time?: boolean;
  /** explicație scurtă (hover pe antet / card) */
  hint?: string;
};

/**
 * Lista unei surse, coloanar. dict: coduri în `dict[key]` (-1 = lipsă) · text: șir sau null · num / date: număr sau null.
 * `etag` se deduce din ce e în baza de date (nu din procesul care l-a construit): rămâne același după o repornire a serverului.
 */
export type SourceWire = {
  v: 1;
  source: SourceId;
  etag: string;
  /** momentul construirii listei pe server (ms) */
  at: number;
  total: number;
  cols: ColDef[];
  data: Record<string, (string | number | null)[]>;
  dict: Record<string, string[]>;
};

export type SourceMeta = {
  id: SourceId;
  /** adresa paginii */
  path: string;
  /** numele în meniu */
  nav: string;
  title: string;
  /** de unde vin datele */
  origin: string;
  /** ce înseamnă un rând */
  noun: string;
  nounPlural: string;
  searchHint: string;
  defaultSort: { key: string; dir: 1 | -1 };
};

export const SOURCES: Record<SourceId, SourceMeta> = {
  billing: {
    id: "billing",
    path: "/facturare",
    nav: "Facturare",
    title: "Facturare Moldovagaz",
    origin: "getmgdb (http://192.168.77.11:3880/getmgdb)",
    noun: "rând de facturare",
    nounPlural: "rânduri de facturare",
    searchHint: "Consumator, adresă, cont, număr radio, serie contor…",
    defaultSort: { key: "UPDATED_DATE", dir: -1 },
  },
};

/** „fără valoare” într-un filtru cu bife */
export const EMPTY_TOKEN = "∅";
export const EMPTY_LABEL = "(fără valoare)";

/** Colecția în care se păstrează rândurile BRUTE din getmgdb (scrisă de sincronizare). */
export const SOURCE_COLLECTION_DEFAULTS: Record<SourceId, string> = { billing: "src_billing" };

/** Un rând „plat”: valorile coloanelor, înainte de a fi puse pe coloane. */
export type SourceRow = Record<string, string | number | null>;
