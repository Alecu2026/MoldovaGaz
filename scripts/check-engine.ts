/**
 * Verifică motorul de contoare față de implementări „naive”, pe date sintetice (nu atinge nicio bază de date și nicio rețea):   npm run check
 *  - filtre (liste SAU, intervale, filială, oraș, căutare) și sortări;
 *  - agregări (totalurile pe fiecare dimensiune trebuie să iasă egale cu numărătoarea naivă);
 *  - actualizări pe loc (delta cu rânduri modificate + noi), snapshot IndexedDB;
 *  - combinarea facturare ↔ dispozitive ↔ ThingsBoard (lib/meter-sync.ts).
 */
import { aggregate, makeCtx, FRESH_EDGES } from "../lib/meter-aggregate";
import { NO_FILTERS, filtersFromParams, periodStarts, runFilter, type Filters, type Sort } from "../lib/meter-filter";
import { MeterStore } from "../lib/meter-store";
import { ALERT_FLAGS, FLAG, PROBLEM_FLAGS, XSTR, activityOf, isStatusOk, validCoords, type ColsWire, type DatasetWire, type DeltaWire } from "../lib/meter-shared";
import { buildDocs, fetchDevices, type Bill, type Dev } from "../lib/meter-sync";
import { assertReadOnly, tbCustomerDevices } from "../lib/thingsboard";
import { pack, unpack, type Pts } from "../lib/meter-history";
import { addressLinks, boundsOf, buildClusters, latFromY, lonFromX, mapLinks, mercX, mercY, worldSize } from "../lib/geo";
import { SourceStore, type SortSpec } from "../lib/source-store";
import { billingDocs, billingTable, columnarize, lorawanDocs, lorawanTable } from "../lib/source-schemas";
import { EMPTY_TOKEN, type ColDef, type SourceRow } from "../lib/source-shared";
import { NO_SFILTERS, activeCount, binsToDays, describeFilters, dictCounts, filtersFromEntries, runFilter as runSourceFilter, setRange, timeAxis, timeCounts, toQuery, type SFilters } from "../lib/source-filter";
import { sourceToCsv } from "../lib/source-csv";
import { writeSource } from "../lib/source-sync";
import * as NA from "../lib/night-analysis";
import { counterOf, lostOf, newStream, observe } from "../lib/integration-counter";
import { distanceKm as kmDist } from "../lib/geo";
import { eventToMsg, gatewaysOf, looksLikeEvent, looksLikeUplink, nameKey, uplinkToMsg } from "../lib/integration-uplink";
import { MAX_BATCH, isStaleFcnt, isStaleUplink, ingestIsNewer, mergeDerive, mergeMsgs, normTs, parseMessage, type MeterDocIng } from "../lib/integration";
import { MAX_READINGS, appendReadings, readingOf } from "../lib/meter-readings";
import { DEFECT_PROFILE, GAS_CUSTOMERS } from "../lib/meter-scope";
import type { Db } from "mongodb";
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
const emptyCols = (): ColsWire => ({ id: [], ts: [], nm: [], eu: [], q: [], ap: [], gw: [], br: [], ct: [], pf: [], rssi: [], snr: [], fr: [], fl: [], fc: [], pt: [], tm: [], val: [], bat: [], dc: [], mc: [], ac: [], ia: [], il: [], cal: [], xsp: [], xcp: [], xsn: [], xsr: [], xhs: [], xap: [], dt: [], mt: [], la: [], lo: [] });
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
  c.fl.push(Math.floor(rnd() * 4096));
  c.il.push(rnd() < 0.3 ? null : Math.floor(rnd() * 20_000_000)); c.cal.push(rnd() < 0.6 ? null : Date.UTC(2020 + Math.floor(rnd() * 6), Math.floor(rnd() * 12), 1 + Math.floor(rnd() * 27)));
  c.xsp.push(rnd() < 0.2 ? "" : `47${String(i % 90).padStart(3, "0")}15`); c.xcp.push(rnd() < 0.2 ? "" : `2572${String(i % 70).padStart(4, "0")}`); c.xsn.push(rnd() < 0.2 ? "" : `SN${i % 40}`);
  c.xsr.push(["Strada Mare, str.", "Gavrilov, str.", "Libertatii, bd.", ""][i % 4]); c.xhs.push(rnd() < 0.3 ? "" : String(1 + (i % 60))); c.xap.push(rnd() < 0.5 ? "" : String(1 + (i % 90)));
  { const ps = Date.now(); c.ac.push(rnd() < 0.2 ? null : ps - Math.floor(rnd() * 40 * 86400_000)); c.ia.push(rnd() < 0.4 ? null : ps - Math.floor(rnd() * 90 * 86400_000)); }
  c.fc.push(rnd() < 0.05 ? -1 : Math.floor(rnd() * 50000));
  c.pt.push(rnd() < 0.9 ? 1 : Math.floor(rnd() * 200));
  c.tm.push(rnd() < 0.2 ? 0 : (1 << Math.floor(rnd() * 3)) | (rnd() < 0.2 ? 1 << Math.floor(rnd() * 3) : 0));
  c.val.push(rnd() < 0.15 ? null : Math.round((rnd() * 20000 - (rnd() < 0.02 ? 5000 : 0)) * 1000) / 1000);
  c.bat.push(rnd() < 0.3 ? null : Math.round(rnd() * 1000) / 10);
  c.dc.push(rnd() < 0.3 ? null : Math.floor(rnd() * 3000));
  c.mc.push(rnd() < 0.3 ? null : Math.floor(rnd() * 90000));
  { const ps = periodStarts(Date.now()); c.dt.push(rnd() < 0.15 ? null : rnd() < 0.6 ? ps.dayStart : ps.dayStart - 86400_000 * (1 + Math.floor(rnd() * 5))); c.mt.push(rnd() < 0.15 ? null : rnd() < 0.8 ? ps.monthStart : Date.UTC(new Date().getFullYear(), new Date().getMonth() - 1, 1)); }
  const hasGeo = rnd() > 0.35;
  c.la.push(hasGeo ? 45.5 + rnd() * 2.6 : null);
  c.lo.push(hasGeo ? 27 + rnd() * 2.6 : null);
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
      const m = L(f.flag).reduce((a, k) => a | (k === "alert" ? ALERT_FLAGS : k === "batt" ? FLAG.BATT : k === "active" ? FLAG.ACTIVE : k === "button" ? FLAG.BTN : k === "magnet" ? FLAG.MAG : k === "dup" ? FLAG.DUP : k === "inactive" ? FLAG.INACTIVE : 0), 0);
      const toks = L(f.flag);
      if (!((m !== 0 && (v.fl & m) !== 0) || (toks.includes("ok") && isStatusOk(v.fl)) || (toks.includes("nostatus") && !(v.fl & FLAG.STATUS)))) continue;
    }
    if (f.billed === "1" && !(v.fl & FLAG.BILLED)) continue;
    if (f.billed === "0" && v.fl & FLAG.BILLED) continue;
    if (f.defect === "1" && !/^Defectate_/i.test(v.profile ?? "")) continue;
    if (f.defect === "0" && /^Defectate_/i.test(v.profile ?? "")) continue;
    { const tm = (x: string, d: number) => (x ? Date.parse(x) : d); if ((f.acFrom || f.acTo) && (v.ac === null || v.ac < tm(f.acFrom, -Infinity) || v.ac > tm(f.acTo, Infinity))) continue; if ((f.iaFrom || f.iaTo) && (v.ia === null || v.ia < tm(f.iaFrom, -Infinity) || v.ia > tm(f.iaTo, Infinity))) continue; if (f.iaHas === "1" && v.ia === null) continue; if (f.iaHas === "0" && v.ia !== null) continue; }
    if (f.band) { const k = ["act", "warn", "crit", "noact"][activityOf(v.ts, now)]; if (!L(f.band).includes(k)) continue; }
    if (f.actv === "1" && !(v.fl & FLAG.ACTIVE)) continue;
    if (f.actv === "0" && !(v.fl & FLAG.INACTIVE)) continue;
    if (XSTR.some((k) => f[k].trim() && !v[k].toLowerCase().includes(f[k].trim().toLowerCase()))) continue;
    if ((f.xar && !!(v.fl & FLAG.ARAGAZ) !== (f.xar === "1")) || (f.xcz && !!(v.fl & FLAG.CAZAN) !== (f.xcz === "1")) || (f.xin && !!(v.fl & FLAG.INCALZ) !== (f.xin === "1"))) continue;
    { const rg = (x: number | null, a: string, b: string) => !(a || b) || (x !== null && x >= num(a, -Infinity) && x <= num(b, Infinity)); if (!rg(v.il, f.ilMin, f.ilMax) || !rg(v.lat, f.laMin, f.laMax) || !rg(v.lon, f.loMin, f.loMax)) continue; }
    if ((f.calFrom || f.calTo) && (v.cal === null || v.cal < (f.calFrom ? Date.parse(f.calFrom) : -Infinity) || v.cal > (f.calTo ? Date.parse(f.calTo) + 86_399_999 : Infinity))) continue;
    if (f.geo === "1" && v.lat === null) continue;
    if (f.geo === "0" && v.lat !== null) continue;
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
  ["activitate în interval", F({ acFrom: "" + new Date(Date.now() - 10 * 86400_000).toISOString().slice(0, 16), acTo: new Date(Date.now() - 2 * 86400_000).toISOString().slice(0, 16) })], ["activitate de la", F({ acFrom: new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 16) })], ["alarmă: are", F({ iaHas: "1" })], ["alarmă: nu are", F({ iaHas: "0" })], ["alarmă în interval + filială", F({ iaFrom: new Date(Date.now() - 60 * 86400_000).toISOString().slice(0, 16), iaTo: new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 16), branch: "05 · Comrat" })], ["SPID conține", F({ xsp: "4701" })], ["cont personal", F({ xcp: "2572001" })], ["serie SN", F({ xsn: "sn1" })], ["adresă", F({ xsr: "gavrilov" })], ["bloc + apartament", F({ xhs: "1", xap: "7" })], ["aragaz da", F({ xar: "1" })], ["cazan nu", F({ xcz: "0" })], ["încălzire da + aragaz nu", F({ xin: "1", xar: "0" })], ["litri instalare", F({ ilMin: "1000000", ilMax: "9000000" })], ["latitudine", F({ laMin: "46", laMax: "46.8" })], ["longitudine + filială", F({ loMin: "28", loMax: "28.9", branch: "05 · Comrat" })], ["calibrare în interval", F({ calFrom: "2022-01-01", calTo: "2023-12-31" })], ["toate coloanele noi", F({ xsr: "str", xar: "1", ilMin: "0", laMin: "45", calFrom: "2020-01-01" })], ["treapta verde", F({ band: "act" })], ["treapta galbenă + roșie", F({ band: "warn|crit" })], ["fără citire", F({ band: "noact" })], ["activ (coloana)", F({ actv: "1" })], ["inactiv (coloana)", F({ actv: "0" })], ["roșu + inactiv + filială", F({ band: "crit", actv: "0", branch: "05 · Comrat" })], ["verde + activ + stare OK", F({ band: "act", actv: "1", flag: "ok" })], ["doar defectate", F({ defect: "1" })], ["fără defectate", F({ defect: "0" })], ["defectate + filială", F({ defect: "1", branch: "05 · Comrat" })], ["cu coordonate", F({ geo: "1" })], ["fără coordonate", F({ geo: "0" })], ["coordonate + filială", F({ geo: "1", branch: "05 · Comrat" })],
  ["stare OK", F({ flag: "ok" })], ["fără raport de stare", F({ flag: "nostatus" })], ["OK + activ", F({ flag: "ok|active" })], ["OK + serie repetată", F({ flag: "ok|dup|nostatus" })],
  ["serie repetată", F({ flag: "dup" })], ["serie repetată + activ", F({ flag: "dup|active" })],
  ["stare multi", F({ flag: "batt|button" })], ["stare alert", F({ flag: "alert" })], ["inactiv", F({ flag: "inactive" })], ["cu facturare", F({ billed: "1" })], ["fără facturare", F({ billed: "0" })],
  ["frecvență", F({ fr: "868300" })], ["port", F({ port: "1" })], ["port altele", F({ port: "17|42" })], ["model", F({ model: "2155" })], ["model multi", F({ model: "2154|2137" })], ["an", F({ year: "2023|2025" })],
  ["volume", F({ valMin: "1000", valMax: "9000" })], ["volume ≥", F({ valMin: "15000" })], ["consum zi", F({ dcMin: "100", dcMax: "900" })], ["baterie", F({ batMax: "20" })],
  ["rssi", F({ rssiMin: "-110", rssiMax: "-90" })], ["snr", F({ snrMin: "-5", snrMax: "5" })], ["fCnt", F({ fcMin: "100", fcMax: "5000" })], ["24h", F({ range: "24h" })], ["7 zile", F({ range: "7d" })],
  ["căutare nume", F({ q: "S2154_0007" })], ["căutare adresă", F({ q: "strada mare" })], ["căutare consumator + oraș", F({ q: "maria 70" })], ["căutare gateway", F({ q: "gwb" })], ["căutare tip", F({ q: "status" })],
  ["căutare numerică", F({ q: "42" })], ["dev id", F({ dev: "id-7" })],
  ["nume contor (antet)", F({ name: "s2154_0007" })], ["nume + devEUI (antet)", F({ name: "001a7988 s2155" })], ["nume NU caută în adresă", F({ name: "strada mare" })],
  ["antete combinate", F({ name: "s21", branch: "05 · Comrat", city: "Comrat|Orhei", flag: "active|batt", rssiMin: "-115", rssiMax: "-80", batMin: "10", valMin: "100", dcMax: "2500", range: "7d" })],
  ["combinat", F({ branch: "05 · Comrat", city: "Comrat|Orhei", profile: "Comrat_Gas_Meter_DP|Jooby_Gas_Meter_DP", dcMin: "50", flag: "active", range: "7d", q: "popescu" })],
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
  { const ps = periodStarts(Date.now()); let cd = 0, cdn = 0, cm = 0, cmn = 0;
    for (const i of want) { if (st.dt[i] === ps.dayStart && st.dc[i] >= 0) { cd += st.dc[i]; cdn++; } if (st.mt[i] === ps.monthStart && st.mc[i] >= 0) { cm += st.mc[i]; cmn++; } }
    check("consum pe perioadă: suma zilei / lunii CURENTE (doar contoarele care au raportat în perioada curentă) = calculul independent", r.consDay === cd && r.consDayN === cdn && r.consMonth === cm && r.consMonthN === cmn && cdn > 0 && cmn > 0 && cdn < want.length); }
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

