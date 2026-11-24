/**
 * Ecranul instalatorului — varianta noastră a aplicației din SCADA pe care o folosesc instalatorii (dashboardul „<Filială>_Gaz_App”, starea „<Filială>_Gaz_Meter_App”):
 * aceleași widgeturi, câmpuri, butoane, culori și mesaje, dar datele introduse se salvează DOAR în baza noastră (colecția `installer_data`), nu în SCADA.
 * Partea comună client + server (fără importuri de server).
 */

/** Câmpurile formularului „Meter Update” (aceleași chei ca atributele din SCADA). `ModuleWriteInitial` = „Module Calibration”, `locationModule` = „Localitate”. */
export type InstallerData = {
  ContorNr: string;
  Instalation_Litres: number | null;
  latitude: number | null;
  longitude: number | null;
  Aragaz: boolean;
  Cazan: boolean;
  Incalzire: boolean;
  ModuleWriteInitial: boolean;
  locationModule: string;
  Comments: string;
};
export type InstallerRecord = InstallerData & {
  id: string; name: string; lastActivityTime: number | null; hasPhoto: boolean; photoSource: "installer" | "scada" | null; updatedAt: number | null; by: string | null;
  /** valorile din lista „Localitate” (după filiala contorului) */
  options: string[];
};
export type InstallerRow = {
  id: string; name: string; lastActivityTime: number | null; Volume_m3_Total: number | null; Instalation_Litres: number | null; Volume_Liters: number | null; ModuleInitialValue: number | null;
};
export type InstallerList = { total: number; rows: InstallerRow[] };

/** „Items per page”: ca în SCADA (10 / 25 / 50 / 100) plus 200 / 500 / 1000 și «All» (0 = toate contoarele din zona utilizatorului). */
export const PAGE_SIZES = [10, 25, 50, 100, 200, 500, 1000, 0] as const;
export const ALL_ROWS_MAX = 100_000;

/** Coloanele tabelului, cu antetele din SCADA („Nume Entitate” = numele contorului, tradus în română de ThingsBoard). */
export const LIST_COLUMNS: { key: string; label: string; num?: boolean }[] = [
  { key: "name", label: "Nume Entitate" },
  { key: "active", label: "active" },
  { key: "ActiveTime", label: "ActiveTime" },
  { key: "Volume_m3_Total", label: "Volume_m3_Total", num: true },
  { key: "Instalation_Litres", label: "Instalation_Litres", num: true },
  { key: "Volume_Liters", label: "Volume_Liters", num: true },
  { key: "ModuleInitialValue", label: "ModuleinitialValue", num: true },
  { key: "lastActivityTime", label: "lastActivityTime" },
];

/** Mesajele din SCADA, cuvânt cu cuvânt (română / engleză / rusă, cum le văd instalatorii). */
export const MSG = {
  imageSaved: "Image saved!\nИзображение сохранено!",
  locationUpdated: "Locația a fost actualizată cu succes!",
  locationUpdatedTs: "Locația a fost actualizată în Atribute și Timeseries!",
  gpsAccess: "Se accesează GPS-ul telefonului...",
  locationSaveFailed: "Eroare la salvarea locației în platformă: ",
  geoUnsupported: "Geolocația nu este suportată de acest browser.",
  geoDenied: "Accesul la locație a fost respins de utilizator. Verifică permisiunile browserului.",
  geoUnavailable: "Informațiile despre locație nu sunt disponibile (GPS oprit/semnal slab).",
  geoTimeout: "Cererea de a obține locația a expirat.",
  geoDefault: "Nu s-a putut obține locația.",
  qrEmptyTitle: "Empty result",
  qrEmptyBody: "Scan QR code action was canceled!\nДействие сканирования QR-кода было отменено!",
  qrError: "Failed to scan QR code\nНе удалось отсканировать QR-код",
  qrNotFound: "Device not found in QR Code\nУстройство не найдено в QR-коде",
  qrSaved: "QR saved!\nQR сохранен!",
  qrAim: "Îndreaptă camera spre QR / Наведите камеру на QR",
  qrNoCode: "Cod negăsit în poză, încearcă din nou / QR не найден, повторите",
  locationRequired: "Location must be inserted",
  updated: "Update successful",
  updateFailed: "Update failed",
  camUnsupported: "Browser incompatibil",
  camUnavailable: "Cameră indisponibilă",
  retake: "Refă",
  confirm: "Confirmă",
  saving: "Se salvează...",
  undo: "Anulează Ultima Comandă",
  save: "Salvează",
} as const;
export const qrNotInDb = (name: string, total: number) => `Device not found in DB:${JSON.stringify(name)}\nУстройство не найдено в базе данных:${JSON.stringify(name)}\nTotal Meters:${total}`;

