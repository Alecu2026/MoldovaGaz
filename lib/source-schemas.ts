import { createHash } from "node:crypto";
import { METER_NAME, branchLabel } from "./meter-shared";
import type { ColDef, SourceId, SourceRow, SourceWire } from "./source-shared";

/**
 * Cele două surse brute, fiecare cu propria pagină:
 *  - lorawandb (primul IP): lista dispozitivelor SCADA — id, nume, profil, etichetă, client, data creării;
 *  - getmgdb (al doilea IP): facturarea Moldovagaz — filială, cont, număr radio, adresă, consumator, secție, controlor…
 * Aici sunt (1) extragerea rândului brut pentru baza de date, (2) rândul „plat” cu coloane derivate DOAR din aceeași sursă
 * (ex. seria din numele dispozitivului, adresa din oraș + stradă + casă) și (3) punerea lor pe coloane pentru browser.
 * Combinarea celor două surse (legătura prin NUM_RADIO, valorile din SCADA) se face doar în pagina principală (lib/meter-sync.ts).
 */

const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 20);
const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const idOf = (v: unknown): string | null => {
  if (typeof v === "string") return v.trim() || null;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
};
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
};

/* ───────────────────── 1) rândul brut, așa cum se păstrează în baza de date ───────────────────── */

/** Un dispozitiv din lorawandb. Se păstrează doar câmpurile de identificare: `deviceData` și orice alte câmpuri (posibile chei LoRaWAN) NU se copiază. */
export type RawLorawan = {
  name: string;
  type: string | null;
  label: string | null;
  createdTime: number | null;
  customerId: string | null;
  ownerId: string | null;
  tenantId: string | null;
  deviceProfileId: string | null;
  description: string | null;
};
export type SrcDoc<T> = { _id: string; h: string; d: T };

export function lorawanDocs(devices: unknown[]): SrcDoc<RawLorawan>[] {
  const out: SrcDoc<RawLorawan>[] = [];
  for (const x of devices) {
    const r = x as Record<string, unknown> | null;
    const id = r ? idOf(r.id) : null;
    if (!r || !id) continue;
    const info = (r.additionalInfo ?? null) as Record<string, unknown> | null;
    const d: RawLorawan = {
      name: clean(r.name),
      type: clean(r.type) || null,
      label: clean(r.label) || null,
      createdTime: numOrNull(r.createdTime),
      customerId: idOf(r.customerId),
      ownerId: idOf(r.ownerId),
      tenantId: idOf(r.tenantId),
      deviceProfileId: idOf(r.deviceProfileId),
      description: info && typeof info.description === "string" ? clean(info.description) || null : null,
    };
    out.push({ _id: id, h: sha(JSON.stringify(d)), d });
  }
  return out;
}

export type RawBilling = Record<string, string | number | null>;

/** Un rând din getmgdb, cu toate câmpurile lui (șiruri curățate de spații). Identitatea: CONTOR_ID (la dubluri se adaugă #2, #3…), altfel NUM_RADIO, altfel amprenta rândului. */
export function billingDocs(rows: unknown[]): SrcDoc<RawBilling>[] {
  const out: SrcDoc<RawBilling>[] = [];
  const seen = new Map<string, number>();
  for (const x of rows) {
    if (!x || typeof x !== "object" || Array.isArray(x)) continue;
    const d: RawBilling = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
      if (k.startsWith("$") || k.startsWith("_") || k.includes(".")) continue; // chei pe care Mongo nu le acceptă
      d[k] = v === null || v === undefined ? null : typeof v === "number" ? v : typeof v === "string" ? v.trim() : JSON.stringify(v);
    }
    const h = sha(JSON.stringify(d));
    const base = clean(d.CONTOR_ID) ? `c${clean(d.CONTOR_ID)}` : clean(d.NUM_RADIO) ? `r${clean(d.NUM_RADIO).padStart(8, "0")}` : `h${h}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    out.push({ _id: n === 1 ? base : `${base}#${n}`, h, d });
  }
  return out;
}

/* ───────────────────── 2) rândul „plat” + definițiile coloanelor ───────────────────── */

type Doc = { _id: string; d: Record<string, unknown> };