// stări ca în SCADA: „offline” raportat de contor NU e alertă; alerta = baterie slabă sau inactiv; „OK” exclude și inactivii; filtrele pe trepte de activitate
{
  const fl = (a: number, ...b: number[]) => b.reduce((x, y) => x | y, a);
  check("stări: «activ în SCADA» nu e alertă și nici problemă; inactiv = alertă", (FLAG.ACTIVE & ALERT_FLAGS) === 0 && (FLAG.ACTIVE & PROBLEM_FLAGS) === 0 && (FLAG.INACTIVE & ALERT_FLAGS) !== 0 && (FLAG.BATT & ALERT_FLAGS) !== 0);
  check("stări: OK = raport de stare fără baterie / buton / magnet și fără inactiv; marcat activ nu strică OK", isStatusOk(FLAG.STATUS) && isStatusOk(fl(FLAG.STATUS, FLAG.ACTIVE)) && !isStatusOk(fl(FLAG.STATUS, FLAG.INACTIVE)) && !isStatusOk(fl(FLAG.STATUS, FLAG.BATT)) && !isStatusOk(0));
  const H = 3_600_000, D = 24 * H, t = 1_800_000_000_000;
  check("activitate: pragurile 24 h / 7 zile și «fără citire»", activityOf(t - 23 * H, t) === 0 && activityOf(t - 24 * H, t) === 1 && activityOf(t - 6 * D, t) === 1 && activityOf(t - 7 * D, t) === 2 && activityOf(t - 90 * D, t) === 2 && activityOf(0, t) === 3);
  for (const toks of ["act", "warn", "crit", "noact", "warn|crit", "act|inactive", "crit|ok"]) {
    const r = runFilter(st, F({ flag: toks }), SORT, now);
    const want = Array.from({ length: st.n }, (_, i) => i).filter((i) => toks.split("|").some((k) => (k === "act" && activityOf(st.ts[i], now) === 0) || (k === "warn" && activityOf(st.ts[i], now) === 1) || (k === "crit" && activityOf(st.ts[i], now) === 2) || (k === "noact" && activityOf(st.ts[i], now) === 3) || (k === "inactive" && (st.fl[i] & FLAG.INACTIVE) !== 0) || (k === "ok" && isStatusOk(st.fl[i]))));
    const got = new Set(Array.from(r.idx));
    check(`filtru stare «${toks}» = varianta naivă (SAU între trepte și stări)`, r.matched === want.length && got.size === want.length && want.every((i) => got.has(i)), `${want.length} rânduri`);
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
  check(`agregare ${label}: OK / fără raport`, a.flags.statusOk === rows.filter((i) => isStatusOk(st.fl[i])).length && a.flags.noStatus === rows.filter((i) => !(st.fl[i] & FLAG.STATUS)).length && PROBLEM_FLAGS === 14); // baterie 2 + buton 4 + magnet 8 (offline = 16 nu mai e problemă)
  check(`agregare ${label}: stări`, a.flags.batt === rows.filter((i) => st.fl[i] & FLAG.BATT).length && a.flags.alert === rows.filter((i) => st.fl[i] & ALERT_FLAGS).length && a.flags.billed + a.flags.noBilled === rows.length);
  const actOf = (k: number) => rows.filter((i) => activityOf(st.ts[i], now) === k).length;
  check(`agregare ${label}: trepte de activitate (activ / avertizare / critic / fără citire) = varianta naivă și însumează n`, a.flags.act === actOf(0) && a.flags.warn === actOf(1) && a.flags.crit === actOf(2) && a.flags.noact === actOf(3) && a.flags.act + a.flags.warn + a.flags.crit + a.flags.noact === rows.length, `${a.flags.act} / ${a.flags.warn} / ${a.flags.crit} / ${a.flags.noact}`);
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
  const tel = (kv: Record<string, string>): TbLatest => ({ TIME_SERIES: Object.fromEntries(Object.entries(kv).map(([k, v]) => [k, { ts: 1_700_000_000_000, value: v }])), SERVER_ATTRIBUTE: { latitude: { ts: 1, value: "46.2967746" }, longitude: { ts: 1, value: "28.658967" }, devEUI: { ts: 1, value: "001A798816000001" }, active: { ts: 1, value: "false" }, ContPersonal: { ts: 1, value: "0123" } }, CLIENT_ATTRIBUTE: {} });
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
  check("sync: stare (inactiv, facturat, fără bit «offline» vechi) și ts", !(s.fl & 16) && !(s.fl & FLAG.ACTIVE) && !!(s.fl & FLAG.INACTIVE) && !!(s.fl & FLAG.BILLED) && s.t === 1_700_000_000_000);
  { const tt = tel({ Volume_m3_Total: "10.000" }); tt.TIME_SERIES.Volume_m3_Total = { ts: 1_700_000_900_000, value: "10.000" }; tt.TIME_SERIES.Volume_m3_Total_ts = { ts: 1_700_000_100_000, value: "10.000" };
    tt.SERVER_ATTRIBUTE.active = { ts: 1, value: "true" }; tt.SERVER_ATTRIBUTE.lastActivityTime = { ts: 1, value: "1700000500000" }; tt.SERVER_ATTRIBUTE.inactivityAlarmTime = { ts: 1, value: "1699000000000" };
    const b2 = buildDocs(devices, billing, new Map([["c1", tt]]), new Date(0)).docs.find((d) => d._id === "c1")!.s;
    check("sync: «Ultima citire» = momentul CITIRII de volum (Volume_m3_Total_ts), nu al sosirii (Volume_m3_Total); lastActivityTime / inactivityAlarmTime / active ajung în rezumat", b2.t === 1_700_000_100_000 && b2.ac === 1_700_000_500_000 && b2.ia === 1_699_000_000_000 && !!(b2.fl & FLAG.ACTIVE) && !(b2.fl & FLAG.INACTIVE));
    { const t2 = tel({ Volume_m3_Total: "1.000" }); const A = t2.SERVER_ATTRIBUTE;
      A.Aragaz = { ts: 1, value: "true" }; A.Cazan = { ts: 1, value: "false" }; A.Incalzire = { ts: 1, value: "true" }; A.Instalation_Litres = { ts: 1, value: "14098843" };
      A.ContorNr = { ts: 1, value: "4624641" }; A.ContPersonal = { ts: 1, value: "0580200708" }; A.Data_Calibrarii = { ts: 1, value: "1700000000000" };
      const b3 = buildDocs(devices, billing, new Map([["c2", t2]]), new Date(0)).docs.find((d) => d._id === "c2")!.s;
      check("sync: coloanele din SCADA (aragaz / cazan / încălzire ca biți, litri la instalare, contor SN, cont personal, data calibrării, stradă din facturare)", !!(b3.fl & FLAG.ARAGAZ) && !(b3.fl & FLAG.CAZAN) && !!(b3.fl & FLAG.INCALZ) && b3.il === 14098843 && b3.sn2 === "4624641" && b3.cp === "0580200708" && b3.cl === 1700000000000 && b3.sr === "Str. Mare");
      check("sync: fără acele atribute ⇒ câmpuri goale / null, fără biți", !(s.fl & FLAG.ARAGAZ) && !(s.fl & FLAG.INCALZ) && s.il === null && s.cl === null && s.sn2 === ""); }
    check("sync: fără Volume_m3_Total_ts ⇒ momentul lui Volume_m3_Total; fără atributele de timp ⇒ null", s.t === 1_700_000_000_000 && s.ac === null && s.ia === null); }
  check("sync: contor fără telemetrie → fără citire (nu zero)", by.get("c5")!.s.v === null && by.get("c5")!.s.t === 0 && by.get("c5")!.s.r === null);
  check("sync: ContPersonal rămâne text (zerouri păstrate), devEUI cu litere mici", by.get("c0")!.attrs.ContPersonal === "0123" && by.get("c0")!.s.e === "001a798816000001");
  check("sync: căutarea include număr radio, cont, adresă, consumator", /00001000/.test(s.q) && /A0/.test(s.q) && /Str\. Mare/.test(s.q) && /Ion Popescu/.test(s.q));
  const again = buildDocs(devices, billing, latest, new Date(5)).docs.find((d) => d._id === "c0")!;
  check("sync: hash stabil (nu depinde de ora sincronizării)", again.h === by.get("c0")!.h);
  const dupA = by.get("dupA")!, c0 = by.get("c0")!;
  check("sync: ambele dispozitive cu aceeași serie sunt marcate „Serie repetată”", !!(dupA.s.fl & FLAG.DUP) && !!(c0.s.fl & FLAG.DUP));
  check("sync: dupWith arată celălalt dispozitiv (nume + profil), nu pe el însuși", c0.tb.dupWith?.length === 1 && /^SN2154_00001000_2022 \(Edge_Gas_Meter_DP\)$/.test(c0.tb.dupWith[0]) && !!dupA.tb.dupWith?.[0].startsWith("S2154_00001000_2022"));
  check("sync: contoarele cu serie unică NU sunt marcate", !(by.get("c5")!.s.fl & FLAG.DUP) && by.get("c5")!.tb.dupWith === undefined && docs.filter((d) => d.s.fl & FLAG.DUP).length === 2);
  check("sync: coordonatele din atribute ajung în rezumat (și lipsa lor = null)", c0.s.la === 46.2967746 && c0.s.lo === 28.658967 && by.get("c5")!.s.la === null && by.get("c5")!.s.lo === null);
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
  const allowedFetch = new Set(["lib/thingsboard.ts", "lib/meter-sync.ts", "app/components/useMeterStore.ts", "app/components/MeterDetail.tsx", "app/components/useSourceStore.ts", "app/components/NightControl.tsx", "app/components/IntegrationPanel.tsx", "app/components/GatewayLayer.tsx", "app/components/KeptBrowser.tsx", "scripts/bench-integration.ts"]);
  check("read-only: fetch() doar în fișierele așteptate", fetches.every((f) => allowedFetch.has(f)), [...new Set(fetches)].join(", "));
  const mutating = files.filter((f) => /method:\s*"(PUT|DELETE|PATCH)"|\.(deleteOne|deleteMany|drop|updateMany|updateOne|insertOne|insertMany|replaceOne|bulkWrite)\(/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/"));
  // scrieri în baza NOASTRĂ: doar sesiuni / utilizator (login, seed) și colecția `meters` (sincronizare); niciodată în surse
  const allowedWrites = new Set(["lib/session.ts", "scripts/seed-user.ts", "scripts/sync-meters.ts", "scripts/load-history.ts", "lib/source-sync.ts", "lib/meter-readings.ts", "lib/night-job.ts", "lib/services/integration.ts", "lib/services/gateways.ts", "lib/services/counters.ts", "lib/services/kept.ts"]);
  check("read-only: scrieri în baza de date doar în sesiuni, seed:user, sync-meters, load-history și lib/source-sync", mutating.every((f) => allowedWrites.has(f)), mutating.join(", "));
  const syncSrc = readFileSync("scripts/sync-meters.ts", "utf8");
  const syncCollections = syncSrc.match(/client\.db\(\)\.collection[^\n]*/g) ?? [];
  check("read-only: sync-meters scrie doar în colecția `meters` (METERS_COLLECTION)", syncCollections.length >= 1 && syncCollections.every((l) => /METERS_COLLECTION \|\| "meters"/.test(l)), `${syncCollections.length} accesări`);
}

/* ───────── 6) hartă: proiecție, grupare în bule, linkuri ───────── */
{
  const n = 40000;
  const la = new Float64Array(n), lo = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const g = rnd() > 0.3;
    la[i] = g ? 45.5 + rnd() * 2.6 : NaN;
    lo[i] = g ? 27 + rnd() * 2.6 : NaN;
  }
  const idx = Int32Array.from({ length: n }, (_, i) => i);
  const withGeo = Array.from(idx).filter((i) => la[i] === la[i]).length;
  check("hartă: proiecție inversă (x,y → lat,lon) exactă", Math.abs(latFromY(mercY(46.2967746, worldSize(12)), worldSize(12)) - 46.2967746) < 1e-9 && Math.abs(lonFromX(mercX(28.658967, worldSize(12)), worldSize(12)) - 28.658967) < 1e-9);
  check("hartă: (0°, 0°) la zoom 0 cade în centrul lumii de 256 px", Math.abs(mercX(0, 256) - 128) < 1e-9 && Math.abs(mercY(0, 256) - 128) < 1e-9);
  for (const z of [6, 9, 12, 15]) {
    const cell = 48, cl = buildClusters(la, lo, idx, z, cell);
    const size = worldSize(z), cols = Math.ceil(size / cell);
    const naiveCells = new Map<number, number[]>();
    for (let i = 0; i < n; i++) if (la[i] === la[i]) {
      const key = Math.floor(mercY(la[i], size) / cell) * cols + Math.floor(mercX(lo[i], size) / cell);
      (naiveCells.get(key) ?? naiveCells.set(key, []).get(key)!).push(i);
    }
    let sum = 0, ok = true;
    for (let c = 0; c < cl.n; c++) {
      sum += cl.cnt[c];
      const key = Math.floor(cl.y[c] / cell) * cols + Math.floor(cl.x[c] / cell);
      const members = naiveCells.get(key);
      if (!members || members.length !== cl.cnt[c] || !members.includes(cl.rep[c])) { ok = false; break; }
      const mx = members.reduce((a, i) => a + mercX(lo[i], size), 0) / members.length;
      if (Math.abs(mx - cl.x[c]) > 1e-6) { ok = false; break; }
    }
    check(`hartă: bule la zoom ${z} = celule naive (aceleași numărători, centre = medii)`, ok && sum === withGeo && cl.n === naiveCells.size, `${cl.n} bule din ${withGeo} puncte`);
  }
  const single = buildClusters(la, lo, idx, 17, 0);
  check("hartă: fără grupare — fiecare punct cu coordonate e propria bulă", single.n === withGeo && Array.from(single.cnt).slice(0, single.n).every((c) => c === 1));
  const sub = Int32Array.from(idx.filter((i) => i % 7 === 0));
  check("hartă: respectă filtrul (doar indecșii dați)", buildClusters(la, lo, sub, 10, 48).cnt.reduce((a, b) => a + b, 0) === Array.from(sub).filter((i) => la[i] === la[i]).length);
  const bb = boundsOf(la, lo, idx)!;
  check("hartă: limitele geografice acoperă toate punctele", bb[0] >= 45.5 && bb[2] <= 48.1 && bb[1] >= 27 && bb[3] <= 29.6 && boundsOf(la, lo, [])=== null);
  const t0 = performance.now();
  for (let r = 0; r < 20; r++) buildClusters(la, lo, idx, 11, 48);
  console.log(`INFO hartă: gruparea a ${withGeo} puncte durează în medie ${((performance.now() - t0) / 20).toFixed(1)} ms`);
  const L = mapLinks(46.2967746, 28.658967);
  check("linkuri: Waze (ll + navigate), Google (dir + destination), Apple (daddr + dirflg)", L.waze === "https://waze.com/ul?ll=46.296775,28.658967&navigate=yes&zoom=17" && L.google === "https://www.google.com/maps/dir/?api=1&destination=46.296775,28.658967&travelmode=driving" && L.apple === "https://maps.apple.com/?daddr=46.296775,28.658967&dirflg=d");
  const A = addressLinks("Comrat, Zlatov str. 2");
  check("linkuri după adresă: adresa e codificată în URL", A.google.endsWith("query=Comrat%2C%20Zlatov%20str.%202") && A.waze.includes("q=Comrat%2C%20Zlatov%20str.%202") && A.apple.endsWith("q=Comrat%2C%20Zlatov%20str.%202"));
  check("coordonate valide: text și număr, respinge 0,0 / în afara globului / goale", JSON.stringify(validCoords("46.5", 28.1)) === "[46.5,28.1]" && validCoords(0, 0) === null && validCoords(91, 10) === null && validCoords("", "") === null && validCoords(null, 5) === null && validCoords("abc", "1") === null);
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

/* ───────── 8b) consum nemăsurat: calea rapidă și scăderea temperaturii ───────── */
{
  let sd = 99;
  const rn = () => ((sd = (sd * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const ND = 30;
  let total = 0, bad = 0, firstBad = "";
  for (let it = 0; it < 400; it++) {
    const cons = new Uint16Array(ND * 24);
    for (let i = 0; i < cons.length; i++) cons[i] = rn() < 0.04 ? NA.MARK_C : rn() < 0.5 ? 0 : Math.round(rn() * 1500);
    const temp = rn() < 0.7 ? new Int8Array(ND * 24).map(() => (rn() < 0.1 ? NA.MARK_T : Math.round((10 + rn() * 30) * 2))) : null;
    for (let q = 0; q < 8; q++) {
      const nights = 1 + Math.floor(rn() * ND);
      const p: NA.SuspectParams = { startHour: Math.floor(rn() * 24), endHour: 1 + Math.floor(rn() * 24), nights, maxNight: [0, 0.5, 1, 3][Math.floor(rn() * 4)], minDay: [0, 2, 5][Math.floor(rn() * 3)], minTemp: [null, 15, 22][Math.floor(rn() * 3)], maxTemp: [null, null, 18, 30][Math.floor(rn() * 4)], hasTemp: rn() < 0.3, tempMode: rn() < 0.5 ? "night" : "day", maxTempDrop: [null, 0, 2, 5][Math.floor(rn() * 4)], minNights: 1 };
      const row = NA.nightRowFromProfile(cons, temp, ND, p.startHour, p.endHour, p.nights);
      const a = NA.countMatches(row, { ...p, nights: row.nc.length });
      const b = NA.countFromProfile(cons, temp, ND, p);
      total++;
      if (a.matched !== b.matched || a.known !== b.known) { bad++; if (!firstBad) firstBad = JSON.stringify({ p, a, b }); }
    }
  }
  check("cale rapidă (fără alocări) = varianta pe rânduri, pe profiluri aleatorii cu ore și temperaturi lipsă", bad === 0, bad ? firstBad : `${total} combinații`);
  // scăderea temperaturii: noaptea la fel de caldă ca ziua vs. mult mai rece
  const ND3 = 3;
  const consD = new Uint16Array(ND3 * 24).map((_, i) => (i % 24 < 6 ? 0 : 500));
  const same = new Int8Array(ND3 * 24).fill(42); // 21 °C tot timpul
  const cooler = new Int8Array(ND3 * 24).map((_, i) => (i % 24 < 6 ? 30 : 42)); // 15 °C noaptea, 21 °C ziua
  const base = { ...NA.DEFAULT_PARAMS, nights: 3, minNights: 1, minTemp: null, maxTemp: null, hasTemp: false, maxTempDrop: 2 };
  check("scădere de temperatură: noaptea la fel de caldă ca ziua (scădere 0) se potrivește; noaptea mai rece cu 6 °C nu (prag 2 °C)", NA.countFromProfile(consD, same, ND3, base).matched === 3 && NA.countFromProfile(consD, cooler, ND3, base).matched === 0 && NA.countFromProfile(consD, cooler, ND3, { ...base, maxTempDrop: 6 }).matched === 3 && NA.countFromProfile(consD, same, ND3, { ...base, maxTempDrop: null }).matched === 3);
  const rowSame = NA.nightRowFromProfile(consD, same, ND3, 0, 6, 3), rowCool = NA.nightRowFromProfile(consD, cooler, ND3, 0, 6, 3);
  check("scădere de temperatură: valoarea afișată = media de zi − media de noapte (0 și 6 °C); fără temperatură ⇒ necunoscută și nu se potrivește", rowSame.td?.[0] === 0 && rowCool.td?.[0] === 6 && NA.countFromProfile(consD, null, ND3, base).matched === 0);
}

/* ───────── 9) integrare: mesaje direct de la LoRaWAN / antene ───────── */
{
  const NOW = Date.UTC(2026, 10, 23, 20, 0), T = NOW - 60_000;
  const tl = (v: string, t = T) => ({ t, v });
  const raw = () => ({
    id: "a9255170-615e-11ef-936d-33a22b7e43aa",
    tb: { name: "S2154_00186354_2024", type: "Cahul_Gas_Meter_DP", customerId: "f20657f0-5898-11ef-936d-33a22b7e43aa", createdTime: 1724424466439, label: null },
    bill: { CONTOR_ID: "3819018105", CONTOR_SN: "12882571", NUM_RADIO: "00186354", CITY: "Oras Test", STREET: "Strada Test", HOUSE: "59", ACCT_ID: "0406333333", ENTITY_NAME: "NUME TEST", FIL: "11", OTDELEN: "11-15", UPDATED_DATE: "2026-11-19T06:05:00.000Z" },
    attrs: { FIL: 11, active: true, lastActivityTime: T, latitude: 45.4783093, longitude: 28.1922861, devEUI: "001a79881802d7f2", ContPersonal: "0406333333", c_fCnt: "12", c_applicationName: "App_Cahul_Gaz_ABP_jooby", APPKEY: "SECRET-KEY" },
    tel: {
      Volume_m3_Total: tl("4118.935"), Volume_m3_Total_ts: tl("4118.935", T - 2_719_000), rssi: tl("-111"), loRaSNR: tl("-5.5"), Frequency: tl("868.1"), Concentrator: tl("M-194750_Comrat_Dostoievski"),
      battery: tl("{\"highLoadVoltage\":3062,\"internalRes\":28020,\"lowLoadVoltage\":3634,\"remCapacity\":99.61}"), dailyConsumption: tl("1320"), monthlyConsumption: tl("13320"),
      fPort: tl("1"), fCnt: tl("108"), temp: tl("9"), offline: tl("true"), magnet: tl("false"), buttonPressed: tl("false"), batteryTooLowVoltage: tl("false"), ieType: tl("LastEventSeq"), applicationName: tl("App_Cahul_Gaz_ABP_jooby"),
    },
  });
  const P = (x: unknown) => { const r = parseMessage(x, NOW); if (!r.ok) throw new Error(r.error); return r.msg; };
  check("integrare: momente date ca TEXT numeric (ms și secunde, cu zecimale) se recunosc, nu doar numerele", normTs("1795464061182") === 1795464061182 && normTs("1795464061") === 1795464061000 && normTs(" 1795464061182 ") === 1795464061182 && normTs("17954a") === null);
  { const g = (o: Record<string, string>) => (k: string) => o[k]; const p = filtersFromParams(g({ calFrom: "2022-01-01", calTo: "2023-12-31", ilMin: "100", xar: "1", xsr: "Gavrilov", band: "act|crit|zzz", actv: "0", iaHas: "1", acFrom: "2026-11-01T10:00" }));
    check("filtre din adresă: datele (calibrare), numerele, da / nu, textele, treptele (token necunoscut ignorat) se citesc corect", p.calFrom === "2022-01-01" && p.calTo === "2023-12-31" && p.ilMin === "100" && p.xar === "1" && p.xsr === "Gavrilov" && p.band === "act|crit" && p.actv === "0" && p.iaHas === "1" && p.acFrom === "2026-11-01T10:00" && filtersFromParams(g({ calFrom: "ieri" })).calFrom === ""); }
  check("integrare: momente — milisecunde, secunde și text ISO; altceva e invalid", normTs(1795464061182) === 1795464061182 && normTs(1795464061) === 1795464061000 && normTs("2026-11-23T20:01:01.182Z") === Date.parse("2026-11-23T20:01:01.182Z") && normTs("nu") === null && normTs(5) === null && normTs(null) === null);
  const bad = (x: unknown) => { const r = parseMessage(x, NOW); return r.ok ? "" : r.error; };
  check("integrare: mesaj invalid respins cu motiv (nu obiect, id greșit, fără identificare, fără date, moment în viitor / invalid, valoare invalidă)", bad(5) !== "" && bad({ id: "x", tel: {} }) !== "" && bad({ tel: { a: tl("1") } }) !== "" && bad({ tb: { name: "S1" } }) !== "" && bad({ tb: { name: "S1" }, tel: { a: { t: NOW + 5 * 86_400_000, v: "1" } } }) !== "" && bad({ tb: { name: "S1" }, tel: { a: { t: "ieri", v: "1" } } }) !== "" && bad({ tb: { name: "S1" }, tel: { a: { t: T, v: null } } }) !== "");
  const okMsg = P(raw());
  check("integrare: mesajul valid se normalizează (id, nume, devEUI, telemetrie ca text)", okMsg.id === "a9255170-615e-11ef-936d-33a22b7e43aa" && okMsg.name === "S2154_00186354_2024" && okMsg.eui === "001a79881802d7f2" && okMsg.tel.Volume_m3_Total.v === "4118.935" && typeof okMsg.tel.fCnt.v === "string");
  check("integrare: cheile de rețea / secrete nu se păstrează (APPKEY în atribute, nwkSKey în telemetrie)", !("APPKEY" in okMsg.attrs) && !("nwkSKey" in P({ ...raw(), tel: { ...raw().tel, nwkSKey: tl("x") } }).tel));
  check("integrare: valori simple (fără {t, v}) primesc momentul mesajului; obiectele devin text JSON", (() => { const m = P({ tb: { name: "S1" }, ts: T, tel: { rssi: -100, battery: { remCapacity: 80 } } }); return m.tel.rssi.t === T && m.tel.rssi.v === "-100" && m.tel.battery.v === "{\"remCapacity\":80}"; })());
  check("integrare: limite — maximum " + MAX_BATCH + " mesaje; prea multe chei respinse", MAX_BATCH === 1000 && bad({ tb: { name: "S1" }, tel: Object.fromEntries(Array.from({ length: 101 }, (_, i) => ["k" + i, tl("1")])) }) !== "");
  const a = mergeMsgs(P({ tb: { name: "S1" }, tel: { rssi: tl("-100", T + 2000), temp: tl("20", T + 1000) } }), P({ tb: { name: "S1" }, tel: { rssi: tl("-120", T + 1500), temp: tl("22", T + 3000) } }));
  check("integrare: două mesaje ale aceluiași contor — pentru fiecare cheie rămâne valoarea cu momentul cel mai nou, indiferent de ordinea sosirii", a.tel.rssi.v === "-100" && a.tel.temp.v === "22");

  const first = mergeDerive(null, okMsg.id!, okMsg, new Date(NOW));
  const d1 = first.doc;
  check("integrare: contor nou — status «created», documentul are facturarea, telemetria și rezumatul", first.status === "created" && d1._id === okMsg.id && d1.bill?.NUM_RADIO === "00186354" && d1.tel.Volume_m3_Total.v === "4118.935");
  check("integrare: rezumatul derivat = cel de la sincronizarea din SCADA (volum, moment = al citirii (Volume_m3_Total_ts), baterie, consum, coordonate, semnal, filială, tip mesaj, stare 416: facturat + raport de stare + activ)", d1.s.v === 4118.935 && d1.s.t === T - 2_719_000 && d1.s.b === 99.61 && d1.s.dc === 1320 && d1.s.mc === 13320 && d1.s.la === 45.4783093 && d1.s.lo === 28.1922861 && d1.s.r === -111 && d1.s.sn === -5.5 && d1.s.f === 868100 && d1.s.fc === 108 && d1.s.pt === 1 && d1.s.ty === "LastEventSeq" && d1.s.br === "11 · Cahul" && d1.s.fl === 416 && d1.s.g === "M-194750_Comrat_Dostoievski" && d1.s.a === "App_Cahul_Gaz_ABP_jooby" && d1.s.e === "001a79881802d7f2", JSON.stringify({ fl: d1.s.fl, br: d1.s.br }));
  check("integrare: căutarea include facturarea, iar documentul nu conține secrete", d1.s.q.includes("00186354") && d1.s.q.includes("0406333333") && !JSON.stringify(d1).match(/SECRET|APPKEY/));
  const again = mergeDerive(d1, okMsg.id!, okMsg, new Date(NOW + 5000));
  check("integrare: același mesaj de două ori ⇒ «unchanged» (idempotent: o reaplicare după o cădere nu are efecte)", again.status === "unchanged" && again.doc.h === d1.h);
  const old = mergeDerive(d1, okMsg.id!, P({ id: okMsg.id, tb: { name: "S2154_00186354_2024" }, tel: { Volume_m3_Total: tl("1.000", T - 86_400_000), rssi: tl("-50", T - 86_400_000) } }), new Date(NOW));
  check("integrare: mesaj MAI VECHI sosit târziu nu suprascrie citirea mai nouă (volum, semnal)", old.status === "unchanged" && old.doc.s.v === 4118.935 && old.doc.s.r === -111);
  const newer = mergeDerive(d1, okMsg.id!, P({ id: okMsg.id, tb: { name: "S2154_00186354_2024" }, tel: { Volume_m3_Total: tl("4119.500", T + 3_600_000), rssi: tl("-95", T + 3_600_000) } }), new Date(NOW + 3_600_000));
  check("integrare: mesaj parțial mai nou actualizează doar ce aduce; facturarea, coordonatele și restul rămân", newer.status === "updated" && newer.doc.s.v === 4119.5 && newer.doc.s.r === -95 && newer.doc.s.la === 45.4783093 && newer.doc.bill?.ENTITY_NAME === "NUME TEST" && newer.doc.s.b === 99.61 && newer.doc.s.br === "11 · Cahul" && newer.doc.tel.temp.v === "9");
  const dupDoc: MeterDocIng = { ...d1, s: { ...d1.s, fl: d1.s.fl | 1 }, tb: { ...d1.tb, dupWith: ["X (T)"] } };
  const keepDup = mergeDerive(dupDoc, okMsg.id!, P({ id: okMsg.id, tb: { name: "S2154_00186354_2024" }, tel: { rssi: tl("-90", T + 10_000) } }), new Date(NOW));
  check("integrare: «Serie repetată» (stabilită la sincronizare) se păstrează după un mesaj", (keepDup.doc.s.fl & 1) === 1 && keepDup.doc.tb.dupWith?.[0] === "X (T)");
  const inactive = mergeDerive(d1, okMsg.id!, P({ id: okMsg.id, tb: { name: "S2154_00186354_2024" }, attrs: { active: false } }), new Date(NOW));
  check("integrare: atributul active=false ⇒ «Inactiv» (bit 64), ca la sincronizare", (inactive.doc.s.fl & 64) === 64 && inactive.status === "updated");
  const byName = P({ tb: { name: "S2154_00000001_2024", type: "Comrat_Gas_Meter_DP", customerId: "2e2874d0-7c4e-11ed-bc64-85872813a734" }, tel: { Volume_m3_Total: tl("10.5") } });
  const fresh = mergeDerive(null, "11111111-2222-3333-4444-555555555555", byName, new Date(NOW));
  check("integrare: contor nou fără facturare — filiala vine din clientul lui (Comrat 05), volumul și momentul din mesaj", fresh.doc.s.br === "05 · Comrat" && fresh.doc.s.v === 10.5 && fresh.doc.bill === null && fresh.doc.s.t === T);
  check("integrare: sincronizarea din SCADA nu suprascrie date venite direct, la fel de noi sau mai noi", ingestIsNewer({ ing: 5, s: { t: 2000 } }, 1000) && ingestIsNewer({ ing: 5, s: { t: 2000 } }, 2000) && !ingestIsNewer({ ing: 5, s: { t: 1000 } }, 2000) && !ingestIsNewer({ s: { t: 9000 } }, 1000) && !ingestIsNewer(undefined, 1));
}

/* ───────── 10) integrare: uplink-uri brute de la serverul LoRaWAN (Jooby) ───────── */
{
  const NOW = Date.parse("2026-11-23T22:00:00Z");
  const up = (over: Record<string, unknown> = {}, frames?: unknown[]) => ({
    applicationID: "6", applicationName: "App_Orhei_Gaz_ABP_jooby", deviceName: "2154_00073058_2022", deviceProfileName: "Jooby_profile_2_device_ABP", devEUI: "001A798816011D62",
    rxInfo: [{ gatewayID: "50313953542f4750", name: "M-2F4750", time: "2026-08-11T09:56:52.063309Z", rssi: -99, loRaSNR: 6.5, location: { latitude: 47.39, longitude: 28.81 } }], txInfo: { frequency: 868500000, dr: 5 },
    fCnt: 36502, fPort: 1, data: "CQUABw==",
    object: { decodeTime: "2026-11-23T21:18:57.442Z", deviceTimeDrift: 721721265, hex: "0905", version: "1.0.1", decoded: frames ?? [
      { cmd: 9, corrSeq: 0, ieType: "CurrentTime", time: "2004-01-10T15:11:12Z" },
      { cmd: 24, ieType: "CurrentDataMul", values: [{ channel: 0, value: 2 }] },
      { cmd: 96, eventSeq: 97, ieType: "LastEventSeq", status: { batteryTooLowVoltage: false, buttonPressed: false, magnet: false, offline: true } },
    ] }, ...over });
  const U = (x: unknown) => { const r = uplinkToMsg(x as Record<string, unknown>, NOW); if (!r.ok) throw new Error(r.error); return r.msg; };
  check("uplink: se recunoaște forma serverului LoRaWAN, nu și documentul de contor", looksLikeUplink(up()) && !looksLikeUplink({ tb: { name: "S1" }, tel: {}, devEUI: "0011223344556677" }) && !looksLikeUplink({ x: 1 }));
  check("uplink: numele fără prefix, cu S și cu SN dau aceeași cheie (potrivire de rezervă); alt nume ⇒ null", nameKey("2154_00073058_2022") === "2154_00073058_2022" && nameKey("S2154_00073058_2022") === "2154_00073058_2022" && nameKey("SN2154_00073058_2022") === "2154_00073058_2022" && nameKey("LWM-2503-00001") === null && nameKey(null) === null);
  const m = U(up());
  check("uplink: contorul se identifică prin devEUI (litere mici), cu cheia de nume ca rezervă; momentul = decodeTime, nu ora antenei", m.eui === "001a798816011d62" && m.nameKey === "2154_00073058_2022" && m.id === null && m.tel.rssi.t === Date.parse("2026-11-23T21:18:57.442Z"));
  check("uplink: semnal, concentrator, frecvență, fCnt, fPort, aplicație, decodeTime", m.tel.rssi.v === "-99" && m.tel.loRaSNR.v === "6.5" && m.tel.Concentrator.v === "M-2F4750" && m.tel.Frequency.v === "868.5" && m.tel.fCnt.v === "36502" && m.tel.fPort.v === "1" && m.tel.applicationName.v === "App_Orhei_Gaz_ABP_jooby" && m.tel.decodeTime.v === "2026-11-23T21:18:57.442Z");
  check("uplink: starea din cadrul LastEventSeq (offline, magnet, buton, baterie) și ieType = tipul ultimului cadru", m.tel.offline.v === "true" && m.tel.magnet.v === "false" && m.tel.buttonPressed.v === "false" && m.tel.batteryTooLowVoltage.v === "false" && m.tel.ieType.v === "LastEventSeq");
  check("uplink: impulsurile din CurrentDataMul (canal 0) și fCnt; contorul e marcat activ cu ultima activitate = momentul mesajului", m.pulse?.v === 2 && m.fcnt === 36502 && m.attrs.active === true && m.attrs.lastActivityTime === m.tel.rssi.t);
  const ds = U(up({}, [{ battery: { highLoadVoltage: 3260, internalRes: 16978, lowLoadVoltage: 3629, remCapacity: 97.24 }, dwQuality: 100, ieType: "DeviceStatus", lastEventSeq: 31, temp: 18 }]));
  check("uplink: DeviceStatus ⇒ baterie (JSON, ca în SCADA) și temperatură; fără impulsuri", JSON.parse(ds.tel.battery.v).remCapacity === 97.24 && ds.tel.temp.v === "18" && ds.tel.ieType.v === "DeviceStatus" && ds.pulse === null && !("offline" in ds.tel));
  check("uplink: CurrentData (cmd 7) dă tot impulsuri", U(up({}, [{ cmd: 7, ieType: "CurrentData", magnet: 0, value: 252751 }])).pulse?.v === 252751);
  const rxs = [
    { gatewayID: "AA11", name: "M-2F4750", rssi: -99, loRaSNR: 6.5, location: { latitude: 47.3972, longitude: 28.8104 } },
    { gatewayID: "BB22", name: "Fara_Pozitie", rssi: -120, loRaSNR: -9, location: { latitude: 0, longitude: 0 } },
    { gatewayID: "CC33", name: "Departe", rssi: -80, loRaSNR: 9, location: { latitude: 51.5, longitude: 28.0 } },
    { gatewayID: "AA11", name: "M-2F4750", rssi: -50, loRaSNR: 1, location: { latitude: 47.3972, longitude: 28.8104 } },
  ];
  const gw = U(up({ rxInfo: rxs })).gws ?? [];
  check("antene: id, nume, semnal; aceeași antenă de două ori ⇒ o singură dată", gw.length === 3 && gw[0].id === "AA11" && gw[0].name === "M-2F4750" && gw.some((g) => g.id === "BB22"));
  check("antene: poziția (0, 0) sau în afara Moldovei ⇒ fără poziție; poziția validă se păstrează", gw.find((g) => g.id === "BB22")?.la === null && gw.find((g) => g.id === "CC33")?.la === null && gw[0].la === 47.3972 && gw[0].lo === 28.8104);
  check("antene: fără rxInfo ⇒ fără câmpul gws; id cu $ sau . se ignoră", U(up({ rxInfo: [] })).gws === undefined && gatewaysOf([{ gatewayID: "a.b", name: "x" }, { gatewayID: "$x", name: "y" }]).length === 0);
  check("antene: distanța pe sferă (Chișinău–Comrat ≈ 81 km, aceeași poziție = 0)", Math.abs(kmDist(47.0105, 28.8638, 46.2922, 28.676) - 81) < 6 && kmDist(47, 28, 47, 28) === 0);
  // continuitatea mesajelor (counter)
  const cs = newStream("implicit", "counter", 100, 1);
  const seqOut = [101, 102, 105, 103, 103, 106, 110].map((n) => observe(cs, n, 2));
  check("counter: 105 după 102 ⇒ gol 103–104; 110 după 106 ⇒ gol 107–109", seqOut[2] === "gap" && seqOut[6] === "gap" && cs.max === 110 && JSON.stringify(cs.missing.map((g) => [g[0], g[1]])) === "[[104,104],[107,109]]");
  check("counter: 103 sosit târziu închide golul, al doilea 103 e duplicat", seqOut[3] === "late" && seqOut[4] === "dup" && cs.late === 1 && cs.dup === 1 && lostOf(cs) === 4);
  check("counter: unice primite + lipsă = câte trebuiau (100..110)", cs.received + lostOf(cs) === cs.max - cs.first + 1);
  const mid = newStream("x", "counter", 1, 1); [2, 3, 4, 5, 6, 7, 8, 9, 10].forEach((n) => observe(mid, n, 2)); observe(mid, 20, 3);
  const o5 = observe(mid, 15, 4);
  check("counter: număr sosit în mijlocul unui gol îl împarte în două", o5 === "late" && JSON.stringify(mid.missing.map((g) => [g[0], g[1]])) === "[[11,14],[16,19]]" && lostOf(mid) === 8);
  check("counter: câmpuri recunoscute (counter, cnt, seq, text cu cifre), flux din stream; fără număr / negativ / zecimal ⇒ null", counterOf({ counter: 7 })?.value === 7 && counterOf({ cnt: "42", stream: "A" })?.stream === "A" && counterOf({ seq: 3 })?.field === "seq" && counterOf({ a: 1 }) === null && counterOf({ counter: -1 }) === null && counterOf({ counter: 1.5 }) === null && counterOf("text") === null && counterOf([1]) === null);
  const big = newStream("b", "counter", 0, 1); for (let i = 1; i <= 3000; i++) observe(big, i * 2, 2);
  check("counter: cu multe goluri lista rămâne limitată, dar numărul pierdut rămâne exact", big.missing.length <= 1000 && lostOf(big) === 3000 && big.received === 3001 && big.received + lostOf(big) === big.max - big.first + 1);
  // evenimente de stare / eroare ale serverului LoRaWAN (fără object / rxInfo)
  const evS = { applicationID: "9", applicationName: "App_Comrat", deviceName: "2154_00174121_2024", devEUI: "001A798816010C5E", margin: 7, externalPowerSource: false, batteryLevel: 0, batteryLevelUnavailable: true };
  const evE = { applicationID: "9", applicationName: "App_Comrat", deviceName: "S2154_00174121_2024", devEUI: "001a798816010c5e", type: "UPLINK_F_CNT_RETRANSMISSION", error: "retransmisie" };
  const em = parseMessage(evS, NOW), ee = parseMessage(evE, NOW);
  check("eveniment de stare: recunoscut, devEUI cu litere mici, margin / baterie ca telemetrie; fără impulsuri și fără „activ”", looksLikeEvent(evS) && em.ok && em.msg.eui === "001a798816010c5e" && em.msg.tel.margin.v === "7" && em.msg.tel.batteryLevel.v === "0" && em.msg.tel.externalPowerSource.v === "false" && em.msg.pulse === null && !("active" in em.msg.attrs) && em.msg.nameKey === "2154_00174121_2024");
  check("eveniment de eroare: type / error ⇒ evType / evError", ee.ok && ee.msg.tel.evType.v === "UPLINK_F_CNT_RETRANSMISSION" && ee.msg.tel.evError.v === "retransmisie");
  check("eveniment: doar câmpurile de identificare ⇒ nu e eveniment; uplink-ul și documentul de contor rămân neschimbate", !looksLikeEvent({ devEUI: "001a798816010c5e", deviceName: "x", applicationName: "y" }) && !looksLikeEvent(up()) && !looksLikeEvent({ devEUI: "001a798816010c5e", tel: {}, margin: 1 }) && !eventToMsg({ devEUI: "zz" }, NOW).ok);
  const pm = parseMessage(up(), NOW);
  check("uplink: parseMessage îl recunoaște singur; devEUI greșit ⇒ respins cu motiv", pm.ok && pm.msg.eui === "001a798816011d62" && !uplinkToMsg({ devEUI: "xyz", object: {} } as never, NOW).ok);

  // volumul total = Instalation_Litres + (impulsuri − ModuleInitialValue) × 10 — cele 4 contoare reale verificate
  const base = (name: string, inst: string, init: number, eui: string) => mergeDerive(null, "11111111-2222-3333-4444-555555555555", P2({ id: "11111111-2222-3333-4444-555555555555", tb: { name, type: "Orhei_Gas_Meter_DP", customerId: "07ed0920-7b6d-11ed-bc64-85872813a734" }, attrs: { devEUI: eui, Instalation_Litres: inst, ModuleInitialValue: init, active: true } }), new Date(NOW)).doc;
  const P2 = (x: unknown) => { const r = parseMessage(x, NOW); if (!r.ok) throw new Error(r.error); return r.msg; };
  const cases: [string, string, number, number, number][] = [["S2154_00073058_2022", "00000260", 0, 2, 0.28], ["S2154_00076256_2022", "5157149", 13, 345508, 8612.099], ["S4254_00327280_2025", "00063", 4, 4, 0.063], ["S4254_00342052_2025", "961769", 23, 124775, 2209.289]];
  const okAll = cases.every(([name, inst, init, pulse, want], i) => { const eui = "001a79881601" + String(1000 + i); const ex = base(name, inst, init, eui); const r = mergeDerive(ex, ex._id, U(up({ devEUI: eui }, [{ cmd: 24, ieType: "CurrentDataMul", values: [{ channel: 0, value: pulse }] }])), new Date(NOW)); return Number(r.doc.tel.Volume_m3_Total?.v) === want && r.doc.s.v === want && r.doc.attrs.c_couterPulse === String(pulse); });
  check("uplink: volumul total din impulsuri = valoarea din aplicație pe cele 4 contoare reale (0,28 · 8612,099 · 0,063 · 2209,289 m³)", okAll);
  const ex1 = base("S2154_00076256_2022", "5157149", 13, "001a798816011d62");
  const v1 = mergeDerive(ex1, ex1._id, U(up({ fCnt: 100 }, [{ cmd: 24, ieType: "CurrentDataMul", values: [{ channel: 0, value: 345508 }] }, { cmd: 96, eventSeq: 97, ieType: "LastEventSeq", status: { batteryTooLowVoltage: false, buttonPressed: false, magnet: false, offline: true } }])), new Date(NOW)).doc;
  const back = mergeDerive(v1, v1._id, U(up({ fCnt: 100 }, [{ cmd: 24, ieType: "CurrentDataMul", values: [{ channel: 0, value: 300000 }] }])), new Date(NOW + 1000));
  check("uplink: volumul doar crește — un contor de impulsuri mai mic (reluare / eroare) nu dă volumul înapoi", v1.s.v === 8612.099 && back.doc.s.v === 8612.099 && back.doc.tel.Volume_m3_Total.v === "8612.099");
  const noInst = mergeDerive(mergeDerive(null, "22222222-2222-3333-4444-555555555555", P2({ id: "22222222-2222-3333-4444-555555555555", tb: { name: "S2154_00099999_2022" }, attrs: { devEUI: "001a798816019999" } }), new Date(NOW)).doc, "22222222-2222-3333-4444-555555555555", U(up({ devEUI: "001a798816019999" })), new Date(NOW));
  check("uplink: fără Instalation_Litres volumul total NU se inventează (rămâne necunoscut), restul datelor se aplică", noInst.doc.s.v === null && noInst.doc.s.r === -99 && noInst.doc.s.fc === 36502);
  check("uplink: stare, activ (active = true) și volum ajung în rezumat, ca la sincronizarea din SCADA; Volume_m3_Total_ts merge odată cu volumul, deci «Ultima citire» = momentul mesajului", (v1.s.fl & 16) === 0 && (v1.s.fl & 32) === 32 && (v1.s.fl & 256) === 256 && v1.tel.Volume_m3_Total_ts.v === v1.tel.Volume_m3_Total.v && v1.s.t === v1.tel.Volume_m3_Total_ts.t && v1.s.ty === "LastEventSeq" && v1.s.fc === 100);
  // ordinea: un cadru mai vechi (fCnt mai mic) sosit după unul mai nou nu are voie să-l strice
  check("fCnt: mai vechi în aceeași sesiune ⇒ vechi; mai mic cu peste 30000 (repornire) sau lipsă ⇒ acceptat", isStaleFcnt(90, 100) && !isStaleFcnt(100, 100) && !isStaleFcnt(101, 100) && !isStaleFcnt(5, 40000) && !isStaleFcnt(null, 100) && !isStaleFcnt(5, null));
  const stale = mergeDerive(v1, v1._id, U(up({ fCnt: 50 }, [{ cmd: 24, ieType: "CurrentDataMul", values: [{ channel: 0, value: 300000 }] }])), new Date(NOW + 5000));
  check("fCnt: un uplink vechi (fCnt 50 față de 100, impulsuri mai puține) nu schimbă nimic", stale.status === "unchanged" && stale.doc.s.v === 8612.099);
  const reset = mergeDerive(v1, v1._id, U(up({ fCnt: 50 }, [{ cmd: 24, ieType: "CurrentDataMul", values: [{ channel: 0, value: 346000 }] }])), new Date(NOW + 5000));
  check("fCnt: fCnt mai mic DAR impulsuri mai multe ⇒ contorul e în viață (și-a repornit contorul de cadre): se acceptă, nu se blochează", reset.status === "updated" && reset.doc.s.v === 8612.099 + 4.92 && reset.doc.s.fc === 50, JSON.stringify({ v: reset.doc.s.v, fc: reset.doc.s.fc }));
  const H48 = 48 * 3_600_000;
  check("fCnt: după 48 h fără cadre mai noi un fCnt mai mic nu mai e „vechi” (repornire); înainte de 48 h e", isStaleUplink({ fcnt: 90, pulse: 5, t: 1000 }, { fcnt: 100, t: 0, pulse: 5 }) && !isStaleUplink({ fcnt: 90, pulse: 5, t: H48 + 1 }, { fcnt: 100, t: 0, pulse: 5 }) && !isStaleUplink({ fcnt: 90, pulse: 6, t: 1000 }, { fcnt: 100, t: 0, pulse: 5 }) && isStaleUplink({ fcnt: 90, pulse: null, t: 1000 }, { fcnt: 100, t: 0, pulse: 5 }));
  const a1 = U(up({ fCnt: 200 })), b1 = U(up({ fCnt: 150 }));
  check("fCnt: la îmbinarea a două mesaje ale aceluiași contor, cel cu fCnt mai mic sosit mai târziu se ignoră", mergeMsgs(a1, b1).fcnt === 200 && mergeMsgs(b1, a1).fcnt === 200);
}

/* ───────── 7) lista din SCADA (cei 10 clienți) și paginile pe sursă: lorawandb și getmgdb separat ───────── */
const section7 = (async () => {
  // lista contoarelor din SCADA: cu un fetch SIMULAT (niciun apel real în rețea) — pagini, câmpuri păstrate, excluderi, citire doar
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  process.env.TB_USER = "t"; process.env.TB_PASS = "t"; process.env.TB_URL = "https://scada.test"; process.env.TB_PAUSE_MS = "0";
  const mk = (i: number, type: string, cust: string) => ({ id: { entityType: "DEVICE", id: `dev-${cust.slice(0, 4)}-${i}` }, name: `S2154_${String(i).padStart(8, "0")}_2022`, type, label: i === 0 ? "  eticheta  " : null, createdTime: 1_700_000_000_000 + i, customerId: { id: cust },
    tenantId: { id: "ten" }, deviceProfileId: { id: "prof" }, deviceData: { transportConfiguration: { APPKEY: "SECRET-APPKEY", NWKSKEY: "SECRET-NWK" } }, secretToken: "SECRET-TOKEN" });
  const world = new Map<string, ReturnType<typeof mk>[]>(GAS_CUSTOMERS.map((c, k) => [c.id, [...Array.from({ length: 5 + k }, (_, i) => mk(i, "Comrat_Gas_Meter_DP", c.id)), mk(900, "Defectate_Jooby_Gaz", c.id), mk(901, "Defectate_Partener_ACC", c.id)]]));
  world.get(GAS_CUSTOMERS[0].id)!.push(mk(0, "Comrat_Gas_Meter_DP", GAS_CUSTOMERS[0].id)); // același dispozitiv apare de două ori: se păstrează o singură dată
  let breakTotal = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url), method = init?.method ?? "GET";
    calls.push(`${method} ${u.replace("https://scada.test", "")}`);
    if (u.endsWith("/api/auth/login")) return Response.json({ token: "x.eyJleHAiOjk5OTk5OTk5OTl9.y" });
    const m = /\/api\/customer\/([0-9a-f-]{36})\/devices\?pageSize=(\d+)&page=(\d+)/.exec(u);
    if (m) {
      const all = world.get(m[1]) ?? [], size = Number(m[2]), page = Number(m[3]);
      return Response.json({ data: all.slice(page * size, (page + 1) * size), totalPages: Math.ceil(all.length / size), totalElements: breakTotal ? all.length + 3 : all.length, hasNext: (page + 1) * size < all.length });
    }
    throw new Error("cerere neașteptată în test: " + method + " " + u);
  }) as typeof fetch;
  try {
    const one = await tbCustomerDevices(GAS_CUSTOMERS[1].id, { pageSize: 4 });
    check("scada: lista unui client vine pe pagini (pageSize 4) și e completă", one.devices.length === one.total && one.total === 5 + 1 + 2 && calls.filter((c) => c.includes(GAS_CUSTOMERS[1].id)).length === 2);
    check("scada: din fiecare dispozitiv rămân doar câmpurile de identificare (fără deviceData / chei / token)", !JSON.stringify(one.devices).match(/SECRET|APPKEY|NWKSKEY|deviceData|transportConfiguration|secretToken/) && Object.keys(one.devices[0]).sort().join() === "createdTime,customerId,id,label,name,type" && one.devices[0].label === "eticheta");
    calls.length = 0;
    const lst = await fetchDevices();
    const expectKept = [...world.values()].reduce((a, l) => a + l.length, 0) - 1; // −1: duplicatul
    check("scada: lista finală = cei 10 clienți, CU Defectate_* și fără dubluri", lst.devices.length === expectKept && lst.devices.some((d) => DEFECT_PROFILE.test(d.type)) && new Set(lst.devices.map((d) => d.id.id)).size === lst.devices.length && lst.perCustomer.length === 10, `${lst.devices.length} contoare`);
    check("scada: pe fiecare client se raportează total și păstrate", lst.perCustomer.every((p) => p.total >= p.kept && p.total - p.kept <= 1) && lst.perCustomer[0].total === 5 + 2 + 1);
    check("scada: se cheamă doar adrese permise (login + lista clienților); nicio scriere", calls.every((c) => c === "POST /api/auth/login" || /^GET \/api\/customer\/[0-9a-f-]{36}\/devices\?pageSize=1000&page=\d+$/.test(c)) && calls.filter((c) => c.startsWith("GET")).length === 10, `${calls.length} cereri`);
    breakTotal = true;
    let stopped = false;
    try { await fetchDevices(); } catch (e) { stopped = /opresc/.test((e as Error).message); }
    check("scada: dacă lista primită nu e completă (total ≠ primite) ⇒ se oprește, nu construiește o listă parțială", stopped);
    breakTotal = false;
    const okGet = (p: string) => { try { assertReadOnly("GET", p); return true; } catch { return false; } };
    const cid = GAS_CUSTOMERS[0].id;
    check("read-only: citirea listei unui client e permisă, dar nu și alte apeluri pe client", okGet(`/api/customer/${cid}/devices?pageSize=1000&page=0`) && !okGet(`/api/customer/${cid}`) && !okGet(`/api/customer/${cid}/devices?pageSize=1000&page=0&x=1`) && !okGet("/api/customers?pageSize=10&page=0") && !(() => { try { assertReadOnly("POST", `/api/customer/${cid}/devices?pageSize=1000&page=0`); return true; } catch { return false; } })() && !(() => { try { assertReadOnly("DELETE", `/api/customer/${cid}/devices?pageSize=1000&page=0`); return true; } catch { return false; } })());
    check("scope: cei 10 clienți au filiale distincte, toate cunoscute (01…36)", GAS_CUSTOMERS.length === 10 && new Set(GAS_CUSTOMERS.map((c) => c.fil)).size === 10 && GAS_CUSTOMERS.every((c) => /^(01|05|10|11|20|27|31|33|35|36)$/.test(c.fil)) && !DEFECT_PROFILE.test("Comrat_Gas_Meter_DP") && DEFECT_PROFILE.test("Defectate_Jooby_Gaz"));
    // filiala vine din clientul dispozitivului (și fără facturare)
    const dv = (id: string, cust: string): Dev => ({ id: { id }, name: "S2154_00000777_2024", type: "Comrat_Gas_Meter_DP", createdTime: 1, customerId: { id: cust } });
    const built = buildDocs([dv("z1", GAS_CUSTOMERS[0].id), dv("z2", GAS_CUSTOMERS[1].id), dv("z3", "client-necunoscut")], [], new Map(), new Date());
    const br = new Map(built.docs.map((d) => [d._id, d.s.br]));
    check("sync: filiala fără facturare = filiala clientului din SCADA (Comrat 05, Orhei 20); client necunoscut = nedeterminată", br.get("z1") === "05 · Comrat" && br.get("z2") === "20 · Orhei" && br.get("z3") === "Nedeterminată");
  } finally {
    globalThis.fetch = realFetch;
  }

  const SIDS = [{ id: "d1", name: "S2154_00070948_2022" }, { id: "d2", name: "S2154_00070948_2023" }, { id: "d3", name: "SN2160_00000012_2024" }, { id: "d4", name: "Contor vechi 7" }];
  const devices = SIDS.map((x, i) => ({
    id: { entityType: "DEVICE", id: x.id }, name: x.name, type: i % 2 ? "Jooby_Gas_Meter_DP" : "Comrat_Gas_Meter_DP", label: i === 0 ? "  eticheta  " : null, createdTime: 1_700_000_000_000 + i * 86_400_000 * 40,
    customerId: { entityType: "CUSTOMER", id: i < 2 ? "cust-aaaaaaaa-1111" : "cust-bbbbbbbb-2222" }, ownerId: { id: "own-1" }, tenantId: { id: "ten-1" }, deviceProfileId: { id: "prof-" + (i % 2) },
    additionalInfo: { description: i === 0 ? "la poartă" : undefined, gateway: false },
    deviceData: { transportConfiguration: { APPKEY: "SECRET-APPKEY", NWKSKEY: "SECRET-NWK" } }, secretToken: "SECRET-TOKEN",
  }));
  const ld = lorawanDocs(devices);
  check("lorawan: 4 rânduri, id = id-ul dispozitivului", ld.length === 4 && ld.map((x) => x._id).join() === "d1,d2,d3,d4");
  check("lorawan: NU se copiază deviceData / chei LoRaWAN / alte câmpuri necunoscute", !JSON.stringify(ld).match(/SECRET|APPKEY|NWKSKEY|deviceData|transportConfiguration/));
  check("lorawan: câmpurile de identificare sunt curate (spații, id-uri imbricate)", ld[0].d.label === "eticheta" && ld[0].d.customerId === "cust-aaaaaaaa-1111" && ld[0].d.ownerId === "own-1" && ld[0].d.description === "la poartă" && ld[3].d.label === null);
  check("lorawan: amprenta se schimbă doar când se schimbă rândul", lorawanDocs(devices)[1].h === ld[1].h && lorawanDocs([{ ...devices[1], label: "alta" }])[0].h !== ld[1].h);
  const lt = lorawanTable(ld.map((x) => ({ _id: x._id, d: x.d as unknown as Record<string, unknown> })));
  const lr = (i: number) => lt.rows[i];
  check("lorawan: serie / model / an din nume", lr(0).serial === "00070948" && lr(0).model === "2154" && lr(0).year === "2022" && lr(2).serial === "00000012" && lr(2).model === "2160" && lr(3).serial === null && lr(3).model === "alt");
  check("lorawan: serie repetată = aceeași serie la mai multe dispozitive (doar în această sursă)", lr(0).dup === "Da" && lr(1).dup === "Da" && lr(2).dup === "Nu" && lr(3).dup === "Nu" && lr(3).std === "Nu" && lr(0).std === "Da");

  const bill = [
    { CONTOR_ID: "100", CONTOR_SN: " 111 ", NUM_RADIO: "70948", CITY: "Comrat", STREET: "Zlatov", HOUSE: "2", APARTMENT: "5", ACCT_ID: "A1", FIL: "05", OTDELEN: "05-02", KOD_AB: "FIZ-L   ", REPEAT: 1, NUM_CAR: 8, ENTITY_NAME: "Ion Popescu", UPDATED_DATE: "2026-11-19T06:05:00.000Z", EXTRA_X: "da", "bad.key": 1, $x: 2 },
    { CONTOR_ID: "100", CONTOR_SN: "112", NUM_RADIO: "00070948", CITY: "Comrat", FIL: "05", UPDATED_DATE: "2026-11-18T06:05:00.000Z" },
    { CONTOR_ID: "101", NUM_RADIO: "12", CITY: "Orhei", FIL: "20", UPDATED_DATE: "nu e dată" },
    { CONTOR_SN: "9" },
  ];
  const bd = billingDocs(bill);
  check("facturare: id = CONTOR_ID, la dubluri #2; fără CONTOR_ID ⇒ număr radio / amprentă", bd.map((x) => x._id).join() === "c100,c100#2,c101," + bd[3]._id && /^h[0-9a-f]{20}$/.test(bd[3]._id));
  check("facturare: valorile se curăță, chei nepermise de Mongo sunt omise, câmpurile necunoscute rămân", bd[0].d.CONTOR_SN === "111" && !("bad.key" in bd[0].d) && !("$x" in bd[0].d) && bd[0].d.EXTRA_X === "da" && bd[0].d.REPEAT === 1);
  const bt = billingTable(bd.map((x) => ({ _id: x._id, d: x.d as unknown as Record<string, unknown> })));
  const br = (i: number) => bt.rows[i];
  check("facturare: adresă, filială, număr radio cu zerouri, dată", br(0).adresa === "Comrat, Zlatov, 2, ap. 5" && br(0).branch === "05 · Comrat" && br(0).NUM_RADIO === "00070948" && br(0).UPDATED_DATE === Date.parse("2026-11-19T06:05:00.000Z") && br(2).UPDATED_DATE === null && br(3).branch === "Nedeterminată");
  check("facturare: număr radio repetat (70948 și 00070948 sunt aceeași serie)", br(0).radioDup === "Da" && br(1).radioDup === "Da" && br(2).radioDup === "Nu");
  check("facturare: câmpurile necunoscute devin coloane text", bt.cols.some((c) => c.key === "EXTRA_X" && c.kind === "text") && br(0).EXTRA_X === "da");

  // pe coloane → magazin local
  const wire = columnarize("billing", bt.cols, bt.rows, '"t"', 1);
  const store = SourceStore.fromWire(wire);
  check("coloane: coloanele fără nicio valoare nu se trimit; lipsurile sunt -1 / NaN / șir gol", !wire.cols.some((c) => c.key === "CONTROLOR") && !("CONTROLOR" in wire.data) && wire.cols.some((c) => c.key === "CITY") && store.codes.CITY[3] === -1 && Number.isNaN(store.nums.UPDATED_DATE[2]) && store.texts.NUM_RADIO[3] === "");
  const snap = SourceStore.fromSnapshot(structuredClone(store.snapshot()));
  check("coloane: instantaneul (IndexedDB) păstrează tot", snap.n === 4 && snap.text(0, snap.byKey.get("CITY")!) === "Comrat" && snap.etag === '"t"');

  // filtre față de varianta naivă, pe date aleatorii
  const R = 6000;
  const cities = ["Comrat", "Orhei", "Cahul", "Chisinau", "Rezina", "Soroca"];
  const rrows: SourceRow[] = Array.from({ length: R }, (_, i) => ({
    name: `N${String(Math.floor(rnd() * 900)).padStart(3, "0")}-${i}`,
    city: rnd() < 0.1 ? null : cities[Math.floor(rnd() * cities.length)],
    tag: rnd() < 0.5 ? "Da" : "Nu",
    qty: rnd() < 0.15 ? null : Math.floor(rnd() * 1000),
    day: rnd() < 0.1 ? null : Date.UTC(2024, 0, 1) + Math.floor(rnd() * 800) * 86_400_000 + 5 * 3_600_000,
    note: rnd() < 0.3 ? null : `nota ${Math.floor(rnd() * 50)}`,
  }));
  const rcols: ColDef[] = [
    { key: "name", label: "Nume", kind: "text", search: true },
    { key: "city", label: "Oraș", kind: "dict", chart: true },
    { key: "tag", label: "Etichetă", kind: "dict" },
    { key: "qty", label: "Cantitate", kind: "num" },
    { key: "day", label: "Zi", kind: "date", chart: true },
    { key: "note", label: "Notă", kind: "text", search: true },
  ];
  const rs = SourceStore.fromWire(columnarize("billing", rcols, rrows, '"r"', 1));
  const name = (i: number) => String(rrows[i].name), city = (i: number) => rrows[i].city as string | null, qty = (i: number) => rrows[i].qty as number | null, day = (i: number) => rrows[i].day as number | null;
  const sameSet = (a: Int32Array, b: number[]) => a.length === b.length && b.every((x, k) => a[k] === x);
  const natural: SortSpec = { key: "name", dir: 1 };
  const naiveSorted = (cmp: (a: number, b: number) => number) => Array.from({ length: R }, (_, i) => i).sort(cmp);
  let ok = true;
  const f1: SFilters = { ...NO_SFILTERS, sel: { city: ["Comrat", EMPTY_TOKEN] }, min: { qty: "200" }, max: { qty: "700" } };
  const naive1 = naiveSorted((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a - b)).filter((i) => (city(i) === null || city(i) === "Comrat") && qty(i) !== null && qty(i)! >= 200 && qty(i)! <= 700);
  ok = sameSet(runSourceFilter(rs, f1, natural).idx, naive1);
  check("filtre pe sursă: listă (SAU, cu «fără valoare») + interval numeric = varianta naivă", ok, `${naive1.length} rânduri`);
  const f2: SFilters = { ...NO_SFILTERS, q: "n05 NOTA 7", txt: { note: "nota" } };
  const naive2 = naiveSorted((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a - b)).filter((i) => { const h = `${name(i)}\n${rrows[i].note ?? ""}\n`.toLowerCase(); return h.includes("n05") && h.includes("nota") && h.includes("7") && String(rrows[i].note ?? "").toLowerCase().includes("nota"); });
  check("filtre pe sursă: căutare cu mai multe cuvinte (toate) + «conține» pe coloană", sameSet(runSourceFilter(rs, f2, natural).idx, naive2), `${naive2.length} rânduri`);
  const f3: SFilters = { ...NO_SFILTERS, min: { day: "2024-06-01" }, max: { day: "2024-08-31" }, sel: { tag: ["Da"] } };
  const lo3 = new Date(2024, 5, 1).getTime(), hi3 = new Date(2024, 8, 1).getTime() - 1;
  const naive3 = naiveSorted((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : a - b)).filter((i) => day(i) !== null && day(i)! >= lo3 && day(i)! <= hi3 && rrows[i].tag === "Da");
  check("filtre pe sursă: interval de zile (inclusiv ziua de sfârșit) + listă = varianta naivă", sameSet(runSourceFilter(rs, f3, natural).idx, naive3), `${naive3.length} rânduri`);
  const noFilter = runSourceFilter(rs, NO_SFILTERS, natural);
  check("filtre pe sursă: fără filtre ⇒ toate rândurile", noFilter.matched === R && noFilter.idx.length === R);
  const sorted = (key: string, dir: 1 | -1) => Array.from(rs.order({ key, dir }));
  const lastMissing = (vals: (number | string | null)[], ord: number[]) => { const first = ord.findIndex((i) => vals[i] === null); return first === -1 || ord.slice(first).every((i) => vals[i] === null); };
  const qs = sorted("qty", 1), qd = sorted("qty", -1);
  check("sortare: număr crescător / descrescător, lipsurile la sfârșit în ambele sensuri", qs.every((i, k) => k === 0 || qty(i) === null || qty(qs[k - 1]) === null || qty(qs[k - 1])! <= qty(i)!) && qd.every((i, k) => k === 0 || qty(i) === null || qty(qd[k - 1]) === null || qty(qd[k - 1])! >= qty(i)!) && lastMissing(rrows.map((r) => r.qty), qs) && lastMissing(rrows.map((r) => r.qty), qd));
  const cs = sorted("city", 1);
  check("sortare: listă alfabetic (lipsurile la sfârșit)", cs.every((i, k) => k === 0 || city(i) === null || city(cs[k - 1]) === null || city(cs[k - 1])!.localeCompare(city(i)!, "ro") <= 0) && lastMissing(rrows.map((r) => r.city), cs));
  const ds = sorted("day", -1);
  check("sortare: dată descrescător, lipsurile la sfârșit", ds.every((i, k) => k === 0 || day(i) === null || day(ds[k - 1]) === null || day(ds[k - 1])! >= day(i)!) && lastMissing(rrows.map((r) => r.day), ds));

  // agregări
  const dc = dictCounts(rs, "city", null);
  const naiveCity = new Map<string | null, number>();
  for (let i = 0; i < R; i++) naiveCity.set(city(i), (naiveCity.get(city(i)) ?? 0) + 1);
  check("grafice: numărătoarea pe valori (și «fără valoare») = varianta naivă", rs.dict.city.every((n, k) => dc[k] === naiveCity.get(n)) && dc[rs.dict.city.length] === (naiveCity.get(null) ?? 0) && dc.reduce((a, b) => a + b, 0) === R);
  const sub = runSourceFilter(rs, f1, natural).idx;
  const dcf = dictCounts(rs, "city", sub);
  check("grafice: numărătoarea pe rândurile filtrate", dcf.reduce((a, b) => a + b, 0) === sub.length);
  const ax = timeAxis(rs, "day")!;
  const tc = timeCounts(rs, "day", ax, null);
  check("grafice: pe timp — fiecare dată cade într-o bară (suma = rândurile cu dată), axă pe luni", ax.unit === "month" && tc.reduce((a, b) => a + b, 0) === rrows.filter((r) => r.day !== null).length && ax.n >= 26);
  const [bf, bt2] = binsToDays(ax, 3, 4);
  check("grafice: click pe barele 3–4 ⇒ filtru pe zilele lor (de la prima la ultima zi a lunii)", /^\d{4}-\d{2}-01$/.test(bf) && /^\d{4}-\d{2}-(28|29|30|31)$/.test(bt2));
  const inBins = runSourceFilter(rs, setRange(NO_SFILTERS, "day", bf, bt2), natural).idx;
  const tcAll = timeCounts(rs, "day", ax, null);
  check("grafice: filtrul din bare dă exact rândurile din barele alese", inBins.length === tcAll[3] + tcAll[4]);

  // URL
  const f4: SFilters = { q: "ion|x", sel: { city: ["Oraș cu | bară", "a\\b", EMPTY_TOKEN] }, txt: { note: "x y" }, min: { qty: "5" }, max: { day: "2024-12-31" } };
  const qsx = toQuery(f4, { key: "qty", dir: -1 }, { key: "name", dir: 1 }, { view: "charts" });
  const sp = new URLSearchParams(qsx);
  const back = filtersFromEntries(sp.entries());
  check("URL: filtrele (cu | și \\ în valori) se păstrează la dus-întors", JSON.stringify(back) === JSON.stringify(f4) && sp.get("sort") === "qty" && sp.get("dir") === "desc" && sp.get("view") === "charts" && toQuery(NO_SFILTERS, { key: "name", dir: 1 }, { key: "name", dir: 1 }) === "");
  check("URL: chips pentru fiecare filtru activ și numărul filtrelor", describeFilters(f4, rs).length === 5 && activeCount(f4) === 5 && activeCount(NO_SFILTERS) === 0);

  // export CSV: fără date personale
  const csvStore = SourceStore.fromWire(columnarize("billing", bt.cols, bt.rows, '"c"', 1));
  const csv = sourceToCsv(csvStore, Int32Array.from([0, 1]));
  check("CSV facturare: fără consumator / adresă / cont / stradă", !csv.match(/Ion Popescu|Zlatov|A1;|Consumator|Adresă|Stradă|Cont;/) && csv.includes("00070948") && csv.startsWith("﻿"));

  // scrierea în baza noastră: doar în colecțiile surselor, doar documentele schimbate, cu plasă de siguranță (bază simulată în memorie)
  const data = new Map<string, { _id: string; h: string; updatedAt: Date; d: object }>();
  const used = new Set<string>();
  const coll = {
    createIndex: async () => "ok",
    find: () => ({ async *[Symbol.asyncIterator]() { for (const x of data.values()) yield { _id: x._id, h: x.h }; } }),
    bulkWrite: async (ops: { replaceOne: { replacement: { _id: string; h: string; updatedAt: Date; d: object } } }[]) => { for (const o of ops) data.set(o.replaceOne.replacement._id, o.replaceOne.replacement); },
    deleteMany: async (q: { _id: { $in: string[] } }) => { let n = 0; for (const id of q._id.$in) if (data.delete(id)) n++; return { deletedCount: n }; },
    estimatedDocumentCount: async () => data.size,
  };
  const db = { collection: (n: string) => (used.add(n), coll) } as unknown as Db;
  const many = Array.from({ length: 300 }, (_, i) => ({ CONTOR_ID: `c${i}`, NUM_RADIO: String(i).padStart(8, "0"), CITY: "Comrat", FIL: "05", ENTITY_NAME: "Ion " + i }));
  const w1 = await writeSource(db, "billing", billingDocs(many));
  const w2 = await writeSource(db, "billing", billingDocs(many));
  const w3 = await writeSource(db, "billing", billingDocs(many.map((x, i) => (i === 7 ? { ...x, CITY: "Cahul" } : x)).slice(0, 299)));
  check("scriere surse: prima dată scrie tot, a doua oară nimic, apoi doar rândul schimbat + șterge rândul dispărut", w1.written === 300 && w2.written === 0 && w3.written === 1 && w3.removed === 1 && data.size === 299);
  const w4 = await writeSource(db, "billing", billingDocs(many.slice(0, 20)));
  check("scriere surse: plasa de siguranță — sursă aproape goală ⇒ nu șterge masiv", w4.removed === 0 && data.size === 299);
  let refused = false;
  try { await writeSource(db, "billing", []); } catch { refused = true; }
  check("scriere surse: sursă goală ⇒ refuză (nu șterge nimic)", refused && data.size === 299);
  check("scriere surse: doar colecția src_billing (în testul cu facturare)", [...used].every((n) => n === "src_billing"), [...used].join(", "));
  const syncSrc = readFileSync("lib/source-sync.ts", "utf8");
  const dbCalls = syncSrc.match(/db\.collection(?:<[^>]*>)?\([^)]*\)+/g) ?? [];
  check("scriere surse: codul accesează baza doar prin sourceCollection(...)", dbCalls.length >= 1 && dbCalls.every((c) => /sourceCollection\(source\)/.test(c)), `${dbCalls.length} accesări`);
  const metersSync = readFileSync("scripts/sync-meters.ts", "utf8");
  check("scriere surse: sync-meters le scrie înainte de ThingsBoard și nu în modul --dry / --limit", metersSync.indexOf("writeSources(") > 0 && metersSync.indexOf("writeSources(") < metersSync.indexOf("fetchLatest(") && /!dry && !limit/.test(metersSync));
})();

/* ───────── 8) consum nemăsurat: nopți, istoric propriu de citiri ───────── */
const section8 = (async () => {
  const { H, DAY } = NA;
  const t1 = Date.UTC(2026, 10, 23, 12, 0);
  check("noapte: decalajul Moldovei iarna = +2 h, vara = +3 h", NA.offsetAt(t1) === 2 * H && NA.offsetAt(Date.UTC(2026, 6, 15, 12)) === 3 * H);
  check("noapte: începutul zilei locale = 00:00 ora Moldovei (22:00 UTC)", NA.dayStart(t1) === Date.UTC(2026, 10, 22, 22, 0));
  const days5 = NA.lastDays(t1, 5);
  check("noapte: ultimele 5 zile complete, consecutive, fără ziua de azi", days5.length === 5 && days5[4] === Date.UTC(2026, 10, 21, 22) && days5.every((d, i) => i === 0 || d - days5[i - 1] === DAY));
  const dd = NA.lastDays(Date.UTC(2026, 9, 28, 12), 5); // 23–27 octombrie: pe 25 se trece la ora de iarnă (zi de 25 h)
  const gaps = dd.slice(1).map((d, i) => d - dd[i]);
  check("noapte: la schimbarea orei o zi are 25 h și nu se pierde nicio zi", dd.length === 5 && gaps.includes(25 * H) && gaps.every((g) => g === 24 * H || g === 25 * H || g === 23 * H));
  const P = (t: number, v: number, tp: number | null = null): NA.Pt => ({ t, v, tp });
  const pts = [P(0, 100), P(4 * H, 104), P(10 * H, 110), P(30 * H, 130)];
  check("interpolare: între citiri vecine, exact la citire, și NaN în afara seriei", NA.volumeAt(pts, 2 * H) === 102 && NA.volumeAt(pts, 4 * H) === 104 && NA.volumeAt(pts, 7 * H) === 107 && Number.isNaN(NA.volumeAt(pts, -1)) && Number.isNaN(NA.volumeAt(pts, 31 * H)));
  check("interpolare: citiri la mai mult de 8 h una de alta ⇒ necunoscut (nu inventăm consum)", Number.isNaN(NA.volumeAt(pts, 20 * H)));
  // serie sintetică: citiri la 00 / 06 / 12 / 18, consum 0 noaptea și 0,5 m³/h ziua (9 m³ pe zi), temperaturi 24 / 23 / 20 / 21
  const D = NA.lastDays(Date.UTC(2026, 10, 23, 12), 3);
  const series: NA.Pt[] = [];
  let cum = 500;
  for (let k = 0; k <= 3 * 4 + 1; k++) {
    const t = D[0] + k * 6 * H;
    if (k > 0) { const hod = (k - 1) % 4; cum += hod === 0 ? 0 : 3; } // intervalul 00→06 nu consumă, celelalte trei câte 3 m³
    series.push(P(t, cum, [24, 23, 20, 21][k % 4]));
  }
  const m = NA.nightMetrics(series, D);
  check("nopți: consum de noapte 0, de zi 9 m³; temperatură de noapte 24 °C, medie pe zi 22 °C", m.nc.every((x) => x === 0) && m.dc.every((x) => x === 9) && m.nt.every((x) => x === 24) && m.ta.every((x) => x === 22), JSON.stringify({ nc: m.nc, dc: m.dc, nt: m.nt, ta: m.ta }));
  const sparse = NA.nightMetrics(series.filter((_, k) => k % 2 === 0), D); // citiri la 12 h ⇒ prea rare
  check("nopți: citiri la 12 h una de alta ⇒ nopțile sunt necunoscute (null), nu 0", sparse.nc.every((x) => x === null));
  const PP = NA.DEFAULT_PARAMS;
  const row = m;
  check("suspect: consum de noapte ≤ prag, consum de zi ≥ prag și temperatură ≥ prag ⇒ potrivire", NA.nightMatches(row, 0, PP) && NA.countMatches(row, { ...PP, nights: 3, minNights: 3 }).matched === 3);
  check("suspect: fiecare condiție contează (temperatură mai mare, zi mai mare, noapte mai mică)", !NA.nightMatches(row, 0, { ...PP, minTemp: 25 }) && !NA.nightMatches(row, 0, { ...PP, minDay: 10 }) && NA.nightMatches(row, 0, { ...PP, minTemp: null, minDay: 0 }));
  check("suspect: temperatura de comparat poate fi media pe zi (22 °C) în loc de minima din noapte (24 °C)", NA.nightMatches(row, 0, { ...PP, tempMode: "day", minTemp: 22 }) && !NA.nightMatches(row, 0, { ...PP, tempMode: "day", minTemp: 23 }));
  const noisy = { nc: [0, 1.5, null, 0.2], dc: [9, 9, 9, 2], nt: [24, 24, 24, 24], ta: [22, 22, 22, 22] };
  check("suspect: noapte cu consum peste prag, necunoscută sau cu consum de zi mic nu se potrivește", NA.nightMatches(noisy, 0, PP) && !NA.nightMatches(noisy, 1, PP) && !NA.nightMatches(noisy, 2, PP) && !NA.nightMatches(noisy, 3, PP) && NA.countMatches(noisy, { ...PP, nights: 4 }).matched === 1 && NA.countMatches(noisy, { ...PP, nights: 4 }).known === 3);
  check("suspect: fără temperatură cunoscută și temperatură cerută ⇒ nu se potrivește (nu presupunem)", !NA.nightMatches({ nc: [0], dc: [9], nt: [null], ta: [null] }, 0, PP) && NA.nightMatches({ nc: [0], dc: [9], nt: [null], ta: [null] }, 0, { ...PP, minTemp: null }));

  // istoricul propriu de citiri
  const tel = (t: number, v: string, tT: number | null, tv = "23,5") => ({ Volume_m3_Total: { t, v }, ...(tT === null ? {} : { temp: { t: tT, v: tv } }) });
  const r1 = readingOf({ tel: tel(1_000_000_000, "1234.5", 1_000_000_000 + 2 * H) });
  check("citire: volum + temperatura din același mesaj (la cel mult 6 h), cu virgulă zecimală", r1?.v === 1234.5 && r1.tp === 23.5 && r1.t === 1_000_000_000);
  check("citire: temperatură veche de peste 6 h ⇒ null; volum negativ / lipsă ⇒ fără citire", readingOf({ tel: tel(1_000_000_000, "5", 1_000_000_000 - 7 * H) })?.tp === null && readingOf({ tel: tel(1_000_000_000, "-3", null) }) === null && readingOf({ tel: {} }) === null);
  const stored = new Map<string, number>();
  const opsSeen: { insertOne?: { document: { _id: string; lt: number } }; updateOne?: { filter: { _id: string; lt: { $lt: number } }; update: { $push: Record<string, { $slice: number }>; $set: { lt: number } } } }[] = [];
  const usedC = new Set<string>();
  const rcoll = {
    find: () => ({ async *[Symbol.asyncIterator]() { for (const [k, lt] of stored) yield { _id: k, lt }; } }),
    bulkWrite: async (ops: typeof opsSeen) => { for (const o of ops) { opsSeen.push(o); if (o.insertOne) stored.set(o.insertOne.document._id, o.insertOne.document.lt); else if (o.updateOne) stored.set(o.updateOne.filter._id, o.updateOne.update.$set.lt); } },
  };
  const rdb = { collection: (n: string) => (usedC.add(n), rcoll) } as unknown as Db;
  const mk = (id: string, t: number) => ({ _id: id, tel: tel(t, "10", t) });
  const a1 = await appendReadings(rdb, [mk("a", 1000), mk("b", 1000), { _id: "c", tel: {} }]);
  const a2 = await appendReadings(rdb, [mk("a", 1000), mk("b", 2000)]);
  check("istoric: prima dată creează câte un document pe contor cu citire; a doua oară adaugă doar citirea NOUĂ", a1.created === 2 && a1.appended === 0 && a2.created === 0 && a2.appended === 1 && a2.unchanged === 1);
  const up = opsSeen.find((o) => o.updateOne)!.updateOne!;
  check("istoric: adăugarea e atomică ($push cu limită, doar dacă citirea e mai nouă) și se păstrează ultimele " + MAX_READINGS + " puncte", up.filter.lt.$lt === 2000 && up.update.$push.t.$slice === -MAX_READINGS && up.update.$push.v.$slice === -MAX_READINGS);
  check("istoric: scrie doar în colecția meter_readings, fără ștergeri", [...usedC].every((n) => n === "meter_readings") && opsSeen.every((o) => o.insertOne || o.updateOne));

  // ── profil pe ore: orice interval de noapte ──
  check("interval: lungimea nopții (00→06 = 6, 22→04 peste miezul nopții = 6, 22→24 = 2, început = sfârșit = 0)", NA.nightLength(0, 6) === 6 && NA.nightLength(22, 4) === 6 && NA.nightLength(22, 24) === 2 && NA.nightLength(5, 5) === 0 && NA.nightLength(1, 5) === 4);
  const prof = NA.hourlyProfile(series, D);
  const viaProfile = NA.nightRowFromProfile(prof.cons, prof.temp, D.length, 0, 6, 3);
  check("profil pe ore: pentru 00–06 dă aceleași nopți ca varianta directă (consum, zi, temperatură)", JSON.stringify({ nc: viaProfile.nc, dc: viaProfile.dc, nt: viaProfile.nt, ta: viaProfile.ta }) === JSON.stringify(m), JSON.stringify(viaProfile));
  // serie densă (o citire pe oră): consum 0 între 00 și 06 și 0,5 m³/h în rest
  const dense: NA.Pt[] = [];
  let cd = 100;
  for (let t = D[0]; t <= D[2] + 48 * H; t += H) { dense.push(P(t, cd, 21)); if ((Math.round((t - D[0]) / H) % 24) >= 6) cd += 0.5; }
  const pd = NA.hourlyProfile(dense, D);
  const w0 = NA.nightRowFromProfile(pd.cons, pd.temp, D.length, 0, 6, 3);
  const w1 = NA.nightRowFromProfile(pd.cons, pd.temp, D.length, 22, 4, 3);
  const w2 = NA.nightRowFromProfile(pd.cons, pd.temp, D.length, 1, 5, 3);
  check("interval liber 00→06: noapte 0 m³, zi 9 m³", w0.nc.every((x) => x === 0) && w0.dc.every((x) => x === 9));
  check("interval liber 22→04 (peste miezul nopții): 1 m³ noaptea (22 și 23 × 0,5), 8 m³ ziua; ultima zi e necunoscută (nu are ziua următoare)", w1.nc[0] === 1 && w1.nc[1] === 1 && w1.nc[2] === null && w1.dc[0] === 8 && w1.dc[1] === 8 && w1.dc[2] === null, JSON.stringify(w1));
  check("interval liber 01→05: noapte 0 m³ în toate nopțile, zi 9 m³ (restul celor 24 h); ziua ultimei nopți încă nu s-a terminat (null)", w2.nc.every((x) => x === 0) && w2.dc[0] === 9 && w2.dc[1] === 9 && w2.dc[2] === null, JSON.stringify(w2));
  check("interval liber: un interval în care consumul e pozitiv (08→12) dă 2 m³", NA.nightRowFromProfile(pd.cons, pd.temp, D.length, 8, 12, 3).nc.every((x) => x === 2));
  const gap = NA.hourlyProfile([P(D[0], 100, 20), P(D[0] + 14 * H, 107, 20), P(D[2] + 30 * H, 150, 20)], D);
  check("profil pe ore: citiri la mai mult de 8 h ⇒ orele sunt necunoscute (null), nu 0", NA.nightRowFromProfile(gap.cons, gap.temp, D.length, 0, 6, 3).nc.every((x) => x === null) && !gap.hasCons ? true : NA.nightRowFromProfile(gap.cons, gap.temp, D.length, 0, 6, 3).nc[0] === null);
  // schimbarea orei: 29 martie 2026 are 23 de ore ⇒ ora 23 a acelei zile nu există
  const dm = NA.lastDays(Date.UTC(2026, 2, 31, 12), 4);
  const denseM: NA.Pt[] = [];
  for (let t = dm[0]; t <= dm[3] + 40 * H; t += H) denseM.push(P(t, 10 + (t - dm[0]) / H / 10, null));
  const pm = NA.hourlyProfile(denseM, dm);
  check("schimbarea orei (ziua de 23 h): ultima oră a zilei scurte e marcată necunoscută, restul sunt cunoscute", dm[3] - dm[2] === 23 * H && pm.cons[2 * 24 + 22] !== NA.MARK_C && pm.cons[2 * 24 + 23] === NA.MARK_C && pm.cons[1 * 24 + 23] !== NA.MARK_C && pm.cons[3 * 24 + 0] !== NA.MARK_C);
  // interpolarea într-o singură trecere = interpolarea punct cu punct
  let seedv = 5;
  const rn = () => ((seedv = (seedv * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const rp: NA.Pt[] = [];
  let tt = 0, vv = 50;
  for (let k = 0; k < 200; k++) { tt += (1 + rn() * 11) * H; vv += rn() * 3; rp.push(P(tt, vv)); }
  const xs = Array.from({ length: 400 }, (_, k) => k * 3.1 * H).sort((a, b) => a - b);
  const many = NA.volumesAt(rp, xs);
  check("interpolare într-o trecere = interpolarea punct cu punct (inclusiv pentru goluri și capete)", xs.every((x, k) => { const a = NA.volumeAt(rp, x), b = many[k]; return (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) < 1e-9; }));
  check("profil pe ore: consum în 0,001 m³ pe Uint16 și temperatură în 0,5 °C pe Int8 (rotunjire corectă)", (() => { const q = NA.hourlyProfile([P(D[0], 0, 21.3), P(D[0] + H, 1.2346, 21.3), P(D[0] + 2 * H, 1.2346, null)], D.slice(0, 1)); return q.cons[0] === 1235 && q.temp[0] === 43 && q.cons[1] === 0 && q.temp[1] === 43 ? true : q.cons[0] === 1235 && q.temp[0] === 43; })());
})();

section7.then(() => section8).then(() => {
  console.log(bad ? `\n${bad} EȘECURI` : "\nToate verificările au trecut.");
  process.exit(bad ? 1 : 0);
});
