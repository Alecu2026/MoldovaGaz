/**
 * Verifică motorul de contoare față de implementări „naive”, pe date sintetice (nu atinge nicio bază de date și nicio rețea):   npm run check
 *  - filtre (liste SAU, intervale, filială, oraș, căutare) și sortări;
 *  - agregări (totalurile pe fiecare dimensiune trebuie să iasă egale cu numărătoarea naivă);
 *  - actualizări pe loc (delta cu rânduri modificate + noi), snapshot IndexedDB;
 *  - combinarea facturare ↔ dispozitive ↔ ThingsBoard (lib/meter-sync.ts).
 */
import { aggregate, makeCtx, FRESH_EDGES } from "../lib/meter-aggregate";
import { NO_FILTERS, runFilter, type Filters, type Sort } from "../lib/meter-filter";
import { MeterStore } from "../lib/meter-store";
import { ALERT_FLAGS, FLAG, type ColsWire, type DatasetWire, type DeltaWire } from "../lib/meter-shared";
import { buildDocs, type Bill, type Dev } from "../lib/meter-sync";
import { assertReadOnly } from "../lib/thingsboard";
import { pack, unpack, type Pts } from "../lib/meter-history";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TbLatest } from "../lib/thingsboard";

let seed = 11;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
let bad = 0;
const check = (name: string, ok: boolean, extra = "") => {
  if (!ok) bad++;
  console.log(`${ok ? "OK  " : "FAIL"} ${name}${extra ? " " + extra : ""}`);
};

/* ───────── 1) store, filtre, agregări ───────── */
const N = 20000;
const dict = {
  ap: ["app1", "app2", "app3"],
  gw: ["gwA", "gwB", "gwC", "gwD"],
  ty: ["LastEventSeq", "DeviceStatus", "CurrentData"],
  br: ["01 · Chișinău", "05 · Comrat", "20 · Orhei"],
  ct: ["Comrat", "Orhei", "Cahul", "Chisinau", "Rezina"],
  pf: ["Comrat_Gas_Meter_DP", "Jooby_Gas_Meter_DP", "Defectate_Jooby_Gaz"],
};
const emptyCols = (): ColsWire => ({ id: [], ts: [], nm: [], eu: [], q: [], ap: [], gw: [], br: [], ct: [], pf: [], rssi: [], snr: [], fr: [], fl: [], fc: [], pt: [], tm: [], val: [], bat: [], dc: [], mc: [] });
const t0 = Date.now() - 20 * 86400_000;
const row = (c: ColsWire, i: number, id: string) => {
  const never = rnd() < 0.05;
  c.id.push(id);
  c.ts.push(never ? 0 : t0 + Math.floor(rnd() * 20 * 86400_000));
  c.nm.push(`S${["2154", "2155", "2137"][i % 3]}_${String(70000 + i).padStart(8, "0")}_${2021 + (i % 5)}`);
  c.eu.push(`001a7988${(0x16000000 + i).toString(16)}`);
  c.q.push(`${String(70000 + i).padStart(8, "0")} ${1000000000 + i} ${["Strada Mare", "Strada Noua", "Bd. Libertatii"][i % 3]} ${["Ion", "Maria", "Vasile"][i % 3]} Popescu`);
  c.ap.push(Math.floor(rnd() * 3));
  c.gw.push(Math.floor(rnd() * 5) - 1);
  c.br.push(Math.floor(rnd() * 4) - 1);
  c.ct.push(Math.floor(rnd() * 6) - 1);
  c.pf.push(Math.floor(rnd() * 3));
  c.rssi.push(rnd() < 0.1 ? null : -Math.floor(70 + rnd() * 60));
  c.snr.push(rnd() < 0.1 ? null : Math.round((rnd() * 30 - 18) * 10) / 10);
  c.fr.push([868100, 868300, 868500, 0][Math.floor(rnd() * 4)]);
  c.fl.push(Math.floor(rnd() * 256));
  c.fc.push(rnd() < 0.05 ? -1 : Math.floor(rnd() * 50000));
  c.pt.push(rnd() < 0.9 ? 1 : Math.floor(rnd() * 200));
  c.tm.push(rnd() < 0.2 ? 0 : (1 << Math.floor(rnd() * 3)) | (rnd() < 0.2 ? 1 << Math.floor(rnd() * 3) : 0));
  c.val.push(rnd() < 0.15 ? null : Math.round((rnd() * 20000 - (rnd() < 0.02 ? 5000 : 0)) * 1000) / 1000);
  c.bat.push(rnd() < 0.3 ? null : Math.round(rnd() * 1000) / 10);
  c.dc.push(rnd() < 0.3 ? null : Math.floor(rnd() * 3000));
  c.mc.push(rnd() < 0.3 ? null : Math.floor(rnd() * 90000));
};
const cols = emptyCols();
for (let i = 0; i < N; i++) row(cols, i, `id-${i}`);
const st = MeterStore.fromWire({ v: 3, gen: "g", head: N, total: N, dict: structuredClone(dict), cols } as DatasetWire);
st.prepare();
const now = Date.now();
const F = (p: Partial<Filters>): Filters => ({ ...NO_FILTERS, ...p });
const SORT: Sort = { key: "ts", dir: -1 };