const LORAWAN_COLS: ColDef[] = [
  { key: "name", label: "Dispozitiv", kind: "text", show: true, w: 250, search: true, mono: true },
  { key: "serial", label: "Serie (număr radio)", kind: "text", show: true, w: 150, search: true, mono: true, hint: "Cele 8 cifre din mijlocul numelui (S2154_00070948_2022 → 00070948); aceeași serie ca „NUM_RADIO” din facturare." },
  { key: "model", label: "Model", kind: "dict", show: true, w: 100, chart: true, main: true, hint: "Cele 4 cifre de la începutul numelui (S2154_… → 2154)." },
  { key: "year", label: "An", kind: "dict", show: true, w: 90, chart: true, main: true, hint: "Ultimele 4 cifre din nume (…_2022 → 2022)." },
  { key: "type", label: "Profil", kind: "dict", show: true, w: 230, chart: true, main: true, kpi: "Profiluri" },
  { key: "customer", label: "Client SCADA", kind: "dict", show: true, w: 150, short: 8, chart: true, main: true, kpi: "Clienți", hint: "Identificatorul clientului din SCADA (lorawandb nu dă numele)." },
  { key: "label", label: "Etichetă", kind: "text", show: true, w: 160, search: true },
  { key: "created", label: "Creat în SCADA", kind: "date", show: true, w: 170, time: true, chart: true },
  { key: "dup", label: "Serie repetată", kind: "dict", show: true, w: 130, chart: true, yes: "Serii repetate", hint: "Același număr radio apare la mai multe dispozitive din lista lorawandb." },
  { key: "std", label: "Nume standard", kind: "dict", chart: true, hint: "Numele are forma S2154_00070948_2022 (model, serie, an)." },
  { key: "id", label: "ID dispozitiv", kind: "text", mono: true, search: true },
  { key: "ownerId", label: "ID proprietar", kind: "dict", short: 8 },
  { key: "tenantId", label: "ID tenant", kind: "dict", short: 8 },
  { key: "deviceProfileId", label: "ID profil", kind: "dict", short: 8 },
  { key: "description", label: "Descriere", kind: "text", search: true },
];

export function lorawanTable(docs: Doc[]): { cols: ColDef[]; rows: SourceRow[] } {
  const serials = new Map<string, number>();
  const parsed = docs.map((x) => {
    const name = clean(x.d.name);
    const m = METER_NAME.exec(name);
    if (m) serials.set(m[2], (serials.get(m[2]) ?? 0) + 1);
    return { x, name, m };
  });
  const rows: SourceRow[] = parsed.map(({ x, name, m }) => ({
    name,
    serial: m ? m[2] : null,
    model: m ? m[1] : "alt",
    year: m ? m[3] : "alt",
    type: clean(x.d.type) || null,
    customer: clean(x.d.customerId) || null,
    label: clean(x.d.label) || null,
    created: numOrNull(x.d.createdTime),
    dup: m && (serials.get(m[2]) ?? 0) > 1 ? "Da" : "Nu",
    std: m ? "Da" : "Nu",
    id: x._id,
    ownerId: clean(x.d.ownerId) || null,
    tenantId: clean(x.d.tenantId) || null,
    deviceProfileId: clean(x.d.deviceProfileId) || null,
    description: clean(x.d.description) || null,
  }));
  return { cols: LORAWAN_COLS, rows };
}

const pad8 = (s: unknown) => clean(s).padStart(8, "0");

const BILLING_COLS: ColDef[] = [
  { key: "ENTITY_NAME", label: "Consumator", kind: "text", show: true, w: 220, search: true, pii: true },
  { key: "adresa", label: "Adresă", kind: "text", show: true, w: 270, search: true, pii: true, hint: "Oraș, stradă, casă, apartament, puse împreună." },
  { key: "CITY", label: "Oraș", kind: "dict", show: true, w: 140, chart: true, main: true, kpi: "Orașe" },
  { key: "branch", label: "Filială", kind: "dict", show: true, w: 160, chart: true, main: true, kpi: "Filiale", hint: "După codul FIL din facturare." },
  { key: "NUM_RADIO", label: "Număr radio", kind: "text", show: true, w: 120, search: true, mono: true, hint: "Seria modulului radio; aceeași serie e în numele dispozitivului din lorawandb." },
  { key: "CONTOR_SN", label: "Serie contor", kind: "text", show: true, w: 120, search: true, mono: true },
  { key: "ACCT_ID", label: "Cont", kind: "text", show: true, w: 120, search: true, mono: true, pii: true },
  { key: "OTDELEN", label: "Secție", kind: "dict", show: true, w: 110, chart: true, main: true, kpi: "Secții" },
  { key: "KOD_AB", label: "Cod abonat", kind: "dict", show: true, w: 110, chart: true },
  { key: "radioDup", label: "Număr radio repetat", kind: "dict", show: true, w: 130, chart: true, yes: "Număr radio repetat", hint: "Același număr radio apare pe mai multe rânduri de facturare." },
  { key: "UPDATED_DATE", label: "Actualizat", kind: "date", show: true, w: 170, time: true, chart: true },
  { key: "FIL", label: "Cod filială (FIL)", kind: "dict", chart: true },
  { key: "STREET", label: "Stradă", kind: "text", pii: true },
  { key: "HOUSE", label: "Casă", kind: "text", pii: true },
  { key: "APARTMENT", label: "Apartament", kind: "text", pii: true },
  { key: "CONTOR_ID", label: "ID contor", kind: "text", mono: true, search: true },
  { key: "PREM_ID", label: "ID spațiu (PREM_ID)", kind: "text", mono: true, search: true },
  { key: "SP_ID", label: "ID punct (SP_ID)", kind: "text", mono: true, search: true },
  { key: "METCITIRE", label: "Metodă de citire", kind: "dict", chart: true },
  { key: "CONTROLOR", label: "Controlor", kind: "dict", chart: true },
  { key: "REPEAT", label: "Repetări (REPEAT)", kind: "dict", chart: true },
  { key: "NUM_CAR", label: "Cifre contor (NUM_CAR)", kind: "dict", chart: true },
];
const BILLING_KNOWN = new Set(["ENTITY_NAME", "CITY", "STREET", "HOUSE", "APARTMENT", "ACCT_ID", "NUM_RADIO", "CONTOR_SN", "CONTOR_ID", "PREM_ID", "SP_ID", "FIL", "OTDELEN", "KOD_AB", "METCITIRE", "CONTROLOR", "UPDATED_DATE", "REPEAT", "NUM_CAR"]);

