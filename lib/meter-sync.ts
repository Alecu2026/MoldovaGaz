import { createHash } from "node:crypto";
import { branchLabel, FLAG, METER_NAME, validCoords, type MeterSummary } from "./meter-shared";
import { tbLatest, type TbEntity, type TbLatest } from "./thingsboard";

/**
 * Combină cele trei surse într-un document pe contor (colecția `meters`):
 *  1. lorawandb  — lista dispozitivelor ThingsBoard care sunt contoare (id, nume, profil, client);
 *  2. getmgdb    — facturarea Moldovagaz (filiala FIL, cont, adresă, consumator, număr radio…);
 *  3. ThingsBoard — valorile CURENTE (Volume_m3_Total, semnal, baterie, consumuri…) și atributele, citite în loturi.
 * Legătura facturare ↔ dispozitiv: NUM_RADIO (8 cifre) = seria din numele dispozitivului („S2154_00070948_2022” → 00070948).
 * Legătura filială ↔ client ThingsBoard se deduce din perechile potrivite (FIL majoritar pe client), ca și contoarele fără facturare să aibă filială.
 * NU se copiază cheile LoRaWAN (APPKEY / NWKSKEY / APPSKEY) și nici imaginile din atributele dispozitivelor.
 */

export type Dev = { id: { id: string }; name: string; type: string; label?: string | null; createdTime: number; customerId?: { id: string } | null };
export type Bill = Record<string, string | number | null>;

export const TS_KEYS = [
  "Volume_m3_Total", "Volume_m3_Total_ts", "rssi", "loRaSNR", "Frequency", "Concentrator", "battery", "dailyConsumption", "weeklyConsumption",
  "monthlyConsumption", "yearlyConsumption", "fPort", "fCnt", "temp", "offline", "magnet", "buttonPressed", "batteryTooLowVoltage", "ieType",
  "applicationName", "decodeTime", "Magnet_Value",
];
export const SERVER_KEYS = [
  "FIL", "OTDELEN", "KOD_AB", "active", "lastActivityTime", "inactivityAlarmTime", "locationModule", "latitude", "longitude", "Aragaz", "Cazan",
  "Instalation_Litres", "ModuleInitialValue", "ContorNr", "ContPersonal", "OrderNr", "activation", "lorawan_registered", "emc_activation_count",
  "dev_SN", "devEUI", "METCITIRE:", "CONTROLOR", "UPDATED_DATE",
];
export const CLIENT_KEYS = ["fCnt", "model", "version", "remCapacity", "applicationName", "Volume_m3", "couterPulse", "integrationName"];

export type MeterDoc = {
  _id: string;
  updatedAt: Date;
  h: string;
  s: MeterSummary;
  /** `dupWith` (doar când seria se repetă): celelalte dispozitive cu același număr radio, ca „nume (profil)” */
  tb: { name: string; type: string; customerId: string | null; createdTime: number; label: string | null; dupWith?: string[] };
  bill: Bill | null;
  attrs: Record<string, string | number | boolean | null>;
  tel: Record<string, { t: number; v: string }>;
};

export type SyncStats = {
  devices: number;
  billingRows: number;
  matched: number;
  billingWithoutDevice: number;
  devicesWithoutBilling: number;
  duplicateSerials: number;
  duplicateBilling: number;
  branchFromBilling: number;
  branchFromCustomer: number;
  branchUnknown: number;
  branchConflicts: number;
  nonStandardNames: number;
  custFil: Record<string, string>;
};