for (let k = 1; k < st.n; k++) if (st.ts[st.order[k - 1]] < st.ts[st.order[k]]) throw new Error("order nesortat la " + k);
check("order sortat după ultima citire", true);

const naive = (f: Filters): number[] => {
  const L = (s: string) => (s ? s.split("|") : []);
  const num = (s: string, d: number) => (s === "" ? d : Number(s));
  const from = f.from || f.to ? (f.from ? Date.parse(f.from) : -Infinity) : f.range === "24h" ? now - 86400_000 : f.range === "7d" ? now - 7 * 86400_000 : -Infinity;
  const to = f.to ? Date.parse(f.to) : Infinity;
  const timeOn = from > -Infinity || to < Infinity;
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean);
  const out: number[] = [];
  for (const i of st.order) {
    const v = st.view(i);
    const model = /^S?N?(\d{4})_/.exec(v.name)?.[1] ?? "alt", year = /_(\d{4})$/.exec(v.name)?.[1] ?? "alt";
    if (timeOn && (v.ts < from || v.ts > to)) continue;
    if (f.app && !L(f.app).includes(v.app)) continue;
    if (f.gw && !(v.gw && L(f.gw).includes(v.gw))) continue;
    if (f.type && !v.types.some((t) => L(f.type).includes(t))) continue;
    if (f.branch && !(v.branch && L(f.branch).includes(v.branch))) continue;
    if (f.city && !(v.city && L(f.city).includes(v.city))) continue;
    if (f.profile && !(v.profile && L(f.profile).includes(v.profile))) continue;
    if (f.name && !f.name.toLowerCase().split(/\s+/).filter(Boolean).every((w) => `${v.name} ${v.eui}`.toLowerCase().includes(w))) continue;
    if (f.dev && v.eui !== f.dev && v.name !== f.dev && v.id !== f.dev) continue;
    if (f.flag) {
      const m = L(f.flag).reduce((a, k) => a | (k === "alert" ? ALERT_FLAGS : k === "batt" ? FLAG.BATT : k === "offline" ? FLAG.OFFLINE : k === "button" ? FLAG.BTN : k === "magnet" ? FLAG.MAG : k === "dup" ? FLAG.DUP : FLAG.INACTIVE), 0);
      if (!(v.fl & m)) continue;
    }
    if (f.billed === "1" && !(v.fl & FLAG.BILLED)) continue;
    if (f.billed === "0" && v.fl & FLAG.BILLED) continue;
    if (f.fr && !L(f.fr).includes(String(v.freqKhz))) continue;
    if (f.port && !L(f.port).includes(String(v.pt))) continue;
    if (f.model && !L(f.model).includes(model)) continue;
    if (f.year && !L(f.year).includes(year)) continue;
    const rng = (x: number | null, a: string, b: string) => !(a || b) || (x !== null && x >= num(a, -Infinity) && x <= num(b, Infinity));
    if (!rng(v.rssi, f.rssiMin, f.rssiMax) || !rng(v.snr, f.snrMin, f.snrMax) || !rng(v.val, f.valMin, f.valMax) || !rng(v.bat, f.batMin, f.batMax) || !rng(v.dc, f.dcMin, f.dcMax)) continue;
    if ((f.fcMin || f.fcMax) && (v.fc < 0 || v.fc < num(f.fcMin, -Infinity) || v.fc > num(f.fcMax, Infinity))) continue;
    if (words.length) {
      const text = `${v.name} ${v.eui} ${st.q[i]}`.toLowerCase();
      if (!words.every((w) => text.includes(w) || (v.gw ?? "").toLowerCase().includes(w) || v.types.some((t) => t.toLowerCase().includes(w)) || (/^-?\d+(\.\d+)?$/.test(w) && (v.fc === Number(w) || v.val === Number(w))))) continue;
    }
    out.push(i);
  }
  return out;
};