export function billingTable(docs: Doc[]): { cols: ColDef[]; rows: SourceRow[] } {
  const radios = new Map<string, number>();
  for (const x of docs) {
    const k = clean(x.d.NUM_RADIO);
    if (k) radios.set(pad8(k), (radios.get(pad8(k)) ?? 0) + 1);
  }
  const extra = new Set<string>(); // câmpuri pe care nu le știam: apar ca niște coloane text în detalii
  const rows: SourceRow[] = docs.map((x) => {
    const d = x.d;
    const row: SourceRow = {};
    for (const k of Object.keys(d)) if (!BILLING_KNOWN.has(k)) { extra.add(k); row[k] = clean(d[k]) || null; }
    const s = (k: string) => clean(d[k]) || null;
    const radio = clean(d.NUM_RADIO) ? pad8(d.NUM_RADIO) : null;
    const t = clean(d.UPDATED_DATE) ? Date.parse(clean(d.UPDATED_DATE)) : NaN;
    return Object.assign(row, {
      ENTITY_NAME: s("ENTITY_NAME"),
      adresa: [d.CITY, d.STREET, d.HOUSE, d.APARTMENT ? `ap. ${clean(d.APARTMENT)}` : ""].map(clean).filter(Boolean).join(", ") || null,
      CITY: s("CITY"),
      branch: branchLabel(clean(d.FIL)),
      NUM_RADIO: radio,
      CONTOR_SN: s("CONTOR_SN"),
      ACCT_ID: s("ACCT_ID"),
      OTDELEN: s("OTDELEN"),
      KOD_AB: s("KOD_AB"),
      radioDup: radio && (radios.get(radio) ?? 0) > 1 ? "Da" : "Nu",
      UPDATED_DATE: Number.isFinite(t) ? t : null,
      FIL: s("FIL"),
      STREET: s("STREET"),
      HOUSE: s("HOUSE"),
      APARTMENT: s("APARTMENT"),
      CONTOR_ID: s("CONTOR_ID"),
      PREM_ID: s("PREM_ID"),
      SP_ID: s("SP_ID"),
      METCITIRE: s("METCITIRE"),
      CONTROLOR: s("CONTROLOR"),
      REPEAT: s("REPEAT"),
      NUM_CAR: s("NUM_CAR"),
    });
  });
  const cols = [...BILLING_COLS, ...[...extra].sort().map((k): ColDef => ({ key: k, label: k, kind: "text", search: true }))];
  return { cols, rows };
}

export function sourceTable(source: SourceId, docs: Doc[]): { cols: ColDef[]; rows: SourceRow[] } {
  return source === "lorawan" ? lorawanTable(docs) : billingTable(docs);
}

/* ───────────────────── 3) pe coloane, pentru browser ───────────────────── */

/** Rânduri → coloane (dict: coduri + dicționar). Coloanele fără nicio valoare nu se trimit. */
export function columnarize(source: SourceId, cols: ColDef[], rows: SourceRow[], etag: string, at: number): SourceWire {
  const data: SourceWire["data"] = {};
  const dict: SourceWire["dict"] = {};
  const kept: ColDef[] = [];
  for (const c of cols) {
    const out: (string | number | null)[] = new Array(rows.length);
    let any = false;
    if (c.kind === "dict") {
      const map = new Map<string, number>();
      const names: string[] = [];
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][c.key];
        const s = v === null || v === undefined ? "" : String(v).trim();
        if (!s) { out[i] = -1; continue; }
        any = true;
        let code = map.get(s);
        if (code === undefined) { code = names.length; names.push(s); map.set(s, code); }
        out[i] = code;
      }
      if (any) dict[c.key] = names;
    } else if (c.kind === "text") {
      for (let i = 0; i < rows.length; i++) {
        const v = rows[i][c.key];
        const s = v === null || v === undefined ? "" : String(v);
        out[i] = s === "" ? null : s;
        if (s !== "") any = true;
      }
    } else {
      for (let i = 0; i < rows.length; i++) {
        const v = numOrNull(rows[i][c.key]);
        out[i] = v;
        if (v !== null) any = true;
      }
    }
    if (any) { data[c.key] = out; kept.push(c); }
  }
  return { v: 1, source, etag, at, total: rows.length, cols: kept, data, dict };
}
