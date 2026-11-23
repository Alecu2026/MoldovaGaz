import { createHash } from "node:crypto";
import { branchLabel, FLAG, METER_NAME, validCoords, type MeterSummary } from "./meter-shared";
import { CUSTOMER_FIL, GAS_CUSTOMERS } from "./meter-scope";
import { tbCustomerDevices, tbLatest, type TbEntity, type TbLatest } from "./thingsboard";

/**
 * Combină sursele într-un document pe contor (colecția `meters`):
 *  1. SCADA (iiot.scada.md) — LISTA contoarelor: toate dispozitivele celor 10 clienți de gaz (lib/meter-scope.ts), inclusiv „Defectate_*”;
 *  2. getmgdb    — facturarea Moldovagaz (filiala FIL, cont, adresă, consumator, număr radio…);
 *  3. SCADA — valorile CURENTE (Volume_m3_Total, Volume_m3_Total_ts, coordonate, semnal, baterie, consumuri…) și atributele, citite în loturi.
 * Legătura facturare ↔ dispozitiv: NUM_RADIO (8 cifre) = seria din numele dispozitivului („S2154_00070948_2022” → 00070948).
 * Filiala: din facturare (FIL); altfel din clientul dispozitivului (fiecare filială are clientul ei în SCADA, vezi lib/meter-scope.ts).
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
  "dev_SN", "devEUI", "METCITIRE:", "CONTROLOR", "UPDATED_DATE", "Incalzire", "Data_Calibrarii",
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
/** Pauza (ms) dintre două cereri către SCADA în timpul sincronizării: ține încărcarea serverului SCADA blândă și vizibilă. Implicit 150 ms; 0 = fără pauză. */
const pauseMs = () => {
  const v = Number(process.env.TB_PAUSE_MS);
  return Number.isFinite(v) && v >= 0 && process.env.TB_PAUSE_MS !== undefined && process.env.TB_PAUSE_MS !== "" ? v : 150;
};
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

/** Facturarea (getmgdb), doar GET. */
export async function fetchBilling(): Promise<Bill[]> {
  const billing = await getJson<Bill[]>(src("MG_DB_URL", "http://192.168.77.11:3880/getmgdb"));
  if (!Array.isArray(billing)) throw new Error("getmgdb: așteptam o listă JSON.");
  return billing;
}

/** Lista brută din lorawandb (doar GET). Folosită DOAR pentru pagina „Dispozitive LoRaWAN” (colecția src_lorawan); lista contoarelor din aplicație vine din SCADA. */
export async function fetchLorawan(): Promise<unknown[]> {
  const devices = await getJson<unknown[]>(src("LORAWAN_DB_URL", "http://192.168.77.11:3880/lorawandb"));
  if (!Array.isArray(devices)) throw new Error("lorawandb: așteptam o listă JSON.");
  return devices;
}

/**
 * Contoarele de gaz din SCADA: toate dispozitivele celor 10 clienți din lib/meter-scope.ts (inclusiv profilurile „Defectate_*”: și ele trimit mesaje), fără dubluri.
 * Doar citire, clientul pe rând, pagini de 1000, cu pauză între cereri. Un client care nu răspunde oprește tot (nu construim o listă incompletă).
 */
