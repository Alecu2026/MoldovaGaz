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
import { ALERT_FLAGS, FLAG, PROBLEM_FLAGS, activityOf, isStatusOk, validCoords, type ColsWire, type DatasetWire, type DeltaWire } from "../lib/meter-shared";
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
import { EXCLUDED_PROFILE, GAS_CUSTOMERS } from "../lib/meter-scope";
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
const emptyCols = (): ColsWire => ({ id: [], ts: [], nm: [], eu: [], q: [], ap: [], gw: [], br: [], ct: [], pf: [], rssi: [], snr: [], fr: [], fl: [], fc: [], pt: [], tm: [], val: [], bat: [], dc: [], mc: [], la: [], lo: [] });
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
      const m = L(f.flag).reduce((a, k) => a | (k === "alert" ? ALERT_FLAGS : k === "batt" ? FLAG.BATT : k === "offline" ? FLAG.OFFLINE : k === "button" ? FLAG.BTN : k === "magnet" ? FLAG.MAG : k === "dup" ? FLAG.DUP : k === "inactive" ? FLAG.INACTIVE : 0), 0);
      const toks = L(f.flag);
      if (!((m !== 0 && (v.fl & m) !== 0) || (toks.includes("ok") && isStatusOk(v.fl)) || (toks.includes("nostatus") && !(v.fl & FLAG.STATUS)))) continue;
    }
    if (f.billed === "1" && !(v.fl & FLAG.BILLED)) continue;
    if (f.billed === "0" && v.fl & FLAG.BILLED) continue;
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
  ["cu coordonate", F({ geo: "1" })], ["fără coordonate", F({ geo: "0" })], ["coordonate + filială", F({ geo: "1", branch: "05 · Comrat" })],
  ["stare OK", F({ flag: "ok" })], ["fără raport de stare", F({ flag: "nostatus" })], ["OK + offline", F({ flag: "ok|offline" })], ["OK + serie repetată", F({ flag: "ok|dup|nostatus" })],
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

// stări ca în SCADA: „offline” raportat de contor NU e alertă; alerta = baterie slabă sau inactiv; „OK” exclude și inactivii; filtrele pe trepte de activitate
{
  const fl = (a: number, ...b: number[]) => b.reduce((x, y) => x | y, a);
  check("stări: «offline» din mesajul contorului nu mai e alertă și nici problemă; inactiv = alertă", (FLAG.OFFLINE & ALERT_FLAGS) === 0 && (FLAG.OFFLINE & PROBLEM_FLAGS) === 0 && (FLAG.INACTIVE & ALERT_FLAGS) !== 0 && (FLAG.BATT & ALERT_FLAGS) !== 0);
  check("stări: OK = raport de stare fără baterie / buton / magnet și fără inactiv; offline raportat nu strică OK", isStatusOk(FLAG.STATUS) && isStatusOk(fl(FLAG.STATUS, FLAG.OFFLINE)) && !isStatusOk(fl(FLAG.STATUS, FLAG.INACTIVE)) && !isStatusOk(fl(FLAG.STATUS, FLAG.BATT)) && !isStatusOk(0));
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
  const allowedFetch = new Set(["lib/thingsboard.ts", "lib/meter-sync.ts", "app/components/useMeterStore.ts", "app/components/MeterDetail.tsx", "app/components/useSourceStore.ts"]);
  check("read-only: fetch() doar în fișierele așteptate", fetches.every((f) => allowedFetch.has(f)), [...new Set(fetches)].join(", "));
  const mutating = files.filter((f) => /method:\s*"(PUT|DELETE|PATCH)"|\.(deleteOne|deleteMany|drop|updateMany|updateOne|insertOne|insertMany|replaceOne|bulkWrite)\(/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/"));
  // scrieri în baza NOASTRĂ: doar sesiuni / utilizator (login, seed) și colecția `meters` (sincronizare); niciodată în surse
  const allowedWrites = new Set(["lib/session.ts", "scripts/seed-user.ts", "scripts/sync-meters.ts", "scripts/load-history.ts", "lib/source-sync.ts"]);
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
    const expectKept = [...world.values()].reduce((a, l) => a + l.filter((d) => !/^Defectate_/.test(d.type)).length, 0) - 1; // −1: duplicatul
    check("scada: lista finală = cei 10 clienți, fără Defectate_* și fără dubluri", lst.devices.length === expectKept && lst.devices.every((d) => !EXCLUDED_PROFILE.test(d.type)) && new Set(lst.devices.map((d) => d.id.id)).size === lst.devices.length && lst.perCustomer.length === 10, `${lst.devices.length} contoare`);
    check("scada: pe fiecare client se raportează total și păstrate", lst.perCustomer.every((p) => p.total >= p.kept && p.total - p.kept >= 2) && lst.perCustomer[0].total === 5 + 2 + 1);
    check("scada: se cheamă doar adrese permise (login + lista clienților); nicio scriere", calls.every((c) => c === "POST /api/auth/login" || /^GET \/api\/customer\/[0-9a-f-]{36}\/devices\?pageSize=1000&page=\d+$/.test(c)) && calls.filter((c) => c.startsWith("GET")).length === 10, `${calls.length} cereri`);
    breakTotal = true;
    let stopped = false;
    try { await fetchDevices(); } catch (e) { stopped = /opresc/.test((e as Error).message); }
    check("scada: dacă lista primită nu e completă (total ≠ primite) ⇒ se oprește, nu construiește o listă parțială", stopped);
    breakTotal = false;
    const okGet = (p: string) => { try { assertReadOnly("GET", p); return true; } catch { return false; } };
    const cid = GAS_CUSTOMERS[0].id;
    check("read-only: citirea listei unui client e permisă, dar nu și alte apeluri pe client", okGet(`/api/customer/${cid}/devices?pageSize=1000&page=0`) && !okGet(`/api/customer/${cid}`) && !okGet(`/api/customer/${cid}/devices?pageSize=1000&page=0&x=1`) && !okGet("/api/customers?pageSize=10&page=0") && !(() => { try { assertReadOnly("POST", `/api/customer/${cid}/devices?pageSize=1000&page=0`); return true; } catch { return false; } })() && !(() => { try { assertReadOnly("DELETE", `/api/customer/${cid}/devices?pageSize=1000&page=0`); return true; } catch { return false; } })());
    check("scope: cei 10 clienți au filiale distincte, toate cunoscute (01…36)", GAS_CUSTOMERS.length === 10 && new Set(GAS_CUSTOMERS.map((c) => c.fil)).size === 10 && GAS_CUSTOMERS.every((c) => /^(01|05|10|11|20|27|31|33|35|36)$/.test(c.fil)) && !EXCLUDED_PROFILE.test("Comrat_Gas_Meter_DP") && EXCLUDED_PROFILE.test("Defectate_Jooby_Gaz"));
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

section7.then(() => {
  console.log(bad ? `\n${bad} EȘECURI` : "\nToate verificările au trecut.");
  process.exit(bad ? 1 : 0);
});