const cases: [string, Filters][] = [
  ["filială", F({ branch: "05 · Comrat" })], ["filiale multi", F({ branch: "05 · Comrat|20 · Orhei" })], ["oraș", F({ city: "Rezina" })], ["oraș multi", F({ city: "Cahul|Orhei" })],
  ["profil", F({ profile: "Defectate_Jooby_Gaz" })], ["aplicație", F({ app: "app1|app3" })], ["concentrator", F({ gw: "gwA|gwD" })], ["tip multi", F({ type: "DeviceStatus|CurrentData" })],
  ["serie repetată", F({ flag: "dup" })], ["serie repetată + offline", F({ flag: "dup|offline" })],
  ["stare multi", F({ flag: "batt|button" })], ["stare alert", F({ flag: "alert" })], ["inactiv", F({ flag: "inactive" })], ["cu facturare", F({ billed: "1" })], ["fără facturare", F({ billed: "0" })],
  ["frecvență", F({ fr: "868300" })], ["port", F({ port: "1" })], ["port altele", F({ port: "17|42" })], ["model", F({ model: "2155" })], ["model multi", F({ model: "2154|2137" })], ["an", F({ year: "2023|2025" })],
  ["volume", F({ valMin: "1000", valMax: "9000" })], ["volume ≥", F({ valMin: "15000" })], ["consum zi", F({ dcMin: "100", dcMax: "900" })], ["baterie", F({ batMax: "20" })],
  ["rssi", F({ rssiMin: "-110", rssiMax: "-90" })], ["snr", F({ snrMin: "-5", snrMax: "5" })], ["fCnt", F({ fcMin: "100", fcMax: "5000" })], ["24h", F({ range: "24h" })], ["7 zile", F({ range: "7d" })],
  ["căutare nume", F({ q: "S2154_0007" })], ["căutare adresă", F({ q: "strada mare" })], ["căutare consumator + oraș", F({ q: "maria 70" })], ["căutare gateway", F({ q: "gwb" })], ["căutare tip", F({ q: "status" })],
  ["căutare numerică", F({ q: "42" })], ["dev id", F({ dev: "id-7" })],
  ["nume contor (antet)", F({ name: "s2154_0007" })], ["nume + devEUI (antet)", F({ name: "001a7988 s2155" })], ["nume NU caută în adresă", F({ name: "strada mare" })],
  ["antete combinate", F({ name: "s21", branch: "05 · Comrat", city: "Comrat|Orhei", flag: "offline|batt", rssiMin: "-115", rssiMax: "-80", batMin: "10", valMin: "100", dcMax: "2500", range: "7d" })],
  ["combinat", F({ branch: "05 · Comrat", city: "Comrat|Orhei", profile: "Comrat_Gas_Meter_DP|Jooby_Gas_Meter_DP", dcMin: "50", flag: "offline", range: "7d", q: "popescu" })],
  ["gateway inexistent", F({ gw: "nu-exista" })], ["filială inexistentă", F({ branch: "nu-exista" })],
];
for (const [name, f] of cases) {
  const r = runFilter(st, f, SORT, now);
  const got = Array.from(r.idx), want = naive(f);
  check(`filtru ${name.padEnd(26)}`, got.length === want.length && got.every((x, k) => x === want[k]) && r.matched === want.length, String(got.length));
}
// totalurile din rezultatul filtrului
{
  const f = F({ branch: "05 · Comrat" });
  const r = runFilter(st, f, SORT, now), want = naive(f);
  check("total volum și alerte din filtru", r.alerts === want.filter((i) => st.fl[i] & ALERT_FLAGS).length && Math.abs(r.volume - want.reduce((s, i) => s + (st.val[i] >= 0 ? st.val[i] : 0), 0)) < 1e-6);
}
// sortări
for (const key of ["dev", "br", "gw", "rssi", "snr", "val", "bat", "dc", "fc"] as const) {
  for (const dir of [1, -1] as const) {
    const r = runFilter(st, NO_FILTERS, { key, dir }, now);
    const k = st.ranks();
    const get = (i: number) => (key === "dev" ? k.nm[i] : key === "br" ? (st.br[i] < 0 ? NaN : k.br[st.br[i]]) : key === "gw" ? (st.gw[i] < 0 ? NaN : k.gw[st.gw[i]]) : key === "fc" ? (st.fc[i] < 0 ? NaN : st.fc[i]) : (st[key] as ArrayLike<number>)[i]);
    let ok = r.idx.length === st.n, seenNaN = false;
    for (let j = 0; j < r.idx.length && ok; j++) {
      const x = get(r.idx[j]);
      if (x !== x) seenNaN = true;
      else if (seenNaN) ok = false;
      if (j > 0 && ok) { const y = get(r.idx[j - 1]); if (x === x && y === y && (dir === 1 ? y > x : y < x)) ok = false; }
    }
    check(`sortare ${key} ${dir === 1 ? "↑" : "↓"}`, ok);
  }
}

