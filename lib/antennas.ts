/**
 * Ecranul instalatorului de ANTENE (gateway-uri LoRaWAN) — varianta noastră a aplicației din SCADA „Gateway_App” (dashboardul „Gateways_Lorawan_App”, starea „Gateway_StateID”):
 * Gateway admin table, Select Device, Gateway Update, Instalation Photo, Installation foto, Harta_Instalator, Meters Location și mesajele primite pe zi; aceleași câmpuri și etichete.
 * Datele introduse de instalator se salvează DOAR în baza noastră (colecția `antenna_data`), nu în SCADA. Partea comună client + server (fără importuri de server).
 */

/** O antenă în tabel. `id` = identificatorul antenei (EUI-ul, ca numele dispozitivului din SCADA), în litere mici. */
export type AntennaRow = {
  id: string;
  /** numele din rețeaua LoRaWAN (ex. „M-324750”) = Gateways_name_A */
  name: string;
  /** activă = a auzit ceva în ultimele 24 h */
  active: boolean;
  state: "on" | "slow" | "off";
  /** ultima activitate (ms): cea mai recentă dintre mesajul primit prin integrare și lastActivityTime din SCADA */
  last: number | null;
  /** mesaje primite prin antenă (de la începutul colectării prin integrare) */
  msgs: number;
  Comments: string; Client: string; NrTel_SIM: string; ip_address: string; NumeInstalator: string;
  latitude: number | null; longitude: number | null;
  Instalta: boolean; Antena_mobila: boolean;
  hasPhoto: boolean;
  /** creată la noi (formularul «Antenă nouă» din Module LoRaWAN), nu adusă din SCADA / din rețea */
  created?: boolean;
};
export type AntennaRecord = AntennaRow & { updatedAt: number | null; by: string | null; photoAt: number | null };
export type AntennaList = { rows: AntennaRow[]; now: number };

/** Coloanele tabelului, cu antetele din SCADA. `show: false` = ascunse la început (se aleg din „Select columns to display”). */
export const A_COLUMNS: { key: string; label: string; num?: boolean; show?: boolean }[] = [
  { key: "id", label: "Entity name" },
  { key: "active", label: "active" },
  { key: "Comments", label: "Comments" },
  { key: "Client", label: "Client" },
  { key: "Gateways_name_A", label: "Gateways_name_A" },
  { key: "CounterMessages", label: "CounterMessages", num: true },
  { key: "lastActivityTime", label: "lastActivityTime" },
  { key: "NrTel_SIM", label: "NrTel_SIM" },
  { key: "ip_address", label: "ip_address" },
  { key: "NumeInstalator", label: "NumeInstalator" },
  { key: "Gateways_latitude", label: "Gateways_latitude", num: true, show: false },
  { key: "Gateways_longitude", label: "Gateways_longitude", num: true, show: false },
  { key: "Instalta", label: "Instalta", show: false },
  { key: "Antena_mobila", label: "Antena_mobila", show: false },
  { key: "image", label: "image", show: false },
];

/** Mesajele (cele din SCADA, în română / engleză / rusă) — aceleași ca la ecranul contoarelor, plus cele proprii antenelor. */
export const AMSG = {
  qrNotFound: "Device not found in QR Code\nУстройство не найдено в QR-коде",
  qrNotInDb: (code: string) => `Device not found in DB:${JSON.stringify(code)}\nУстройство не найдено в базе данных:${JSON.stringify(code)}`,
  noEntity: "No entity selected",
} as const;

/**
 * Din textul unui cod QR de pe antenă scoate identificatorul ei: 16 cifre hexazecimale (EUI), ex. „5031395355324750”, cu sau fără prefix (ex. „eui-ac1f09fffe1060fb”).
 * Întoarce null dacă nu găsește unul.
 */