/**
 * Culoarea și textul „activității” unui contor după ultima lui citire (lastActivityTime), exact ca în tabelul din SCADA:
 * mai nou de 1 zi = verde „<1 day”, 1–7 zile = galben „1<7 days”, mai vechi = roșu „>7 days”; fără dată = „Null”.
 * Pentru cercul „active” pragurile sunt (≤ 1 zi / ≤ 7 zile) și galbenul e mai deschis; pentru text (< 1 zi / < 7 zile).
 */
const DAY = 86_400_000;
export function activity(last: number | null, now: number): { dot: string; color: string; text: string } {
  const GREEN = "rgb(39, 134, 34)", RED = "rgb(255, 0, 0)";
  if (!last || last <= 0) return { dot: RED, color: RED, text: "Null" };
  const d = now - last;
  const dot = d <= DAY ? GREEN : d <= 7 * DAY ? "rgb(255, 255, 0)" : RED;
  if (d < DAY) return { dot, color: GREEN, text: "<1 day" };
  if (d < 7 * DAY) return { dot, color: "rgb(224, 202, 29)", text: "1<7 days" };
  return { dot, color: RED, text: ">7 days" };
}

/**
 * Din textul unui cod QR de pe contor scoate numele dispozitivului, ca în SCADA: „…:S2154.00071212.2022:…” (cod LoRaWAN), „2514.00071212.2022!N…”, „…:3010.60027989.2610:…”
 * (S3010) și „…:3020.…:” (S3020). Numele are forma „SNNNN.NNNNNNNN.NNNN” (S + punct pe poziția 5); punctele devin „_” (nume SCADA: S2154_00071212_2022).
 * Întoarce null dacă nu găsește un nume valid.
 */
export function parseQr(code: string): string | null {
  const text = String(code ?? "").trim();
  if (!text) return null;
  const valid = (v: string, strictLen: boolean) => v.indexOf("S") === 0 && v.indexOf(".") === 5 && (!strictLen || v.length === 19);
  const upTo = (s: string) => { const i = s.indexOf(":"); return i === -1 ? s : s.substring(0, i); };
  let v: string;
  const s1 = text.indexOf(":S");
  if (s1 !== -1) { v = "S" + upTo(text.substring(s1 + 2)); if (valid(v, true)) return v.replaceAll(".", "_"); }
  const s2 = text.indexOf("!N");
  if (s2 !== -1) { v = "S" + text.substring(0, s2); if (valid(v, true)) return v.replaceAll(".", "_"); }
  for (const p of [":3010.", ":3020.", ":30"]) {
    const i = text.indexOf(p);
    if (i === -1) continue;
    const rest = text.substring(i + 1);
    if (rest.indexOf(":") === -1 && p !== ":30") continue;
    v = "S" + upTo(rest);
    if (valid(v, true)) return v.replaceAll(".", "_");
  }
  const m = /S\d{4}\.\d{8}\.\d{4}/.exec(text);
  if (m) return m[0].replaceAll(".", "_");
  const m2 = /(?:^|[^0-9])(\d{4})\.(\d{8})\.(\d{4})(?:[^0-9]|$)/.exec(text);
  return m2 ? `S${m2[1]}_${m2[2]}_${m2[3]}` : null;
}

export type Patch = Partial<InstallerData> & { QR_Code?: string; QR_format?: string };
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};