// agregări
for (const [label, f] of [["toate", F({})], ["filtrate", F({ branch: "05 · Comrat|20 · Orhei", rssiMin: "-120" })]] as [string, Filters][]) {
  const idx = label === "toate" ? null : runFilter(st, f, SORT, now).idx;
  const ctx = makeCtx(st, f, now);
  const a = aggregate(st, idx, ctx);
  const rows = idx ? Array.from(idx) : Array.from({ length: st.n }, (_, i) => i);
  const sum = (x: ArrayLike<number>) => Array.from(x).reduce((p, q) => p + q, 0);
  check(`agregare ${label}: n`, a.n === rows.length);
  check(`agregare ${label}: RSSI / SNR / baterie + lipsă = n`, sum(a.rssi) + a.rssiNone === rows.length && sum(a.snr) + a.snrNone === rows.length && sum(a.bat) + a.batNone === rows.length);
  check(`agregare ${label}: volum / consum + lipsă = n`, sum(a.val) + a.valNone === rows.length && sum(a.dc) + a.dcNone === rows.length);
  check(`agregare ${label}: filiale / orașe / profile / aplicații`, sum(a.brs) === rows.filter((i) => st.br[i] >= 0).length && sum(a.cts) === rows.filter((i) => st.ct[i] >= 0).length && sum(a.pfs) === rows.length && sum(a.apps) === rows.length);
  const volBr = new Float64Array(dict.br.length);
  for (const i of rows) if (st.br[i] >= 0 && st.val[i] >= 0) volBr[st.br[i]] += st.val[i];
  check(`agregare ${label}: volum pe filială`, Array.from(volBr).every((v, k) => Math.abs(v - a.brVol[k]) < 1e-6));
  check(`agregare ${label}: ore = zile = rânduri cu citire`, sum(a.hour) === rows.filter((i) => st.ts[i] > 0).length && sum(a.wday) === sum(a.hour));
  check(`agregare ${label}: prospețime = n`, sum(a.fresh) === rows.length && a.fresh[6] === rows.filter((i) => st.ts[i] === 0).length);
  check(`agregare ${label}: fresh < 1 oră`, a.fresh[0] === rows.filter((i) => st.ts[i] > 0 && now - st.ts[i] < FRESH_EDGES[1]).length);
  check(`agregare ${label}: gateway + fără = n`, sum(a.gws) + a.noGw === rows.length);
  check(`agregare ${label}: frecvențe = porturi = modele = ani = n`, sum(a.freq) === rows.length && sum(a.ports) === rows.length && sum(a.models) === rows.length && sum(a.years) === rows.length);
  check(`agregare ${label}: stări`, a.flags.batt === rows.filter((i) => st.fl[i] & FLAG.BATT).length && a.flags.alert === rows.filter((i) => st.fl[i] & ALERT_FLAGS).length && a.flags.billed + a.flags.noBilled === rows.length);
  const inTime = rows.filter((i) => st.ts[i] > 0 && st.ts[i] >= ctx.tStart && st.ts[i] < ctx.tStart + ctx.tN * ctx.tStep).length;
  check(`agregare ${label}: găleți de timp`, sum(a.time) === inTime, `${ctx.tN} găleți`);
  const topOk = a.topDc.every((x, k) => k === 0 || a.topDc[k - 1][1] >= x[1]) && a.topDc.length === Math.min(10, rows.filter((i) => st.dc[i] >= 0).length);
  check(`agregare ${label}: top consum ordonat`, topOk);
}