export function parseAntennaQr(code: string): string | null {
  const t = String(code ?? "").trim().toLowerCase();
  if (!t) return null;
  const m = /(?:^|[^0-9a-f])([0-9a-f]{16})(?:[^0-9a-f]|$)/.exec(t);
  return m ? m[1] : null;
}

export const antennaIdOk = (id: string): boolean => /^[0-9a-z][0-9a-z_.-]{3,63}$/.test(id);

/** Valorile câmpurilor din formularul „Gateway Update” (aceleași chei ca atributele din SCADA). */
export type AntennaPatch = {
  NumeInstalator?: string; Gateways_latitude?: number; Gateways_longitude?: number;
  Instalta?: boolean; Antena_mobila?: boolean; NrTel_SIM?: string; ip_address?: string; Comments?: string; Client?: string;
};
const num = (v: unknown): number | null => { if (v === null || v === undefined || v === "") return null; const n = typeof v === "number" ? v : Number(String(v).replace(",", ".")); return Number.isFinite(n) ? n : null; };
const text = (v: unknown, max: number): string | { error: string } => { const s = String(v ?? "").trim(); return s.length > max ? { error: "Valoarea e prea lungă." } : s; };

/** Validează și curăță ce vine de la client: doar câmpurile cunoscute, cu tipul lor. */
export function cleanAntennaPatch(body: unknown): { patch: AntennaPatch } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Cerere invalidă." };
  const b = body as Record<string, unknown>;
  const patch: AntennaPatch = {};
  for (const [k, max] of [["NumeInstalator", 60], ["NrTel_SIM", 40], ["ip_address", 60], ["Client", 200], ["Comments", 2000]] as const) {
    if (!(k in b)) continue;
    const v = text(b[k], max);
    if (typeof v !== "string") return { error: `${k}: ${v.error}` };
    patch[k] = v;
  }
  for (const k of ["Gateways_latitude", "Gateways_longitude"] as const) {
    if (!(k in b)) continue;
    const n = num(b[k]);
    if (n === null || Math.abs(n) > (k === "Gateways_latitude" ? 90 : 180)) return { error: `${k} nu e o coordonată validă.` };
    patch[k] = n;
  }
  for (const k of ["Instalta", "Antena_mobila"] as const) if (k in b) patch[k] = b[k] === true || b[k] === "true";
  if (!Object.keys(patch).length) return { error: "Nimic de salvat." };
  return { patch };
}