const src = (name: string, dflt: string) => process.env[name] || dflt;
async function getJson<T>(url: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      if (attempt >= 2) throw new Error(`${url}: ${(e as Error).message}`);
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

export async function fetchSources(): Promise<{ devices: Dev[]; billing: Bill[] }> {
  const [devices, billing] = await Promise.all([
    getJson<Dev[]>(src("LORAWAN_DB_URL", "http://192.168.77.11:3880/lorawandb")),
    getJson<Bill[]>(src("MG_DB_URL", "http://192.168.77.11:3880/getmgdb")),
  ]);
  if (!Array.isArray(devices) || !Array.isArray(billing)) throw new Error("Surse invalide: așteptam liste JSON.");
  return { devices, billing };
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
};
const clean = (v: unknown): string => String(v ?? "").replace(/\s+/g, " ").trim();
const pad8 = (s: unknown) => clean(s).padStart(8, "0");

/** Valoare de serie de timp (doar dacă are moment > 0). */
const tsv = (l: TbLatest, k: string): { t: number; v: string } | null => {
  const e = l.TIME_SERIES?.[k];
  return e && e.ts > 0 && e.value !== "" ? { t: e.ts, v: String(e.value) } : null;
};
/** Valoare de atribut (nevidă). */
const av = (l: TbLatest, scope: "SERVER_ATTRIBUTE" | "CLIENT_ATTRIBUTE", k: string): string | null => {
  const e = l[scope]?.[k];
  return e && e.value !== "" && e.value !== undefined && e.value !== null ? String(e.value) : null;
};

/** Citește în loturi valorile curente din ThingsBoard. Un lot eșuat NU oprește tot: dispozitivele lui rămân fără valori noi (`failed`). */
export async function fetchLatest(devices: Dev[], batch = 500, log: (m: string) => void = () => {}): Promise<{ byId: Map<string, TbLatest>; failed: Set<string> }> {
  const byId = new Map<string, TbLatest>();
  const failed = new Set<string>();
  const keys = { ts: TS_KEYS, server: SERVER_KEYS, client: CLIENT_KEYS };
  const t0 = Date.now();
  let streak = 0; // loturi eșuate la rând: dacă ThingsBoard nu răspunde deloc, nu pierdem minute cu reîncercări pe toate loturile
  for (let i = 0; i < devices.length; i += batch) {
    const ids = devices.slice(i, i + batch).map((d) => d.id.id);
    try {
      const ents: TbEntity[] = await tbLatest(ids, keys);
      for (const e of ents) byId.set(e.entityId.id, e.latest);
      streak = 0;
    } catch (e) {
      if (++streak >= 3) throw new Error(`ThingsBoard nu răspunde (3 loturi la rând eșuate): ${(e as Error).message}`);
      for (const id of ids) failed.add(id);
      log(`  lot ${i}–${i + ids.length} eșuat: ${(e as Error).message}`);
    }
    if ((i / batch) % 10 === 9 || i + batch >= devices.length) log(`  ThingsBoard: ${Math.min(i + batch, devices.length)} / ${devices.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  return { byId, failed };
}

/** Facturare indexată după NUM_RADIO (la dubluri se păstrează înregistrarea cea mai recent actualizată). */
function indexBilling(billing: Bill[]): { byRadio: Map<string, Bill>; dups: number } {
  const byRadio = new Map<string, Bill>();
  let dups = 0;
  for (const b of billing) {
    const k = pad8(b.NUM_RADIO);
    const cur = byRadio.get(k);
    if (cur) {
      dups++;
      if (clean(b.UPDATED_DATE) <= clean(cur.UPDATED_DATE)) continue;
    }
    byRadio.set(k, b);
  }
  return { byRadio, dups };
}

const serialOf = (name: string): string | null => METER_NAME.exec(name)?.[2] ?? null;

/** Dispozitivele a căror serie (numărul radio din nume) apare la mai multe dispozitive: id → toate dispozitivele cu aceeași serie (inclusiv el). */
export function duplicateGroups(devices: Dev[]): Map<string, Dev[]> {
  const bySerial = new Map<string, Dev[]>();
  for (const d of devices) {
    const s = serialOf(d.name);
    if (s) (bySerial.get(s) ?? bySerial.set(s, []).get(s)!).push(d);
  }
  const out = new Map<string, Dev[]>();
  for (const ds of bySerial.values()) if (ds.length > 1) for (const d of ds) out.set(d.id.id, ds);
  return out;
}
export const dupLabels = (id: string, group: Dev[]): string[] => group.filter((x) => x.id.id !== id).map((x) => `${x.name} (${x.type})`);

export function buildDocs(devices: Dev[], billing: Bill[], latest: Map<string, TbLatest>, now: Date): { docs: MeterDoc[]; stats: SyncStats } {
  const { byRadio, dups } = indexBilling(billing);
  const dupGroup = duplicateGroups(devices);

  // 1) serie → dispozitive; legătura facturare ↔ dispozitiv și deducerea filialei pe client
  const bySerial = new Map<string, Dev[]>();
  let nonStandard = 0;
  for (const d of devices) {
    const s = serialOf(d.name);
    if (!s) { nonStandard++; continue; }
    (bySerial.get(s) ?? bySerial.set(s, []).get(s)!).push(d);
  }
  const tally = new Map<string, Map<string, number>>();
  for (const [serial, ds] of bySerial) {
    const b = byRadio.get(serial);
    const fil = b ? clean(b.FIL) : "";
    if (!fil) continue;
    for (const d of ds) {
      const c = d.customerId?.id;
      if (!c) continue;
      const m = tally.get(c) ?? tally.set(c, new Map()).get(c)!;
      m.set(fil, (m.get(fil) ?? 0) + 1);
    }
  }
  const custFil: Record<string, string> = {};
  for (const [c, m] of tally) {
    const [best, n] = [...m].sort((a, b) => b[1] - a[1])[0];
    const total = [...m.values()].reduce((a, b) => a + b, 0);
    if (n >= 20 && n / total >= 0.8) custFil[c] = best; // un client = o filială (cu excepții izolate)
  }

  // 2) un singur dispozitiv primește rândul de facturare al unei serii (cel al cărui client are aceeași filială; altfel primul)
  const owner = new Map<string, string>(); // serie → id dispozitiv
  let dupSerials = 0;
  for (const [serial, ds] of bySerial) {
    if (ds.length > 1) dupSerials++;
    const b = byRadio.get(serial);
    if (!b) continue;
    const fil = clean(b.FIL);
    const pick = ds.find((d) => d.customerId?.id && custFil[d.customerId.id] === fil) ?? ds[0];
    owner.set(serial, pick.id.id);
  }

  const stats: SyncStats = {
    devices: devices.length, billingRows: billing.length, matched: 0, billingWithoutDevice: 0, devicesWithoutBilling: 0, duplicateSerials: dupSerials,
    duplicateBilling: dups, branchFromBilling: 0, branchFromCustomer: 0, branchUnknown: 0, branchConflicts: 0, nonStandardNames: nonStandard, custFil,
  };
  for (const k of byRadio.keys()) if (!bySerial.has(k)) stats.billingWithoutDevice++;

  const docs: MeterDoc[] = [];
  for (const d of devices) {
    const id = d.id.id;
    const l = latest.get(id) ?? {};
    const serial = serialOf(d.name);
    const bill = serial && owner.get(serial) === id ? byRadio.get(serial) ?? null : null;
    if (bill) stats.matched++;
    else stats.devicesWithoutBilling++;

    // filiala: din facturare (FIL), altfel din clientul ThingsBoard
    const billFil = bill ? clean(bill.FIL) : "";
    const custF = d.customerId?.id ? custFil[d.customerId.id] ?? "" : "";
    const fil = billFil || custF;
    if (billFil) stats.branchFromBilling++; else if (custF) stats.branchFromCustomer++; else stats.branchUnknown++;
    if (billFil && custF && billFil !== custF) stats.branchConflicts++;

    // citiri curente
    const vol = tsv(l, "Volume_m3_Total");
    const volTs = tsv(l, "Volume_m3_Total_ts");
    const v = vol ? num(vol.v) : null;
    const lastAct = num(av(l, "SERVER_ATTRIBUTE", "lastActivityTime"));
    let ts = vol?.t ?? 0;
    if (!ts) for (const k of ["rssi", "loRaSNR", "decodeTime", "fCnt"]) ts = Math.max(ts, l.TIME_SERIES?.[k]?.ts ?? 0);
    if (!ts && lastAct) ts = lastAct;

    const flag = (k: string) => tsv(l, k)?.v === "true";
    let fl = 0;
    if (flag("batteryTooLowVoltage")) fl |= FLAG.BATT;
    if (flag("buttonPressed")) fl |= FLAG.BTN;
    if (flag("magnet")) fl |= FLAG.MAG;
    if (flag("offline")) fl |= FLAG.OFFLINE;
    if (["batteryTooLowVoltage", "buttonPressed", "magnet", "offline"].some((k) => tsv(l, k))) fl |= FLAG.STATUS;
    if (av(l, "SERVER_ATTRIBUTE", "active") === "false") fl |= FLAG.INACTIVE;
    if (bill) fl |= FLAG.BILLED;
    const group = dupGroup.get(id);
    if (group) fl |= FLAG.DUP;

    let battery: number | null = null;
    const bj = tsv(l, "battery");
    if (bj) {
      try { battery = num((JSON.parse(bj.v) as { remCapacity?: unknown }).remCapacity); } catch { /* valoare ne-JSON */ }
    }
    if (battery === null) battery = num(av(l, "CLIENT_ATTRIBUTE", "remCapacity"));

    const geo = validCoords(av(l, "SERVER_ATTRIBUTE", "latitude"), av(l, "SERVER_ATTRIBUTE", "longitude"));
    const freq = num(tsv(l, "Frequency")?.v);
    const city = clean(bill?.CITY) || clean(av(l, "SERVER_ATTRIBUTE", "locationModule"));
    const eui = clean(av(l, "SERVER_ATTRIBUTE", "devEUI")).toLowerCase();
    const q = [bill?.NUM_RADIO, bill?.ACCT_ID, bill?.CONTOR_SN, bill?.CITY, bill?.STREET, bill?.HOUSE, bill?.APARTMENT, bill?.ENTITY_NAME, bill?.OTDELEN, av(l, "SERVER_ATTRIBUTE", "ContorNr"), av(l, "SERVER_ATTRIBUTE", "ContPersonal"), av(l, "SERVER_ATTRIBUTE", "dev_SN")]
      .map(clean).filter(Boolean).join(" ");

    const s: MeterSummary = {
      t: ts,
      n: d.name,
      e: eui,
      q,
      a: clean(tsv(l, "applicationName")?.v ?? av(l, "CLIENT_ATTRIBUTE", "applicationName")),
      g: clean(tsv(l, "Concentrator")?.v) || null,
      r: num(tsv(l, "rssi")?.v),
      sn: num(tsv(l, "loRaSNR")?.v),
      f: freq === null ? 0 : Math.round(freq * 1000),
      fl,
      fc: num(tsv(l, "fCnt")?.v ?? av(l, "CLIENT_ATTRIBUTE", "fCnt")) ?? -1,
      pt: num(tsv(l, "fPort")?.v) ?? -1,
      ty: clean(tsv(l, "ieType")?.v) || null,
      v,
      b: battery,
      dc: num(tsv(l, "dailyConsumption")?.v),
      mc: num(tsv(l, "monthlyConsumption")?.v),
      la: geo ? geo[0] : null,
      lo: geo ? geo[1] : null,
      br: branchLabel(fil),
      ct: city || "—",
      pf: d.type || "—",
    };

    // atribute (fără chei LoRaWAN / imagini) și ultima telemetrie
    const attrs: MeterDoc["attrs"] = {};
    for (const k of SERVER_KEYS) {
      const x = av(l, "SERVER_ATTRIBUTE", k);
      if (x !== null) attrs[k.replace(/:$/, "")] = x === "true" ? true : x === "false" ? false : num(x) !== null && !/^0\d/.test(x) && k !== "ContPersonal" && k !== "ContorNr" && k !== "devEUI" ? num(x) : x;
    }
    for (const k of CLIENT_KEYS) {
      const x = av(l, "CLIENT_ATTRIBUTE", k);
      if (x !== null && !(k in attrs)) attrs[`c_${k}`] = x;
    }
    const tel: MeterDoc["tel"] = {};
    for (const k of TS_KEYS) {
      const x = tsv(l, k);
      if (x) tel[k] = x;
    }
    if (volTs) tel.Volume_m3_Total_ts = volTs;

    const body = {
      s,
      tb: { name: d.name, type: d.type, customerId: d.customerId?.id ?? null, createdTime: d.createdTime, label: d.label ?? null, ...(group ? { dupWith: dupLabels(id, group) } : {}) },
      bill: bill ? Object.fromEntries(Object.entries(bill).map(([k, x]) => [k, typeof x === "string" ? x.trim() : x])) : null,
      attrs,
      tel,
    };
    docs.push({ _id: id, updatedAt: now, h: createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 20), ...body });
  }
  return { docs, stats };
}