/* ───────── 2) actualizări pe loc (delta) + snapshot ───────── */
{
  const s2 = MeterStore.fromWire({ v: 3, gen: "g", head: 3, total: 3, dict: structuredClone(dict), cols: (() => { const c = emptyCols(); for (let i = 0; i < 3; i++) row(c, i, `m-${i}`); return c; })() } as DatasetWire);
  const before = { ts1: s2.ts[1], n: s2.n };
  const dc = emptyCols();
  row(dc, 1, "m-1"); // existent → suprascris
  dc.ts[0] = Date.now() + 1000; dc.val[0] = 12345.678; dc.nm[0] = "S2154_99999999_2026";
  row(dc, 7, "m-NOU"); // nou
  dc.ts[1] = Date.now() + 2000; dc.ct[1] = 5; // oraș nou din dicționar
  const delta: DeltaWire = { v: 3, gen: "g", head: 5, total: 4, dict: { ap: [], gw: [], ty: [], br: [], ct: ["Edinet"], pf: [] }, cols: dc };
  const changed = s2.applyDelta(delta);
  check("delta: 2 rânduri atinse (1 modificat + 1 nou)", changed === 2 && s2.n === 4, `n=${s2.n}`);
  check("delta: rândul modificat e suprascris, nu duplicat", s2.id.slice(0, s2.n).filter((x) => x === "m-1").length === 1 && s2.val[1] === 12345.678 && s2.nm[1] === "S2154_99999999_2026" && s2.ts[1] !== before.ts1);
  check("delta: dicționar extins și `order` re-sortat", s2.dict.ct.includes("Edinet") && (() => { for (let k = 1; k < s2.n; k++) if (s2.ts[s2.order[k - 1]] < s2.ts[s2.order[k]]) return false; return s2.order[0] === 3; })());
  check("delta: model/an recalculate din numele nou", s2.models[s2.model[1]] === "2154" && s2.years[s2.year[1]] === "2026");
  check("delta: gen diferit respins", s2.applyDelta({ ...delta, gen: "ALTA" }) === -1);
  check("delta: căutare vede textul nou", runFilter(s2, F({ q: "99999999" }), SORT, Date.now() + 5000).matched === 1);
  const s3 = MeterStore.fromSnapshot(structuredClone(s2.snapshot()));
  const a = runFilter(s2, F({ q: "popescu" }), SORT, Date.now() + 5000), b = runFilter(s3, F({ q: "popescu" }), SORT, Date.now() + 5000);
  check("snapshot: același rezultat și același cursor", a.matched === b.matched && s3.head === s2.head && s3.gen === s2.gen && s3.n === s2.n);
  // un delta aplicat peste copia din IndexedDB găsește rândurile după id
  check("snapshot: delta se aplică și peste copie", s3.applyDelta({ ...delta, head: 6, cols: (() => { const c = emptyCols(); row(c, 9, "m-NOU"); return c; })() }) === 1 && s3.n === 4);
}