/** Validează și curăță ce vine de la client: doar câmpurile cunoscute, cu tipul lor. Întoarce { patch } sau { error }. */
export function cleanPatch(body: unknown): { patch: Patch } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Cerere invalidă." };
  const b = body as Record<string, unknown>;
  const patch: Patch = {};
  if ("ContorNr" in b) { const s = String(b.ContorNr ?? "").trim(); if (s.length > 40) return { error: "ContorNr e prea lung (cel mult 40 de caractere)." }; patch.ContorNr = s; }
  if ("Instalation_Litres" in b) {
    const n = num(b.Instalation_Litres);
    if (b.Instalation_Litres !== null && b.Instalation_Litres !== "" && (n === null || n < 0 || n > 1e9)) return { error: "Instalation_Litres trebuie să fie un număr pozitiv." };
    patch.Instalation_Litres = n;
  }
  for (const k of ["latitude", "longitude"] as const) {
    if (!(k in b)) continue;
    const n = num(b[k]);
    if (n === null || Math.abs(n) > (k === "latitude" ? 90 : 180)) return { error: `${k} nu e o coordonată validă.` };
    patch[k] = n;
  }
  for (const k of ["Aragaz", "Cazan", "Incalzire", "ModuleWriteInitial"] as const) if (k in b) patch[k] = b[k] === true || b[k] === "true";
  if ("locationModule" in b) { const s = String(b.locationModule ?? "").trim(); if (s.length > 60) return { error: "Localitate e prea lung." }; patch.locationModule = s; }
  if ("Comments" in b) { const s = String(b.Comments ?? ""); if (s.length > 2000) return { error: "Comments e prea lung (cel mult 2000 de caractere)." }; patch.Comments = s; }
  if ("QR_Code" in b) { const s = String(b.QR_Code ?? ""); if (s.length > 500) return { error: "Codul QR e prea lung." }; patch.QR_Code = s; }
  if ("QR_format" in b) patch.QR_format = String(b.QR_format ?? "").slice(0, 30);
  if (!Object.keys(patch).length) return { error: "Nimic de salvat." };
  return { patch };
}

/* ───────── lista ecranului instalatorului, în browser (căutare / sortare / paginare locale) ───────── */

/** Lista coloanară de la server (`full` = lista întreagă a zonei; altfel doar rândurile schimbate). */
export type InstWire = { v: 1; gen: string; head: number; full: boolean; id: string[]; nm: string[]; cn: string[]; ia: (number | null)[]; vol: (number | null)[]; il: (number | null)[]; vl: (number | null)[]; mi: (number | null)[] };
/** Ce a introdus instalatorul la noi (suprascrie valorile din SCADA în tabel): `l` = Instalation_Litres (null = golit), `c` = ContorNr. */
export type InstEdits = Record<string, { l?: number | null; c?: string }>;

/** Rândurile (indici în listă) care trec de căutare (nume sau ContorNr, fără diferență între litere mari / mici), în ordinea cerută; lipsurile ajung la sfârșit în ambele sensuri. */
export function queryInstaller(d: { nm: string[]; cn: string[]; ia: (number | null)[]; vol: (number | null)[]; il: (number | null)[]; vl: (number | null)[]; mi: (number | null)[] }, q: string, sortKey: string, dir: "asc" | "desc"): Int32Array {
  const n = d.nm.length;
  const needle = q.trim().toLowerCase();
  const keep: number[] = [];
  for (let i = 0; i < n; i++) if (!needle || d.nm[i].toLowerCase().includes(needle) || d.cn[i].toLowerCase().includes(needle)) keep.push(i);
  const sgn = dir === "asc" ? 1 : -1;
  const numCol = ({ ActiveTime: d.ia, active: d.ia, lastActivityTime: d.ia, Volume_m3_Total: d.vol, Instalation_Litres: d.il, Volume_Liters: d.vl, ModuleInitialValue: d.mi } as Record<string, (number | null)[] | undefined>)[sortKey];
  if (numCol) keep.sort((a, b) => { const x = numCol[a], y = numCol[b]; if (x === null || x === undefined) return y === null || y === undefined ? a - b : 1; if (y === null || y === undefined) return -1; return x === y ? a - b : (x - y) * sgn; });
  else keep.sort((a, b) => (d.nm[a] === d.nm[b] ? a - b : d.nm[a] < d.nm[b] ? -sgn : sgn));
  return Int32Array.from(keep);
}