export async function fetchDevices(log: (m: string) => void = () => {}): Promise<{ devices: Dev[]; perCustomer: { name: string; total: number; kept: number }[] }> {
  const devices: Dev[] = [];
  const perCustomer: { name: string; total: number; kept: number }[] = [];
  const seen = new Set<string>();
  const t0 = Date.now();
  for (const c of GAS_CUSTOMERS) {
    const r = await tbCustomerDevices(c.id, { pauseMs: pauseMs() });
    if (r.devices.length !== r.total) throw new Error(`${c.name}: am primit ${r.devices.length} dispozitive din ${r.total} — opresc.`);
    let kept = 0;
    for (const d of r.devices) {
      if (seen.has(d.id.id)) continue;
      seen.add(d.id.id);
      devices.push(d);
      kept++;
    }
    perCustomer.push({ name: c.name, total: r.total, kept });
    log(`  ${c.name}: ${r.total} dispozitive, ${kept} păstrate (${Math.round((Date.now() - t0) / 1000)} s)`);
  }
  return { devices, perCustomer };
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
      if (++streak >= 3) throw new Error(`SCADA nu răspunde (3 loturi la rând eșuate): ${(e as Error).message}`);
      for (const id of ids) failed.add(id);
      log(`  lot ${i}–${i + ids.length} eșuat: ${(e as Error).message}`);
    }
    if ((i / batch) % 10 === 9 || i + batch >= devices.length) log(`  SCADA: ${Math.min(i + batch, devices.length)} / ${devices.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
    if (i + batch < devices.length && pauseMs() > 0) await new Promise((r) => setTimeout(r, pauseMs()));
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

/** Amprenta conținutului unui document (fără `_id`, `updatedAt`, `h`): același calcul la sincronizare și la integrare, ca „neschimbat” să însemne același lucru. */
export const hashBody = (body: unknown): string => createHash("sha1").update(JSON.stringify(body)).digest("hex").slice(0, 20);

/** `opts.billById`: rândul de facturare al unor dispozitive, dat direct (după id), în loc de legătura prin numărul radio — folosit de integrare, unde mesajul vine cu facturarea lui. */
export function buildDocs(devices: Dev[], billing: Bill[], latest: Map<string, TbLatest>, now: Date, opts?: { billById?: Map<string, Bill> }): { docs: MeterDoc[]; stats: SyncStats } {
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
    const bill = opts?.billById?.has(id) ? opts.billById.get(id) ?? null : serial && owner.get(serial) === id ? byRadio.get(serial) ?? null : null;
    if (bill) stats.matched++;
    else stats.devicesWithoutBilling++;

    // filiala: din facturare (FIL), altfel din clientul ThingsBoard
    const billFil = bill ? clean(bill.FIL) : "";
    const custF = d.customerId?.id ? CUSTOMER_FIL[d.customerId.id] ?? custFil[d.customerId.id] ?? "" : ""; // întâi filiala știută a clientului, apoi cea dedusă din facturare
    const fil = billFil || custF;
    if (billFil) stats.branchFromBilling++; else if (custF) stats.branchFromCustomer++; else stats.branchUnknown++;
    if (billFil && custF && billFil !== custF) stats.branchConflicts++;

    // citiri curente
    const vol = tsv(l, "Volume_m3_Total");
    const volTs = tsv(l, "Volume_m3_Total_ts");
    const v = vol ? num(vol.v) : null;
    const lastAct = num(av(l, "SERVER_ATTRIBUTE", "lastActivityTime"));
    // activitatea = momentul CITIRII de volum (Volume_m3_Total_ts: ora la care contorul a citit, cu secunde); dacă lipsește, momentul în care a ajuns Volume_m3_Total
    let ts = volTs && volTs.t > 0 ? volTs.t : vol?.t ?? 0;
    if (!ts) for (const k of ["rssi", "loRaSNR", "decodeTime", "fCnt"]) ts = Math.max(ts, l.TIME_SERIES?.[k]?.ts ?? 0);
    if (!ts && lastAct) ts = lastAct;

    const flag = (k: string) => tsv(l, k)?.v === "true";
    let fl = 0;
    if (flag("batteryTooLowVoltage")) fl |= FLAG.BATT;
    if (flag("buttonPressed")) fl |= FLAG.BTN;
    if (flag("magnet")) fl |= FLAG.MAG;
    if (["batteryTooLowVoltage", "buttonPressed", "magnet", "offline"].some((k) => tsv(l, k))) fl |= FLAG.STATUS;
    const activeAttr = av(l, "SERVER_ATTRIBUTE", "active");
    if (activeAttr === "false") fl |= FLAG.INACTIVE;
    else if (activeAttr === "true") fl |= FLAG.ACTIVE;
    if (av(l, "SERVER_ATTRIBUTE", "Aragaz") === "true") fl |= FLAG.ARAGAZ;
    if (av(l, "SERVER_ATTRIBUTE", "Cazan") === "true") fl |= FLAG.CAZAN;
    if (av(l, "SERVER_ATTRIBUTE", "Incalzire") === "true") fl |= FLAG.INCALZ;
    const attrTime = (k: string): number | null => { const n = num(av(l, "SERVER_ATTRIBUTE", k)); return n !== null && n >= 1e11 && n <= 4e12 ? Math.round(n) : null; };
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
      sp: clean(bill?.SP_ID), cp: clean(av(l, "SERVER_ATTRIBUTE", "ContPersonal")), sn2: clean(av(l, "SERVER_ATTRIBUTE", "ContorNr")) || clean(bill?.CONTOR_SN),
      sr: clean(bill?.STREET), hs: clean(bill?.HOUSE), apt: clean(bill?.APARTMENT),
      il: num(av(l, "SERVER_ATTRIBUTE", "Instalation_Litres")), cl: attrTime("Data_Calibrarii"),
      ac: attrTime("lastActivityTime"),
      ia: attrTime("inactivityAlarmTime"),
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
    docs.push({ _id: id, updatedAt: now, h: hashBody(body), ...body });
  }
  return { docs, stats };
}