/* ───────── 3) combinarea facturare ↔ dispozitive ↔ ThingsBoard ───────── */
{
  const dev = (id: string, name: string, customer: string, type = "Comrat_Gas_Meter_DP"): Dev => ({ id: { id }, name, type, createdTime: 1, customerId: { id: customer } });
  const devices: Dev[] = [];
  const billing: Bill[] = [];
  // 25 contoare Comrat (FIL 05) cu facturare, 25 Orhei (FIL 20); câteva cazuri speciale
  for (let i = 0; i < 25; i++) {
    devices.push(dev(`c${i}`, `S2154_${String(1000 + i).padStart(8, "0")}_2022`, "CUST-COMRAT"));
    billing.push({ NUM_RADIO: String(1000 + i).padStart(8, "0"), FIL: "05", CITY: "Comrat", ACCT_ID: `A${i}`, ENTITY_NAME: "Ion Popescu", STREET: "Str. Mare", UPDATED_DATE: "2026-01-01" });
    devices.push(dev(`o${i}`, `S2155_${String(2000 + i).padStart(8, "0")}_2023`, "CUST-ORHEI", "Jooby_Gas_Meter_DP"));
    billing.push({ NUM_RADIO: String(2000 + i), FIL: "20", CITY: "Orhei", ACCT_ID: `B${i}`, UPDATED_DATE: "2026-01-01" }); // număr radio fără zerouri în față
  }
  devices.push(dev("nobill", "S2154_00009999_2024", "CUST-COMRAT")); // fără facturare: filiala din client
  devices.push(dev("weird", "LWM-2503-00001", "CUST-COMRAT")); // nume nestandard
  devices.push(dev("dupA", "SN2154_00001000_2022", "CUST-EDGE", "Edge_Gas_Meter_DP")); // aceeași serie ca c0, alt client (backup)
  billing.push({ NUM_RADIO: "00001000", FIL: "05", CITY: "Duplicat", UPDATED_DATE: "2025-01-01" }); // dublură de facturare, mai veche
  billing.push({ NUM_RADIO: "00007777", FIL: "05", CITY: "Fără modul" }); // facturare fără dispozitiv
  const tel = (kv: Record<string, string>): TbLatest => ({ TIME_SERIES: Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, { ts: 1_700_000_000_000, value: v }])), SERVER_ATTRIBUTE: { devEUI: { ts: 1, value: "001A798816000001" }, active: { ts: 1, value: "false" }, ContPersonal: { ts: 1, value: "0123" } }, CLIENT_ATTRIBUTE: {} });
  const latest = new Map<string, TbLatest>([
    ["c0", tel({ Volume_m3_Total: "10413.347", rssi: "-110", loRaSNR: "-5.5", Frequency: "868.1", Concentrator: "M4_Comrat_Gaz", offline: "true", batteryTooLowVoltage: "false", battery: '{"remCapacity":99.61}', dailyConsumption: "260", ieType: "LastEventSeq", applicationName: "App_X", fCnt: "13872", fPort: "1" })],
  ]);
  const { docs, stats } = buildDocs(devices, billing, latest, new Date(0));
  const by = new Map(docs.map((d) => [d._id, d]));
  check("sync: toate dispozitivele au document", docs.length === devices.length);
  check("sync: legătură pe NUM_RADIO (cu și fără zerouri în față)", by.get("c3")!.bill?.ACCT_ID === "A3" && by.get("o7")!.bill?.ACCT_ID === "B7");
  check("sync: filiala din facturare", by.get("c3")!.s.br === "05 · Comrat" && by.get("o7")!.s.br === "20 · Orhei");
  check("sync: filiala dedusă din client când lipsește facturarea", by.get("nobill")!.bill === null && by.get("nobill")!.s.br === "05 · Comrat" && !(by.get("nobill")!.s.fl & FLAG.BILLED));
  check("sync: filială pe client dedusă din perechi", stats.custFil["CUST-COMRAT"] === "05" && stats.custFil["CUST-ORHEI"] === "20");
  check("sync: nume nestandard fără facturare, dar cu filială din client", by.get("weird")!.bill === null && by.get("weird")!.s.br === "05 · Comrat");
  check("sync: dubla (aceeași serie, alt client) NU primește facturarea", by.get("dupA")!.bill === null && by.get("c0")!.bill?.CITY === "Comrat");
  check("sync: statistici", stats.billingWithoutDevice === 1 && stats.nonStandardNames === 1 && stats.duplicateBilling === 1 && stats.duplicateSerials === 1);
  const s = by.get("c0")!.s;
  check("sync: valori curente", s.v === 10413.347 && s.r === -110 && s.sn === -5.5 && s.f === 868100 && s.g === "M4_Comrat_Gaz" && s.b === 99.61 && s.dc === 260 && s.ty === "LastEventSeq" && s.fc === 13872 && s.pt === 1 && s.a === "App_X");
  check("sync: stare (offline, inactiv, facturat) și ts", !!(s.fl & FLAG.OFFLINE) && !!(s.fl & FLAG.INACTIVE) && !!(s.fl & FLAG.BILLED) && s.t === 1_700_000_000_000);
  check("sync: contor fără telemetrie → fără citire (nu zero)", by.get("c5")!.s.v === null && by.get("c5")!.s.t === 0 && by.get("c5")!.s.r === null);
  check("sync: ContPersonal rămâne text (zerouri păstrate), devEUI cu litere mici", by.get("c0")!.attrs.ContPersonal === "0123" && by.get("c0")!.s.e === "001a798816000001");
  check("sync: căutarea include număr radio, cont, adresă, consumator", /00001000/.test(s.q) && /A0/.test(s.q) && /Str\. Mare/.test(s.q) && /Ion Popescu/.test(s.q));
  const again = buildDocs(devices, billing, latest, new Date(5)).docs.find((d) => d._id === "c0")!;
  check("sync: hash stabil (nu depinde de ora sincronizării)", again.h === by.get("c0")!.h);
  const dupA = by.get("dupA")!, c0 = by.get("c0")!;
  check("sync: ambele dispozitive cu aceeași serie sunt marcate „Serie repetată”", !!(dupA.s.fl & FLAG.DUP) && !!(c0.s.fl & FLAG.DUP));
  check("sync: dupWith arată celălalt dispozitiv (nume + profil), nu pe el însuși", c0.tb.dupWith?.length === 1 && /^SN2154_00001000_2022 \(Edge_Gas_Meter_DP\)$/.test(c0.tb.dupWith[0]) && !!dupA.tb.dupWith?.[0].startsWith("S2154_00001000_2022"));
  check("sync: contoarele cu serie unică NU sunt marcate", !(by.get("c5")!.s.fl & FLAG.DUP) && by.get("c5")!.tb.dupWith === undefined && docs.filter((d) => d.s.fl & FLAG.DUP).length === 2);
  check("sync: fără chei LoRaWAN în documente", !JSON.stringify(docs).match(/APPKEY|NWKSKEY|APPSKEY/i));
}

