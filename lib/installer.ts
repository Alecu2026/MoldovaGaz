/**
 * Ecranul instalatorului — varianta noastră a dashboardului „ChisinauGaz_Instalator_App” din SCADA (aceleași widgeturi, câmpuri, butoane și mesaje),
 * dar datele introduse se salvează DOAR în baza noastră (colecția `installer_data`), nu în SCADA. Partea comună client + server (fără importuri de server).
 */

/** Câmpurile formularului „Meter Update” (aceleași etichete ca în SCADA). `ModuleWriteInitial` = „Module Calibration” (bifă). */
export type InstallerData = {
  ContorNr: string;
  Instalation_Litres: number | null;
  latitude: number | null;
  longitude: number | null;
  ModuleWriteInitial: boolean;
  Comments: string;
};
export type InstallerRecord = InstallerData & { id: string; name: string; lastActivityTime: number | null; hasPhoto: boolean; photoSource: "installer" | "scada" | null; updatedAt: number | null; by: string | null };
export type InstallerRow = {
  id: string; name: string; active: boolean | null; ContorNr: string; Instalation_Litres: number | null; couterPulse: number | null; ModuleInitialValue: number | null;
  Volume_m3_Total: number | null; Volume_Liters: number | null; inactivityTimeout: number | null; lastActivityTime: number | null;
};
export type InstallerList = { total: number; rows: InstallerRow[] };

export const LIST_COLUMNS: { key: keyof InstallerRow | "active"; label: string; num?: boolean }[] = [
  { key: "active", label: "active" },
  { key: "name", label: "Entity name" },
  { key: "ContorNr", label: "ContorNr" },
  { key: "Instalation_Litres", label: "Install_Litres", num: true },
  { key: "couterPulse", label: "couterPulse", num: true },
  { key: "ModuleInitialValue", label: "ModuleInitialValue", num: true },
  { key: "Volume_m3_Total", label: "Volume_m3_Total", num: true },
  { key: "Volume_Liters", label: "Volume_Liters", num: true },
  { key: "inactivityTimeout", label: "inactivityTimeout", num: true },
  { key: "lastActivityTime", label: "lastActivityTime" },
];

/** Mesajele din SCADA, cuvânt cu cuvânt (engleză + rusă, cum le văd instalatorii). */
export const MSG = {
  imageSaved: "Image saved!\nИзображение сохранено!",
  imageFailed: "Image save failed\nНе удалось сохранить изображение",
  locationSaved: "Location saved!\nМестоположение сохранено!",
  locationFailed: "Location save failed\nНе удалось сохранить местоположение",
  locationCanceled: "Get location action was canceled!\nДействие «Получить местоположение» отменено!",
  photoCanceled: "Take photo action was canceled!\nДействие «Сделать фото» отменено!",
  qrCanceled: "Scan QR code action was canceled!\nДействие сканирования QR-кода было отменено!",
  qrNotFound: "Device not found in QR Code\nУстройство не найдено в QR-коде",
  locationRequired: "Location must be inserted",
  updated: "Update success",
  updateFailed: "Update failed",
} as const;

/**
 * Din textul unui cod QR de pe contor scoate numele dispozitivului, exact ca în SCADA: caută „:30…” (modele S3010 / S3020), ia ce e între „:30” și următorul „:”,
 * pune „S” în față și cere forma „SNNNN.NNNNNNNN.NNNN” (19 caractere, punct pe poziția 5); punctele devin „_” (nume SCADA: S3010_60027989_2610).
 * Pentru codurile LoRaWAN („LW:D0:…:S2154.00071212.2022:C1750” sau „2514.00071212.2022!N…”) caută același tipar „S2154.00071212.2022” oriunde în text.
 * Întoarce null dacă nu găsește un nume valid.
 */
export function parseQr(code: string): string | null {
  const text = String(code ?? "").trim();
  if (!text) return null;
  const after = text.indexOf(":30");
  if (after !== -1) {
    const rest = text.substring(after + 1);
    const cut = rest.indexOf(":");
    const dataVar = "S" + (cut === -1 ? rest : rest.substring(0, cut));
    if (dataVar.indexOf("S", 0) === 0 && dataVar.indexOf(".", 0) === 5 && dataVar.length === 19) return dataVar.replaceAll(".", "_");
  }
  const m = /S\d{4}\.\d{8}\.\d{4}/.exec(text);
  if (m) return m[0].replaceAll(".", "_");
  const m2 = /(?:^|[^0-9])(\d{4})\.(\d{8})\.(\d{4})(?:[^0-9]|$)/.exec(text);
  return m2 ? `S${m2[1]}_${m2[2]}_${m2[3]}` : null;
}

export type Patch = Partial<InstallerData>;
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
  if ("ContorNr" in b) { const s = String(b.ContorNr ?? "").trim(); if (s.length > 40) return { error: "SerialMeter e prea lung (cel mult 40 de caractere)." }; patch.ContorNr = s; }
  if ("Instalation_Litres" in b) {
    const n = num(b.Instalation_Litres);
    if (b.Instalation_Litres !== null && b.Instalation_Litres !== "" && (n === null || n < 0 || n > 1e9)) return { error: "Install_Litres trebuie să fie un număr pozitiv." };
    patch.Instalation_Litres = n;
  }
  for (const k of ["latitude", "longitude"] as const) {
    if (!(k in b)) continue;
    const n = num(b[k]);
    if (n === null || Math.abs(n) > (k === "latitude" ? 90 : 180)) return { error: `${k} nu e o coordonată validă.` };
    patch[k] = n;
  }
  if ("ModuleWriteInitial" in b) patch.ModuleWriteInitial = b.ModuleWriteInitial === true || b.ModuleWriteInitial === "true";
  if ("Comments" in b) { const s = String(b.Comments ?? ""); if (s.length > 2000) return { error: "Comments e prea lung (cel mult 2000 de caractere)." }; patch.Comments = s; }
  if (!Object.keys(patch).length) return { error: "Nimic de salvat." };
  return { patch };
}