/** „24/11/2026 18:16:30” (ca în tabelul din SCADA: ziua și luna fără zero în față) */
export const fdtA = (ms: number | null): string => {
  if (!ms || ms <= 0) return "";
  const d = new Date(ms), p = (n: number) => String(n).padStart(2, "0");
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

/** Căutare + sortare locale în tabelul de antene (listă mică, câteva sute): rândurile care conțin textul în vreo coloană, în ordinea cerută; lipsurile la sfârșit. */
export function queryAntennas(rows: AntennaRow[], q: string, key: string, dir: "asc" | "desc"): AntennaRow[] {
  const needle = q.trim().toLowerCase();
  const hay = (r: AntennaRow) => `${r.id} ${r.name} ${r.Comments} ${r.Client} ${r.NrTel_SIM} ${r.ip_address} ${r.NumeInstalator}`.toLowerCase();
  const out = needle ? rows.filter((r) => hay(r).includes(needle)) : rows.slice();
  const sgn = dir === "asc" ? 1 : -1;
  const val = (r: AntennaRow): string | number | null => {
    switch (key) {
      case "id": return r.id;
      case "active": case "ActiveTime": return r.last;
      case "Comments": return r.Comments || null; case "Client": return r.Client || null; case "Gateways_name_A": return r.name || null;
      case "CounterMessages": return r.msgs; case "lastActivityTime": return r.last;
      case "NrTel_SIM": return r.NrTel_SIM || null; case "ip_address": return r.ip_address || null; case "NumeInstalator": return r.NumeInstalator || null;
      case "Gateways_latitude": return r.latitude; case "Gateways_longitude": return r.longitude;
      case "Instalta": return r.Instalta ? 1 : 0; case "Antena_mobila": return r.Antena_mobila ? 1 : 0; case "image": return r.hasPhoto ? 1 : 0;
      default: return r.id;
    }
  };
  out.sort((a, b) => {
    const x = val(a), y = val(b);
    if (x === null) return y === null ? 0 : 1;
    if (y === null) return -1;
    if (typeof x === "number" && typeof y === "number") return x === y ? 0 : (x - y) * sgn;
    return String(x).localeCompare(String(y), "en", { numeric: true }) * sgn;
  });
  return out;
}

/* ───────── antene noi: se creează la noi, apoi se copiază și se încarcă MANUAL în ChirpStack (SCADA nu creează antene în ChirpStack: ele apar acolo doar din mesajele primite) ───────── */

/** Ce se păstrează la o antenă creată la noi (colecția `antenna_new`). */
export type NewAntenna = { id: string; name: string; description: string; latitude: number | null; longitude: number | null; altitude: number; Client: string; Comments: string };

/** Numele antenei în ChirpStack: litere, cifre, «_» și «-» (la fel ca regula «[\w-]+» a formularului de gateway). */
export const gatewayNameOk = (n: string): boolean => /^[A-Za-z0-9_-]{3,60}$/.test(n);

/** Validează formularul „Antenă nouă”: EUI-ul (16 cifre hexazecimale, se acceptă și textul unui cod QR), numele, descrierea, poziția (opțională) și altitudinea (implicit 0). */
export function cleanNewAntenna(body: unknown): { antenna: NewAntenna } | { error: string } {
  if (!body || typeof body !== "object") return { error: "Cerere invalidă." };
  const b = body as Record<string, unknown>;
  const id = parseAntennaQr(String(b.id ?? ""));
  if (!id) return { error: "Gateway ID trebuie să aibă 16 cifre hexazecimale (EUI-ul antenei)." };
  const name = String(b.name ?? "").trim();
  if (!gatewayNameOk(name)) return { error: "Numele (Gateway name) are 3–60 de caractere: litere, cifre, «_» și «-», fără spații." };
  const description = text(b.description, 200), Client = text(b.Client, 200), Comments = text(b.Comments, 2000);
  for (const v of [description, Client, Comments]) if (typeof v !== "string") return { error: v.error };
  const la = num(b.latitude), lo = num(b.longitude), alt = num(b.altitude);
  if ((la === null) !== (lo === null)) return { error: "Latitudinea și longitudinea se completează amândouă (sau niciuna)." };
  if (la !== null && (Math.abs(la) > 90 || Math.abs(lo!) > 180)) return { error: "Coordonatele nu sunt valide." };
  if (alt !== null && Math.abs(alt) > 10000) return { error: "Altitudinea nu este validă." };
  return { antenna: { id, name, description: description as string, latitude: la, longitude: lo, altitude: alt ?? 0, Client: Client as string, Comments: Comments as string } };
}

/** Câmpurile din formularul „Create gateway” din ChirpStack, în ordinea lui, gata de copiat (fiecare valoare se lipește în câmpul cu același nume). */
export function chirpstackFields(a: Pick<NewAntenna, "id" | "name" | "description" | "latitude" | "longitude" | "altitude">): { label: string; value: string }[] {
  return [
    { label: "Gateway name", value: a.name },
    { label: "Gateway description", value: a.description || a.name },
    { label: "Gateway ID", value: a.id },
    { label: "Latitude", value: a.latitude === null ? "" : String(a.latitude) },
    { label: "Longitude", value: a.longitude === null ? "" : String(a.longitude) },
    { label: "Gateway altitude (meters)", value: String(a.altitude) },
  ];
}
export const chirpstackText = (a: Parameters<typeof chirpstackFields>[0]): string => chirpstackFields(a).map((f) => `${f.label}: ${f.value}`).join("\n");