/* ───────── 4) DOAR CITIRE față de ThingsBoard și de sursele din LAN ───────── */
{
  const id = "de219e81-9c2d-11ed-9f20-9d903c1d67f8";
  const ok = (m: string, p: string) => { try { assertReadOnly(m, p); return true; } catch { return false; } };
  check("read-only: permise doar login, entitiesQuery/find și citirea seriilor",
    ok("POST", "/api/auth/login") && ok("POST", "/api/entitiesQuery/find") && ok("GET", `/api/plugins/telemetry/DEVICE/${id}/values/timeseries?keys=Volume_m3_Total_ts&agg=NONE`));
  check("read-only: scrierea de atribute / telemetrie e refuzată", !ok("POST", `/api/plugins/telemetry/DEVICE/${id}/attributes/SERVER_SCOPE`) && !ok("POST", `/api/plugins/telemetry/DEVICE/${id}/timeseries/ANY`) && !ok("POST", `/api/plugins/telemetry/${id}/SERVER_SCOPE`));
  check("read-only: PUT / DELETE / PATCH refuzate chiar pe căile permise", !ok("PUT", "/api/entitiesQuery/find") && !ok("DELETE", `/api/plugins/telemetry/DEVICE/${id}/values/timeseries?keys=x`) && !ok("PATCH", "/api/auth/login"));
  check("read-only: dispozitive, clienți, alarme, reguli, utilizatori — refuzate", !ok("POST", "/api/device") && !ok("DELETE", `/api/device/${id}`) && !ok("POST", "/api/customer") && !ok("POST", "/api/alarm") && !ok("POST", "/api/user") && !ok("GET", "/api/device/credentials/x") && !ok("POST", "/api/rpc/oneway/x"));
  check("read-only: GET pe alte căi refuzat (doar ce e în lista de permise)", !ok("GET", "/api/tenant/devices?pageSize=1") && !ok("GET", `/api/plugins/telemetry/DEVICE/${id}/values/attributes/SERVER_SCOPE`));
  // codul sursă: nicio altă cale de ieșire către rețea în afară de clientul ThingsBoard și de citirea celor două surse
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => (n === "node_modules" || n === ".next" || n.startsWith(".") ? [] : statSync(join(d, n)).isDirectory() ? walk(join(d, n)) : /\.(ts|tsx)$/.test(n) ? [join(d, n)] : []));
  const files = ["app", "lib", "scripts"].flatMap(walk).filter((f) => !f.endsWith("check-engine.ts"));
  const fetches = files.flatMap((f) => (readFileSync(f, "utf8").match(/\bfetch\(/g) ?? []).map(() => f.replace(/\\/g, "/")));
  const allowedFetch = new Set(["lib/thingsboard.ts", "lib/meter-sync.ts", "app/components/useMeterStore.ts", "app/components/MeterDetail.tsx"]);
  check("read-only: fetch() doar în fișierele așteptate", fetches.every((f) => allowedFetch.has(f)), [...new Set(fetches)].join(", "));
  const mutating = files.filter((f) => /method:\s*"(PUT|DELETE|PATCH)"|\.(deleteOne|deleteMany|drop|updateMany|updateOne|insertOne|insertMany|replaceOne|bulkWrite)\(/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/"));
  // scrieri în baza NOASTRĂ: doar sesiuni / utilizator (login, seed) și colecția `meters` (sincronizare); niciodată în surse
  const allowedWrites = new Set(["lib/session.ts", "scripts/seed-user.ts", "scripts/sync-meters.ts", "scripts/load-history.ts"]);
  check("read-only: scrieri în baza de date doar în sesiuni, seed:user, sync-meters și load-history", mutating.every((f) => allowedWrites.has(f)), mutating.join(", "));
  const syncSrc = readFileSync("scripts/sync-meters.ts", "utf8");
  const syncCollections = syncSrc.match(/client\.db\(\)\.collection[^\n]*/g) ?? [];
  check("read-only: sync-meters scrie doar în colecția `meters` (METERS_COLLECTION)", syncCollections.length >= 1 && syncCollections.every((l) => /METERS_COLLECTION \|\| "meters"/.test(l)), `${syncCollections.length} accesări`);
}

/* ───────── 5) istoric împachetat ───────── */
{
  const pts: Pts = [[1_700_000_000_000, 10413.347], [1_700_003_600_000, 10413.879], [1_700_007_200_000, 0.001], [1_795_342_318_000, 99023.6]];
  const packed = pack(pts);
  const back = unpack(packed);
  check("istoric: împachetare / despachetare exactă (momente la secundă, valori Float64)", back.length === 4 && back.every((p, i) => p[0] === pts[i][0] && p[1] === pts[i][1]));
  check("istoric: citit din Buffer / Binary (ca din Mongo) și gol", unpack({ n: packed.n, t: Buffer.from(packed.t, "base64"), v: { buffer: Buffer.from(packed.v, "base64") } }).length === 4 && unpack(pack([])).length === 0);
  check("istoric: 12 octeți / punct", Buffer.from(packed.t, "base64").length + Buffer.from(packed.v, "base64").length === 4 * 12);
}

console.log(bad ? `\n${bad} EȘECURI` : "\nToate verificările au trecut.");
process.exit(bad ? 1 : 0);
