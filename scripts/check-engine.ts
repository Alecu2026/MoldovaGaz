/**
 * Verifică motorul de contoare față de implementări „naive”, pe date sintetice (nu atinge nicio bază de date și nicio rețea):   npm run check
 *  - filtre (liste SAU, intervale, filială, oraș, căutare) și sortări;
 *  - agregări (totalurile pe fiecare dimensiune trebuie să iasă egale cu numărătoarea naivă);
 *  - actualizări pe loc (delta cu rânduri modificate + noi), snapshot IndexedDB;
 *  - combinarea facturare ↔ dispozitive ↔ ThingsBoard (lib/meter-sync.ts).
 */
import { aggregate, makeCtx, FRESH_EDGES } from "../lib/meter-aggregate";
import { NO_FILTERS, activeFilters, filtersFromParams, periodStarts, runFilter, sortFromParams, toQuery as mToQuery, type Filters, type Sort } from "../lib/meter-filter";
import { MeterStore } from "../lib/meter-store";
import { ALERT_FLAGS, FLAG, PROBLEM_FLAGS, XSTR, activityOf, safeTs, isStatusOk, validCoords, type ColsWire, type DatasetWire, type DeltaWire } from "../lib/meter-shared";
import { buildDocs, fetchDevices, type Bill, type Dev } from "../lib/meter-sync";
import { assertReadOnly, tbCustomerDevices } from "../lib/thingsboard";
import { pack, unpack, type Pts } from "../lib/meter-history";
import { addressLinks, boundsOf, buildClusters, samePlace, latFromY, lonFromX, mapLinks, mercX, mercY, worldSize } from "../lib/geo";
import { SourceStore, type SortSpec } from "../lib/source-store";
import { billingDocs, billingTable, columnarize, lorawanDocs, lorawanTable } from "../lib/source-schemas";
import { EMPTY_TOKEN, type ColDef, type SourceRow } from "../lib/source-shared";
import { NO_SFILTERS, activeCount, binsToDays, describeFilters, dictCounts, filtersFromEntries, runFilter as runSourceFilter, setRange, timeAxis, timeCounts, toQuery, type SFilters } from "../lib/source-filter";
import { sourceToCsv } from "../lib/source-csv";
import { writeSource } from "../lib/source-sync";
import * as NA from "../lib/night-analysis";
import { RESTART_GAP, counterOf, lostOf, newStream, observe, summarize } from "../lib/integration-counter";
import { distanceKm as kmDist } from "../lib/geo";
import { activity, cleanPatch, parseQr, qrNotInDb, queryInstaller } from "../lib/installer";
import { decodeImage, photoPath, processImage, validId } from "../lib/photos";
import { MAX_TRIES, pendingIds } from "../lib/photo-job";
import { atName, csvCell, fmtDmy, fmtLocal, fmtUtc, latestAt, localToUtc, mergePoints, monthStartAt, radioOf, readingLine, reportBatches } from "../lib/report-readings";
import { DAY as GDAY, buildStats, dayRange, foldDays, type DayAgg, type GwSum } from "../lib/gateway-stats";
import { eventToMsg, gatewaysOf, looksLikeEvent, looksLikeUplink, nameKey, uplinkToMsg } from "../lib/integration-uplink";
import { MAX_BATCH, isStaleFcnt, isStaleUplink, ingestIsNewer, mergeDerive, mergeMsgs, normTs, parseMessage, type MeterDocIng } from "../lib/integration";
import { MAX_READINGS, appendReadings, readingOf } from "../lib/meter-readings";
import { DEFECT_PROFILE, GAS_CUSTOMERS } from "../lib/meter-scope";
import { antennaIdOk, chirpstackFields, chirpstackText, cleanAntennaPatch, cleanNewAntenna, fdtA, parseAntennaQr, queryAntennas, type AntennaRow } from "../lib/antennas";
import { HOUR as H1, DAY as D1, gatewayDown, gatewayDrop, silentByZone, silentProblem, zoneOf } from "../lib/alert-rules";
import { deliver, planEvents, recipients, type Problem } from "../lib/alert-job";
import { cleanNotify, eventVisible } from "../lib/notify";
import { cleanSub, type PushSub, type Sender } from "../lib/push";
import { ChirpStack, type FetchFn } from "../lib/lorawan/chirpstack";
import { GAS_TYPES, backupTarget, chirpName, cleanModule, primaryTarget, v4Target, type ModuleInput } from "../lib/lorawan/config";
import { decryptJson, encryptJson } from "../lib/lorawan/crypto";
import { abpExtraFrame, emergencyBackup, expectedDevAddr, otaaDown, registerPrimary, type Ctx } from "../lib/lorawan/flows";
import { gasLink, ours } from "../lib/antennas";
import { PASSWORD_MAX, PASSWORD_MIN, passwordProblem, passwordStrength } from "../lib/password-rules";
import { IMPERSONATION_TTL_MS, canImpersonate, formatRemaining, type ImpActor, type ImpTarget } from "../lib/impersonation";
import { ACTIONS as AUDIT_ACTIONS, AUDIT_MODULES, actionSeverity, auditFiltersToParams, countAuditFilters, describeAgent, sanitizeAuditFilters, EMPTY_AUDIT_FILTERS } from "../lib/audit-meta";
import { ANTENNA_SPEC, INSTALLER_SPEC, diffAccess, diffFields, fmtAuditValue, summarizeChanges } from "../lib/audit-diff";
import { PAGES, PRESETS, allowsMeter, can, canOf, canPage, cleanAccess, firstPath, grantable, sameAccess, scopeKey, viewerFromDoc, type Viewer } from "../lib/access";
import { DEFAULT_FILTER, KM_EDGES, bandOf, inRadius, parseQuery, passes, periodBounds, periodText, describe, queryActive, queryString, radiusOf, toQuery as gwQuery, type GwFilter } from "../lib/gw-filter";
import { DAY as MDAY, KEEP_DAYS, countOn, dayIdx, packCounts, parseDay, parsePeriod, step as msgStep, sumOver, unpackCounts } from "../lib/meter-msgs";
import type { MsgState } from "../lib/meter-msgs";
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
const emptyCols = (): ColsWire => ({ id: [], ts: [], nm: [], eu: [], q: [], ap: [], gw: [], br: [], ct: [], pf: [], rssi: [], snr: [], fr: [], fl: [], fc: [], pt: [], tm: [], val: [], bat: [], dc: [], mc: [], ac: [], ia: [], mg: [], il: [], cal: [], xsp: [], xcp: [], xsn: [], xsr: [], xhs: [], xap: [], dt: [], mt: [], la: [], lo: [] });
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
  { const ps = periodStarts(Date.now()); let cd = 0, cdn = 0, cy = 0, cyn = 0, cm = 0, cmn = 0;
    for (const i of want) { if (st.dc[i] >= 0) { if (st.dt[i] === ps.dayStart) { cd += st.dc[i]; cdn++; } else if (st.dt[i] === ps.dayStart - 86_400_000) { cy += st.dc[i]; cyn++; } } if (st.mt[i] === ps.monthStart && st.mc[i] >= 0) { cm += st.mc[i]; cmn++; } }
    check("consum pe perioadă: suma zilei / zilei anterioare / lunii CURENTE (doar contoarele care au raportat în acea perioadă) = calculul independent", r.consDay === cd && r.consDayN === cdn && r.consYest === cy && r.consYestN === cyn && r.consMonth === cm && r.consMonthN === cmn && cdn > 0 && cyn > 0 && cmn > 0 && cdn < want.length); }
  check("perioade: ziua / luna SCADA după UTC, nu după data locală (23:19 UTC pe 23.11 = încă ziua 23.11, chiar dacă la Chișinău e deja 24.11; 00:30 UTC pe 1.12 = luna decembrie)", periodStarts(Date.UTC(2026, 10, 23, 23, 19)).dayStart === Date.UTC(2026, 10, 23) && periodStarts(Date.UTC(2026, 10, 30, 23, 59)).monthStart === Date.UTC(2026, 10, 1) && periodStarts(Date.UTC(2026, 11, 1, 0, 30)).monthStart === Date.UTC(2026, 11, 1) && periodStarts(Date.UTC(2026, 11, 1, 0, 30)).dayStart === Date.UTC(2026, 11, 1));
  check("total volum și alerte din filtru", r.alerts === want.filter((i) => st.fl[i] & ALERT_FLAGS).length && Math.abs(r.volume - want.reduce((s, i) => s + (st.val[i] >= 0 ? st.val[i] : 0), 0)) < 1e-6);
}
// «Mesaje (total)»: coloană a listei (evidența din integrare), cu filtru pe interval și sortare; lipsa (null) nu trece de filtru și rămâne la sfârșit
{
  const cm = emptyCols();
  for (let i = 0; i < 4; i++) row(cm, i, `mg-${i}`);
  cm.mg = [100, null, 2500, 7];
  const sm = MeterStore.fromWire({ v: 3, gen: "g", head: 4, total: 4, dict: structuredClone(dict), cols: cm } as DatasetWire);
  const ids = (r: { idx: Int32Array }) => Array.from(r.idx, (i) => sm.id[i]).join();
  check("mesaje (total): filtrul pe interval ia doar contoarele cu evidență în interval (lipsa nu trece), sortarea după total merge crescător / descrescător cu lipsa la sfârșit, iar rândul expune totalul",
    ids(runFilter(sm, F({ mgMin: "100" }), SORT, now)).split(",").sort().join() === "mg-0,mg-2" && ids(runFilter(sm, F({ mgMin: "5", mgMax: "200" }), SORT, now)).split(",").sort().join() === "mg-0,mg-3"
    && ids(runFilter(sm, NO_FILTERS, { key: "mg", dir: -1 }, now)) === "mg-2,mg-0,mg-3,mg-1" && ids(runFilter(sm, NO_FILTERS, { key: "mg", dir: 1 }, now)) === "mg-3,mg-0,mg-2,mg-1"
    && sm.view(2).mg === 2500 && sm.view(1).mg === null && activeFilters(F({ mgMin: "1" })) === 1 && sortFromParams((k) => (k === "sort" ? "mg" : undefined)).key === "mg"
    && filtersFromParams((k) => (k === "mgMin" ? "50" : undefined)).mgMin === "50" && mToQuery(F({ mgMin: "50" }), SORT).includes("mgMin=50"));
  const ds = readFileSync("lib/services/meter-dataset.ts", "utf8");
  check("mesaje (total): circulă prin lista de contoare (aceeași ETag / 304, gzip, delta, IndexedDB): citit din evidența integrării la construire și la fiecare reîmprospătare, rândul cu total schimbat primește seq nou", ds.includes("async function mergeSeen") && ds.includes("COLLECTIONS.seen") && ds.includes("st.cols.sq[i] = ++st.seq") && ds.includes('"ac", "ia", "mg"') && ds.includes("g.__mtSeen?.map.get(id)"));
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
  check("ora citirii din viitor (ceas greșit, ex. 2053) nu ajunge în listă: se folosește momentul sosirii volumului, altfel «fără citire»; o dată normală sau cu o diferență sub o oră rămâne", safeTs(Date.UTC(2053, 7, 3), 1_700_000_000_000, 1_700_000_100_000) === 1_700_000_000_000 && safeTs(Date.UTC(2053, 7, 3), undefined, 1_700_000_100_000) === 0 && safeTs(Date.UTC(2053, 7, 3), Date.UTC(2060, 0, 1), 1_700_000_100_000) === 0 && safeTs(1_700_000_050_000, 1, 1_700_000_100_000) === 1_700_000_050_000 && safeTs(1_700_000_100_000 + 1_800_000, 1, 1_700_000_100_000) === 1_700_000_100_000 + 1_800_000 && safeTs(0, 1) === 0);
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
    { const mk = (extra: number) => { const x = tel({ Volume_m3_Total: "10.000" }); x.TIME_SERIES.Volume_m3_Total = { ts: 1_700_000_900_000, value: "10.000" }; x.TIME_SERIES.Volume_m3_Total_ts = { ts: 1_700_000_900_000 + extra, value: "10.000" }; return buildDocs(devices, billing, new Map([["c1", x]]), new Date(0)).docs.find((d) => d._id === "c1")!.s.t; };
      check("sync: ora citirii în VIITOR (ceasul contorului e greșit: +3 ani, +90 de ani) ⇒ se folosește momentul sosirii, nu data imposibilă", mk(3 * 365 * 86_400_000) === 1_700_000_900_000 && mk(90 * 365 * 86_400_000) === 1_700_000_900_000);
      check("sync: ora citirii la cel mult o oră după sosire (diferență de ceas mică) se păstrează; peste o oră ⇒ momentul sosirii", mk(1_800_000) === 1_700_000_900_000 + 1_800_000 && mk(3_700_000) === 1_700_000_900_000 && mk(-5_000_000) === 1_700_000_900_000 - 5_000_000); }
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
  const allowedFetch = new Set(["lib/thingsboard.ts", "app/components/SecurityPanel.tsx", "app/(auth)/uita-parola/ForgotForm.tsx", "app/(auth)/reset-parola/ResetForm.tsx", "app/components/ImpersonationBanner.tsx", "app/components/AntennaOverview.tsx", "app/components/gw-fetch.ts", "app/components/useMsgCounts.ts", "app/components/AuditLog.tsx", "app/components/AuditTracker.tsx", "lib/meter-sync.ts", "app/components/useMeterStore.ts", "app/components/MeterDetail.tsx", "app/components/useSourceStore.ts", "app/components/NightControl.tsx", "app/components/IntegrationPanel.tsx", "app/components/GatewayLayer.tsx", "app/components/KeptBrowser.tsx", "app/components/ReportsPanel.tsx", "app/components/InstallerApp.tsx", "app/components/GatewayPopup.tsx", "app/components/GatewayCharts.tsx", "app/components/SeenBrowser.tsx", "app/components/MeterAntennas.tsx", "app/components/UsersPanel.tsx", "app/components/useInstallerStore.ts", "app/components/AntennaApp.tsx", "app/components/NotificationsPanel.tsx", "app/components/NotifBell.tsx", "app/components/notify-client.ts", "app/components/LorawanPanel.tsx", "lib/services/lorawan.ts", "scripts/bench-integration.ts"]);
  check("read-only: fetch() doar în fișierele așteptate", fetches.every((f) => allowedFetch.has(f)), [...new Set(fetches)].join(", "));
  const mutating = files.filter((f) => /method:\s*"(PUT|DELETE|PATCH)"|\.(deleteOne|deleteMany|drop|updateMany|updateOne|insertOne|insertMany|replaceOne|bulkWrite)\(/.test(readFileSync(f, "utf8"))).map((f) => f.replace(/\\/g, "/"));
  // scrieri în baza NOASTRĂ: doar sesiuni / utilizator (login, seed) și colecția `meters` (sincronizare); niciodată în surse
  const allowedWrites = new Set(["lib/meter-msgs-job.ts", "lib/session.ts", "lib/services/account.ts", "lib/services/audit.ts", "scripts/seed-user.ts", "scripts/sync-meters.ts", "scripts/load-history.ts", "lib/source-sync.ts", "lib/meter-readings.ts", "lib/night-job.ts", "lib/services/integration.ts", "lib/services/gateways.ts", "lib/services/counters.ts", "lib/services/kept.ts", "lib/report-job.ts", "lib/services/reports.ts", "lib/photo-job.ts", "lib/services/installer.ts", "lib/services/users.ts", "lib/services/antennas.ts", "lib/antenna-job.ts", "lib/alert-job.ts", "lib/push.ts", "lib/services/lorawan.ts", "app/components/LorawanPanel.tsx", "lib/services/notifications.ts", "app/components/NotificationsPanel.tsx", "app/components/notify-client.ts", "app/components/ReportsPanel.tsx", "app/components/UsersPanel.tsx", "app/components/AntennaApp.tsx"]);
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
  check("hartă: fără grupare pe ecran — punctele din locuri diferite sunt bule separate", single.n === withGeo && Array.from(single.cnt).slice(0, single.n).every((c) => c === 1));
  {
    // contoare din același loc: 3 la aceeași adresă (0, 1, 2), 2 la ~1 cm unul de altul (3, 4) și unul singur în altă parte (5)
    const la2 = Float64Array.from([47.01, 47.01, 47.01, 47.0200001, 47.02, 47.5]), lo2 = Float64Array.from([28.5, 28.5, 28.5, 28.6, 28.6, 28.9]);
    const ix2 = Int32Array.from([0, 1, 2, 3, 4, 5]), g = buildClusters(la2, lo2, ix2, 18, 0);
    check("hartă: contoarele din ACELAȘI loc rămân o bulă cu numărătoare și la zoom maxim (3 + 2 + 1 ⇒ 3 bule)", g.n === 3 && Array.from(g.cnt).slice(0, 3).join() === "3,2,1", Array.from(g.cnt).slice(0, g.n).join());
    check("hartă: «același loc» dă membrii grupului (indicii din lista filtrată)", samePlace(la2, lo2, ix2, 1).join() === "0,1,2" && samePlace(la2, lo2, ix2, 4).join() === "3,4" && samePlace(la2, lo2, ix2, 5).join() === "5" && samePlace(la2, lo2, Int32Array.from([0, 1]), 0).join() === "0,1");
  }
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
  check("integrare: un contor cu data în VIITOR (ceas greșit, ex. 2053) NU mai blochează actualizarea din SCADA", !ingestIsNewer({ ing: 5, s: { t: Date.now() + 27 * 365 * 86_400_000 } }, Date.now()) && ingestIsNewer({ ing: 5, s: { t: Date.now() + 600_000 } }, Date.now() - 1000));
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
  { const r = newStream("r", "msg_counter", 6708, 1);
    for (const n of [6709, 6710, 6713, 9000, 33147]) observe(r, n, 2);
    check("counter: contorul expeditorului scade la 0 (a șters contorul) ⇒ «restart»; seria veche se poate rezuma; nimic nu se modifică la «restart»", observe(r, 0, 3) === "restart" && observe(r, 5, 3) === "restart" && r.max === 33147 && r.received === 6 && summarize(r).first === 6708 && summarize(r).max === 33147 && summarize(r).lost > 0 && r.lastAt === 2);
    check("counter: sosit puțin înaintea primului număr văzut (urmărirea a pornit în mijloc) ⇒ «târziu» și începutul se extinde; un duplicat apropiat rămâne duplicat", (() => { const q = newStream("q", "c", 500, 1); observe(q, 503, 2); const o = observe(q, 498, 3); const dup = observe(q, 503, 4); return o === "late" && q.first === 498 && q.late === 1 && JSON.stringify(q.missing.map((g) => [g[0], g[1]])) === "[[499,499],[501,502]]" && dup === "dup"; })());
    check("counter: un număr mult în urmă, dar care umple un gol, e «târziu», nu repornire", (() => { const q = newStream("q", "c", 1, 1); observe(q, 2, 2); observe(q, 3000, 3); const o = observe(q, 1500, 4); return o === "late" && RESTART_GAP === 1000; })());
  }
  const mid = newStream("x", "counter", 1, 1); [2, 3, 4, 5, 6, 7, 8, 9, 10].forEach((n) => observe(mid, n, 2)); observe(mid, 20, 3);
  const o5 = observe(mid, 15, 4);
  check("counter: număr sosit în mijlocul unui gol îl împarte în două", o5 === "late" && JSON.stringify(mid.missing.map((g) => [g[0], g[1]])) === "[[11,14],[16,19]]" && lostOf(mid) === 8);
  check("counter: câmpul msg_counter (și variante: msgCounter, MSG-COUNTER, în object / data), pe rădăcină are prioritate", counterOf({ msg_counter: 7 })?.value === 7 && counterOf({ msg_counter: "12" })?.field === "msg_counter" && counterOf({ msgCounter: 3 })?.value === 3 && counterOf({ "MSG-COUNTER": 9 })?.value === 9 && counterOf({ object: { msg_counter: 41 } })?.value === 41 && counterOf({ msg_counter: 5, object: { msg_counter: 99 } })?.value === 5 && counterOf({ msg_counter: "abc" }) === null && counterOf({ msg_counter: -1 }) === null && counterOf({ msg_counter: 2, stream: "GW1" })?.stream === "GW1");
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
  // statistici pe antene, pe zile
  { const d0 = Date.UTC(2026, 10, 20);
    const hits = [
      { g: "A", m: "m1", t: d0 + 1000, rssi: -100, snr: 5 }, { g: "A", m: "m1", t: d0 + 2000, rssi: -110, snr: 3 }, { g: "A", m: "m2", t: d0 + 3000, rssi: -90, snr: null },
      { g: "B", m: "m1", t: d0 + GDAY + 5, rssi: -120, snr: -8 }, { g: "A", m: "m1", t: d0 + GDAY + 7, rssi: -105, snr: 4 },
    ];
    const f1 = foldDays(hits, new Map());
    const a0 = f1.days.get("A|" + d0)!, a1 = f1.days.get("A|" + (d0 + GDAY))!;
    check("antene pe zile: mesaje, sume RSSI / SNR și «contoare-zile» (un contor se numără o dată pe zi la o antenă)", a0.n === 3 && a0.nr === 3 && a0.rs === -300 && a0.ns === 2 && a0.ss === 8 && a0.dv === 2 && a1.n === 1 && a1.dv === 1 && f1.days.get("B|" + (d0 + GDAY))!.dv === 1);
    const f2 = foldDays([{ g: "A", m: "m1", t: d0 + 500, rssi: -100, snr: 1 }, { g: "A", m: "m1", t: d0 + GDAY + 1, rssi: -100, snr: 1 }], new Map([["A|m1", d0]]));
    check("antene pe zile: ziua deja numărată (din baza de date) nu se numără din nou; ziua următoare da; ultima zi se actualizează", f2.days.get("A|" + d0)!.dv === 0 && f2.days.get("A|" + (d0 + GDAY))!.dv === 1 && f2.pairLd.get("A|m1") === d0 + GDAY);
    const sum: GwSum[] = [
      { id: "A", name: "ANT-Comrat", la: 46.3, lo: 28.6, state: "on", last: 1, devices: 10, primary: 6, exclusive: 2, rssi: -100, snr: 3 },
      { id: "B", name: "ANT-Orhei", la: 47.4, lo: 28.8, state: "off", last: 2, devices: 3, primary: 1, exclusive: 0, rssi: -118, snr: -5 },
      { id: "C", name: "ANT-Cahul", la: null, lo: null, state: "slow", last: 3, devices: 1, primary: 0, exclusive: 1, rssi: null, snr: null },
    ];
    const docs: DayAgg[] = [...f1.days.values()];
    const inMap = new Map([["A", 4], ["B", 1]]);
    const st = buildStats(sum, docs, inMap, { from: d0, to: d0 + GDAY, state: "", q: "", minDevices: 0, sort: "devices", gw: "" });
    check("antene (statistici): eficiența pe perioadă = sume din zilele perioadei; ordonare după contoare auzite", st.rows.map((r) => r.id).join() === "A,B,C" && st.rows[0].messages === 4 && st.rows[0].devicesIn === 4 && st.rows[0].perDevice === 1 && st.rows[0].rssiIn === -101.2 && st.rows[0].activeDays === 2 && st.rows[1].messages === 1 && st.rows[2].messages === 0 && st.rows[2].perDevice === null);
    check("antene (statistici): seria pe zile (mesaje, contoare-zile, antene active) fără goluri în perioadă", st.days.length === 2 && st.days[0].n === 3 && st.days[0].gws === 1 && st.days[1].n === 2 && st.days[1].gws === 2 && st.days[1].dv === 2 && st.totals.messages === 5 && st.totals.gateways === 3);
    const f3 = buildStats(sum, docs, inMap, { from: d0, to: d0 + GDAY, state: "off", q: "", minDevices: 0, sort: "name", gw: "A" });
    check("antene (statistici): filtru după stare; seria antenei alese rămâne a ei, chiar dacă nu trece de filtru", f3.rows.length === 1 && f3.rows[0].id === "B" && f3.gw?.id === "A" && f3.gw.days[0].n === 3 && f3.days.every((d) => d.gws <= 1));
    check("antene (statistici): căutare după nume și «minim contoare»; o perioadă fără zile cu date dă zero, nu eroare", buildStats(sum, docs, inMap, { from: d0, to: d0, state: "", q: "orhei", minDevices: 0, sort: "devices", gw: "" }).rows.length === 1 && buildStats(sum, docs, inMap, { from: d0, to: d0, state: "", q: "", minDevices: 2, sort: "devices", gw: "" }).rows.map((r) => r.id).join() === "A" && buildStats(sum, [], new Map(), { from: d0, to: d0 + 2 * GDAY, state: "", q: "", minDevices: 0, sort: "devices", gw: "" }).days.length === 3);
    check("antene (statistici): perioada se taie la 120 de zile, de la sfârșit, în ordine crescătoare", dayRange(d0 - 400 * GDAY, d0).length === 120 && dayRange(d0 - 400 * GDAY, d0)[119] === d0 && dayRange(d0, d0)[0] === d0 && dayRange(d0 + GDAY, d0).length === 2);
    // filtrul antenelor: rază (interval de la – până la) + perioadă (azi / 7 zile / mai vechi de 7 zile / toate)
    const nowF = new Date(2026, 10, 25, 15, 30).getTime(), midF = new Date(2026, 10, 25).getTime(), DAYF = 86_400_000;
    const f = (o: Partial<GwFilter>): GwFilter => ({ ...DEFAULT_FILTER, ...o });
    const qAll = gwQuery(f({}), nowF), q3 = gwQuery(f({ rad: "3" }), nowF), qRange = gwQuery(f({ rad: "range", kmMin: 5, kmMax: 2 }), nowF), qOpen = gwQuery(f({ rad: "range", kmMin: 4, kmMax: null }), nowF);
    check("filtru antene: fără filtru trece tot (și contoarele fără distanță); «până la 3 km» taie ce e mai departe și ce nu are distanță", passes(qAll, null, 1) && passes(qAll, 50, 1) && passes(q3, 3, 1) && !passes(q3, 3.01, 1) && !passes(q3, null, 1) && passes(q3, 0, 1));
    check("filtru antene: intervalul cu două puncte (capetele puse invers se întorc), fără limită de sus, iar raza nu atinge perioada", qRange.kmin === 2 && qRange.kmax === 5 && passes(qRange, 2, 1) && passes(qRange, 5, 1) && !passes(qRange, 1.9, 1) && !passes(qRange, 5.1, 1) && passes(qOpen, 400, 1) && !passes(qOpen, 3.9, 1) && radiusOf(f({ rad: "1" })).kmax === 1 && inRadius(q3, 2) && !inRadius(q3, 9));
    const bAzi = periodBounds("today", nowF), b7 = periodBounds("7d", nowF), bOld = periodBounds("older", nowF);
    check("filtru antene: perioada — azi = de la miezul nopții, 7 zile = azi + 6 zile înapoi, mai vechi = tot ce e înainte; «toate» nu restrânge", bAzi.pf === midF && bAzi.pt === null && b7.pf === midF - 6 * DAYF && bOld.pf === null && bOld.pt === midF - 6 * DAYF - 1 && periodBounds("all", nowF).pf === null);
    const qT = gwQuery(f({ per: "today" }), nowF), qO = gwQuery(f({ per: "older" }), nowF);
    check("filtru antene: «azi» ia doar ce a fost auzit azi; «mai vechi de 7 zile» doar ce n-a mai fost auzit de peste 7 zile, fără să se suprapună cu «7 zile»", passes(qT, null, nowF) && !passes(qT, null, midF - 1) && passes(qO, null, midF - 7 * DAYF) && !passes(qO, null, midF - 6 * DAYF) && !passes(gwQuery(f({ per: "7d" }), nowF), null, midF - 7 * DAYF));
    const bY = periodBounds("yesterday", nowF), b1 = periodBounds("1h", nowF), b24 = periodBounds("24h", nowF), b3 = periodBounds("3d", nowF), b30 = periodBounds("30d", nowF), bO30 = periodBounds("older30", nowF);
    check("filtru antene: perioade noi — ieri (ziua întreagă de ieri), ultima oră, 24 de ore, 3 / 30 de zile, mai vechi de 30 de zile", bY.pf === midF - DAYF && bY.pt === midF - 1 && b1.pf === nowF - 3_600_000 && b1.pt === null && b24.pf === nowF - DAYF && b3.pf === midF - 2 * DAYF && b30.pf === midF - 29 * DAYF && bO30.pt === midF - 29 * DAYF - 1 && bO30.pf === null && periodBounds("14d", nowF).pf === midF - 13 * DAYF);
    const qR = gwQuery(f({ per: "range", pFrom: "2026-11-10", pTo: "2026-11-12" }), nowF), qRv = gwQuery(f({ per: "range", pFrom: "2026-11-12", pTo: "2026-11-10" }), nowF), qRo = gwQuery(f({ per: "range", pFrom: "2026-11-10", pTo: "" }), nowF), qRx = gwQuery(f({ per: "range", pFrom: "10.11.2026", pTo: "2026-02-31" }), nowF);
    const d10 = new Date(2026, 10, 10).getTime(), d13 = new Date(2026, 10, 13).getTime();
    check("filtru antene: interval de date ales — de la începutul primei zile până la sfârșitul ultimei (inclusiv), capetele inversate se întorc, un capăt lipsă = fără limită, date greșite = fără limită", qR.pf === d10 && qR.pt === d13 - 1 && passes(qR, null, d13 - 1) && !passes(qR, null, d13) && !passes(qR, null, d10 - 1) && qRv.pf === d10 && qRv.pt === new Date(2026, 10, 13).getTime() - 1 && qRo.pf === d10 && qRo.pt === null && qRx.pf === null && qRx.pt === null && !queryActive(qRx));
    check("filtru antene: textul perioadei pentru titluri", periodText(f({ per: "yesterday" })) === "ieri" && periodText(f({ per: "all" })) === "" && periodText(f({ per: "range", pFrom: "2026-11-10", pTo: "2026-11-12" })) === "10.11.2026 – 12.11.2026" && describe(f({ rad: "3", per: "7d" })) === "până la 3 km · ultimele 7 zile");
    check("filtru antene: în URL doar ce e restrâns (cererile fără filtru rămân neschimbate); citirea ignoră valori greșite și întoarce capetele", queryString(qAll) === "" && parseQuery(new URLSearchParams("kmin=abc&kmax=-4")).kmax === 0 && parseQuery(new URLSearchParams("kmin=7&kmax=2")).kmin === 2 && parseQuery(new URLSearchParams(queryString(q3))).kmax === 3 && parseQuery(new URLSearchParams("pf=0&pt=x")).pf === null);
    const gsrc = readFileSync("lib/services/gateways.ts", "utf8"), hc = readFileSync("lib/http-cache.ts", "utf8");
    const gl2 = readFileSync("app/components/GatewayLayer.tsx", "utf8"), pg = readFileSync("app/(app)/page.tsx", "utf8");
    check("antene pe harta de contoare: instalatorul de antene (fără drept la Integrare) vede antenele din lista lui (/api/antennas), fără datele din integrare (contoare auzite, linii, filtru); administratorul / Integrare au tot", pg.includes('can(user, "antennas") ? "basic"') && pg.includes('user.admin || can(user, "integration") ? "full"') && gl2.includes('"/api/antennas"') && gl2.includes("basic || !sel") && gl2.includes("!basic && createPortal") && gl2.includes("basic || !gf.on"));
    {
      // mesaje pe zi din contorul de cadre fCnt
      const T0 = Date.UTC(2026, 10, 20, 10, 0), now0 = T0 + 1000, d20 = dayIdx(T0);
      const s0 = msgStep(null, 1000, T0, now0)!;
      check("mesaje pe zi: prima observare doar fixează punctul de pornire (nimic numărat, istoria nu se poate reconstitui)", s0.f === 1000 && s0.c.length === KEEP_DAYS && s0.c.every((x) => x === 0) && s0.b === d20 && msgStep(null, -1, T0, now0) === null && msgStep(null, NaN, T0, now0) === null);
      const s1 = msgStep(s0, 1012, T0 + 3 * 3_600_000, T0 + 3 * 3_600_000)!;
      check("mesaje pe zi: diferența de fCnt se adaugă la ziua mesajelor; fără fCnt nou sau moment mai vechi starea rămâne EXACT aceeași", countOn(s1, d20) === 12 && s1.f === 1012 && msgStep(s1, 1012, T0 + 9e6, T0 + 9e6) === s1 && msgStep(s1, 1020, T0, T0 + 9e6) === s1);
      // peste miezul nopții: 24 de mesaje între 20.11 22:00 și 21.11 04:00 → 18 în prima zi (2 h din 6 h ⇒ 8) — împărțit proporțional cu timpul din fiecare zi
      const a = msgStep(null, 0, Date.UTC(2026, 10, 20, 22, 0), Date.UTC(2026, 10, 20, 22, 0))!, b = msgStep(a, 24, Date.UTC(2026, 10, 21, 4, 0), Date.UTC(2026, 10, 21, 4, 0))!;
      check("mesaje pe zi: intervalul care trece peste miezul nopții se împarte pe zile proporțional cu timpul (2 h / 4 h ⇒ 8 + 16), suma rămâne 24", countOn(b, d20) === 8 && countOn(b, d20 + 1) === 16);
      const r = msgStep(msgStep(null, 5000, T0, T0)!, 7, T0 + 3_600_000, T0 + 3_600_000)!;
      check("mesaje pe zi: fCnt mai mic = contorul a repornit sesiunea: se numără mesajele de după repornire (fCnt + 1), nu o diferență negativă", countOn(r, d20) === 8);
      const old = msgStep(null, 0, T0, T0)!, far = msgStep(old, 30, T0 + 20 * MDAY, T0 + 20 * MDAY)!;
      check("mesaje pe zi: fereastra e de 14 zile; după 20 de zile fără observări vechile zile ies din fereastră, iar mesajele din interval se păstrează pe zilele ei", far.c.length === KEEP_DAYS && far.d0 === dayIdx(T0 + 20 * MDAY) - KEEP_DAYS + 1 && far.c.reduce((x, y) => x + y, 0) <= 30 && far.c.reduce((x, y) => x + y, 0) > 0);
      const fut = msgStep(msgStep(null, 0, T0, T0)!, 10, T0 + 400 * MDAY, T0 + 3_600_000)!;
      check("mesaje pe zi: un ceas greșit (momentul în viitor) nu mută mesajele în zile viitoare", countOn(fut, dayIdx(T0 + 3_600_000)) === 10);
      const bin = packCounts([0, 1, 65535, 70000, -3]);
      check("mesaje pe zi: stocare în Uint16 (limitat la 65535) și citire înapoi; zi în afara ferestrei = necunoscut; parseDay (azi / ieri / dată / invalid)", JSON.stringify(unpackCounts(bin)) === "[0,1,65535,65535,0]" && countOn(s1, d20 + 99) === null && countOn(undefined, d20) === null && parseDay("yesterday", T0) === d20 - 1 && parseDay("2026-11-20", T0) === d20 && parseDay("2026-02-31", T0) === null && parseDay("x", T0) === null && parseDay("today", T0) === d20);
      // perioade: 3 zile / o săptămână / o lună / interval ales; media pe zi
      const dayLabelOf = (d: number) => new Date(d * MDAY).toISOString().slice(0, 10);
      const nowP = Date.UTC(2026, 10, 27, 12, 0), tP = dayIdx(nowP);
      const p3 = parsePeriod("3d", nowP)!, p30 = parsePeriod("30d", nowP)!, pr = parsePeriod("r:2026-11-20:2026-11-25", nowP)!, pv = parsePeriod("r:2026-11-25:2026-11-20", nowP)!;
      check("mesaje pe perioade: «3d» / «7d» / «30d» = ultimele N zile ÎNTREGI (fără azi); intervalul ales își întoarce capetele inversate și se limitează la 31 de zile; valori invalide = null", p3.from === tP - 3 && p3.to === tP - 1 && p3.multi && p30.from === tP - 30 && p30.to === tP - 1 && pr.from === dayIdx(Date.UTC(2026, 10, 20)) && pr.to === dayIdx(Date.UTC(2026, 10, 25)) && pv.from === pr.from && pv.to === pr.to && parsePeriod("r:2026-01-01:2026-11-25", nowP)!.to - parsePeriod("r:2026-01-01:2026-11-25", nowP)!.from + 1 === KEEP_DAYS && parsePeriod("99d", nowP) === null && parsePeriod("0d", nowP) === null && parsePeriod("r:x:y", nowP) === null && parsePeriod("yesterday", nowP)!.from === tP - 1 && !parsePeriod("today", nowP)!.multi);
      const sP: MsgState = { f: 100, t: nowP, d0: tP - KEEP_DAYS + 1, c: Array.from({ length: KEEP_DAYS }, (_, i) => (i === KEEP_DAYS - 2 ? 10 : i === KEEP_DAYS - 3 ? 20 : i === KEEP_DAYS - 4 ? 30 : i === KEEP_DAYS - 5 ? 99 : 0)), b: tP - 4 };
      const a3 = sumOver(sP, p3, tP)!;
      check("mesaje pe perioade: media pe zi se calculează doar pe zilele numărate; ziua primei observări (parțială) se omite într-o perioadă de mai multe zile", a3.days === 3 && a3.total === 60 && sumOver(sP, parsePeriod("7d", nowP)!, tP)!.days === 3 && sumOver(sP, parsePeriod("7d", nowP)!, tP)!.total === 60 && sumOver(sP, parsePeriod(dayLabelOf(tP - 4), nowP)!, tP)!.total === 99 && sumOver(sP, parsePeriod("r:2026-01-01:2026-01-03", nowP)!, tP) === null && sumOver(null, p3, tP) === null);
      const stale: MsgState = { f: 5, t: nowP - 9 * MDAY, d0: tP - 9 - KEEP_DAYS + 1, c: new Array<number>(KEEP_DAYS).fill(2), b: tP - 40 };
      check("mesaje pe zi: zilele de după ultima actualizare a documentului (contorul n-a mai trimis nimic) sunt 0, nu «nemăsurat»; ziua din viitor sau dinaintea ferestrei = null", countOn(stale, tP, tP) === 0 && countOn(stale, tP - 5, tP) === 0 && countOn(stale, tP - 9, tP) === 2 && countOn(stale, tP + 1, tP) === null && countOn(stale, tP - 9 - KEEP_DAYS, tP) === null);
      const rt = readFileSync("app/api/meters/messages/route.ts", "utf8"), sv = readFileSync("lib/services/meter-msgs.ts", "utf8"), sy = readFileSync("scripts/sync-meters.ts", "utf8");
      check("mesaje pe zi: ruta cere dreptul la Contoare, limitează id-urile și rezultatul, iar rezultatele respectă zona (cheie cu zona); sincronizarea numără după fiecare rulare, fără să o strice la eroare", rt.includes('apiGuard("meters")') && rt.includes("slice(0, 150)") && rt.includes("scopeKey(user)") && sv.includes("zoneCheck") && sv.includes("allowsMeter") && sy.includes("appendMsgCounts(client.db(), log).catch"));
    }
    check("antene (viteză): perechile stau într-un index în memorie citit incremental, în fundal; filtrele, detaliul și statisticile nu mai citesc perechile din baza de date", gsrc.includes("async function pairIndex") && gsrc.includes("last: { $gte: prev.wm }") && gsrc.includes("px.byG.get(id)") && !gsrc.includes("find({ g: id }") && !gsrc.includes("$group: { _id: \"$g\"") && gsrc.includes("return cur ?? g0.__gwPxBusy"));
    check("antene (viteză): răspunsurile antenelor au ETag / 304, sunt reținute pe server și reîmprospătate în fundal; ambele rute le folosesc", hc.includes("if-none-match") && hc.includes("status: 304") && hc.includes("must-revalidate") && readFileSync("app/api/integration/gateways/route.ts", "utf8").includes("cachedJson(") && readFileSync("app/api/antennas/overview/route.ts", "utf8").includes("cachedJson("));
    check("filtru antene: grupele de distanță (sub 0,5 · … · peste 20 km) cad la limita corectă", bandOf(0) === 0 && bandOf(0.49) === 0 && bandOf(0.5) === 1 && bandOf(2.99) === 3 && bandOf(20) === KM_EDGES.length && bandOf(500) === KM_EDGES.length);
    const stR = buildStats(sum, docs, new Map([["A", 2]]), { from: d0, to: d0 + GDAY, state: "", q: "", minDevices: 0, sort: "devices", gw: "", kmin: 0, kmax: 3 });
    check("filtru antene (statistici): cu raza restrânsă rămân doar antenele cu contoare în rază, iar «mesaje / contor» nu se mai calculează", stR.radius && stR.rows.map((r) => r.id).join() === "A" && stR.rows[0].devicesIn === 2 && stR.rows[0].perDevice === null && stR.totals.avgPerDevice === null && !st.radius);
  }
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
  check("citire: volum + temperatura măsurată de contor (la cel mult 48 h de citire, înainte sau după), cu virgulă zecimală", r1?.v === 1234.5 && r1.tp === 23.5 && r1.t === 1_000_000_000);
  check("citire: temperatură de acum 30 h se atașează, de peste 48 h ⇒ null; volum negativ / lipsă ⇒ fără citire", readingOf({ tel: tel(1_000_000_000, "5", 1_000_000_000 - 30 * H, "21") })?.tp === 21 && readingOf({ tel: tel(1_000_000_000, "5", 1_000_000_000 - 50 * H) })?.tp === null && readingOf({ tel: tel(1_000_000_000, "-3", null) }) === null && readingOf({ tel: {} }) === null);
  { const T = 1_800_000_000_000;
    const vv = (tsT: number | null, tsV = "10.000") => readingOf({ tel: { Volume_m3_Total: { t: T, v: "10.000" }, ...(tsT === null ? {} : { Volume_m3_Total_ts: { t: tsT, v: tsV } }) } })?.t;
    check("citire: ora = momentul CITIRII (Volume_m3_Total_ts) când are aceeași valoare și e plauzibilă; altfel momentul sosirii", vv(T - 45 * 60_000) === T - 45 * 60_000 && vv(T - 45 * 60_000, "10,000") === T - 45 * 60_000 && vv(T - 45 * 60_000, "9.000") === T && vv(T + 3 * H) === T && vv(T - 8 * 24 * H) === T && vv(null) === T);
  }
  // pozele contoarelor
  {
    const id = "de219e81-9c2d-11ed-9f20-9d903c1d67f8";
    const okGet = (p: string) => { try { assertReadOnly("GET", p); return true; } catch { return false; } };
    check("poze: se poate citi DOAR atributul image al unui dispozitiv (nu alte atribute, nu scrieri)", okGet(`/api/plugins/telemetry/DEVICE/${id}/values/attributes?keys=image`) && !okGet(`/api/plugins/telemetry/DEVICE/${id}/values/attributes?keys=image,devEUI`) && !okGet(`/api/plugins/telemetry/DEVICE/${id}/values/attributes?keys=APPKEY`) && !okGet(`/api/plugins/telemetry/DEVICE/${id}/values/attributes`) && !(() => { try { assertReadOnly("POST", `/api/plugins/telemetry/DEVICE/${id}/values/attributes?keys=image`); return true; } catch { return false; } })());
    check("poze: id-ul din calea fișierului e strict un UUID (fără ../ sau separatori)", validId(id) && !validId("../etc/passwd") && !validId(id + "/x") && !validId("") && !validId(id.toUpperCase()) && photoPath(id, false, "/p").split("\\").join("/") === `/p/de/${id}.jpg` && photoPath(id, true, "/p").split("\\").join("/") === `/p/de/${id}_t.jpg` && (() => { try { photoPath("../x"); return false; } catch { return true; } })());
    const sharpMod = (await import("sharp")).default;
    const raw = await sharpMod({ create: { width: 3000, height: 2000, channels: 3, background: { r: 200, g: 120, b: 40 } } }).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toBuffer();
    const uri = "data:image/jpeg;base64," + raw.toString("base64");
    const dec = decodeImage(uri);
    check("poze: decodare din data URI (și base64 simplu); text invalid, prea scurt sau care nu e imagine ⇒ null", dec !== null && dec.equals(raw) && decodeImage(raw.toString("base64"))?.equals(raw) === true && decodeImage("data:image/jpeg;base64,AAAA") === null && decodeImage(null) === null && decodeImage(42) === null && decodeImage("data:image/jpeg;base64," + Buffer.alloc(5000, 7).toString("base64")) === null && decodeImage("x".repeat(3000)) === null);
    const pr = await processImage(raw, 1000);
    const m = await sharpMod(pr.full).metadata(), tm = await sharpMod(pr.thumb).metadata();
    check("poze: micșorată la cel mult 1000 px pe latura lungă, orientarea din EXIF aplicată (portret), fără metadate (fără locație), miniatură 240 px, mult mai mică decât originalul", pr.w === m.width && pr.h === m.height && Math.max(m.width ?? 0, m.height ?? 0) === 1000 && (m.height ?? 0) > (m.width ?? 0) && !m.exif && !m.orientation && Math.max(tm.width ?? 0, tm.height ?? 0) === 240 && pr.full.length < raw.length && pr.thumb.length < pr.full.length);
    const NOW = 1_800_000_000_000, D = 86_400_000;
    const st = new Map([["ok", { st: "ok" as const, at: new Date(NOW - 99 * D), mx: 1600 }], ["ok-small", { st: "ok" as const, at: new Date(NOW - 5 * D), mx: 1000 }], ["ok-old", { st: "ok" as const, at: new Date(NOW - 5 * D) }], ["none-new", { st: "none" as const, at: new Date(NOW - 2 * D) }], ["none-old", { st: "none" as const, at: new Date(NOW - 8 * D) }], ["err-new", { st: "err" as const, at: new Date(NOW - 60_000), n: 1 }], ["err-old", { st: "err" as const, at: new Date(NOW - 3_600_000), n: 2 }], ["err-max", { st: "err" as const, at: new Date(NOW - 3_600_000), n: MAX_TRIES }]]);
    const all = ["new", "ok", "ok-small", "ok-old", "none-new", "none-old", "err-new", "err-old", "err-max"];
    check("poze: se reiau doar contoarele fără stare, cele păstrate la o rezoluție mai mică decât cea cerută, cele fără poză de peste 7 zile și cele cu eroare mai veche de 10 min (sub 5 încercări); --refresh le ia pe toate", pendingIds(all, st, NOW, false, 1600).join() === "new,ok-small,ok-old,none-old,err-old" && pendingIds(all, st, NOW, false, 1000).join() === "new,ok-old,none-old,err-old" && pendingIds(all, st, NOW, true, 1600).length === all.length);
  }
  // ecranul instalatorului (dashboardul ChisinauGaz_Instalator_App din SCADA, datele se salvează doar la noi)
  {
    check("instalator: codul QR → numele dispozitivului, ca în SCADA (S3010 / S3020 după „:30”, LoRaWAN cu „S2154.…” oricum ar fi scris)", parseQr(":3010.60027989.2610:") === "S3010_60027989_2610" && parseQr(":3020.50000007.2510:") === "S3020_50000007_2510" && parseQr("LW:D0:0018B250554C5331:001A79881601162C:029E0088:S2154.00071212.2022:C1750") === "S2154_00071212_2022" && parseQr("2514.00071212.2022!N0000005065250!LW:D0:0018B250554C5331:001A79881601162C:029E0088:S2154.00071212.2022:C1750") === "S2154_00071212_2022" && parseQr("  :3010.60027989.2610:  ") === "S3010_60027989_2610" && parseQr("2514.00071212.2022!N0000005065250") === "S2514_00071212_2022");
    check("instalator: cod QR care nu conține un nume valid ⇒ null (mesajul „Device not found in QR Code”)", parseQr("") === null && parseQr("hello") === null && parseQr(":3010.6002.2610:") === null && parseQr("https://example.com/x") === null && parseQr(null as unknown as string) === null);
    const T0 = 1_800_000_000_000, D0 = 86_400_000;
    check("instalator: activitatea ca în tabelul din SCADA — verde sub 1 zi, galben 1–7 zile, roșu peste 7 zile, „Null” fără dată", activity(T0 - 3_600_000, T0).text === "<1 day" && activity(T0 - 3_600_000, T0).dot === "rgb(39, 134, 34)" && activity(T0 - 2 * D0, T0).text === "1<7 days" && activity(T0 - 2 * D0, T0).color === "rgb(224, 202, 29)" && activity(T0 - 2 * D0, T0).dot === "rgb(255, 255, 0)" && activity(T0 - 8 * D0, T0).text === ">7 days" && activity(T0 - 8 * D0, T0).dot === "rgb(255, 0, 0)" && activity(0, T0).text === "Null" && activity(null, T0).text === "Null" && activity(T0 - D0, T0).text === "1<7 days" && activity(T0 - D0, T0).dot === "rgb(39, 134, 34)");
    check("instalator: mesajul „Device not found in DB” cu numele și numărul de contoare", qrNotInDb("S2154_1", 74497) === ['Device not found in DB:"S2154_1"', 'Устройство не найдено в базе данных:"S2154_1"', "Total Meters:74497"].join("\n"));
    const ok = cleanPatch({ ContorNr: " 4624641 ", Instalation_Litres: "12,5", ModuleWriteInitial: true, Aragaz: true, Cazan: "true", Incalzire: false, locationModule: " Orhei ", Comments: "ok", evil: "x", image: "AAAA", _id: "z" });
    check("instalator: se păstrează doar câmpurile cunoscute, curățate (număr cu virgulă, text fără spații la capete); image / _id / câmpuri străine sunt ignorate", "patch" in ok && JSON.stringify(ok.patch) === JSON.stringify({ ContorNr: "4624641", Instalation_Litres: 12.5, Aragaz: true, Cazan: true, Incalzire: false, ModuleWriteInitial: true, locationModule: "Orhei", Comments: "ok" }));
    const bad = [{ Instalation_Litres: "abc" }, { Instalation_Litres: -1 }, { latitude: 91 }, { longitude: "x" }, { ContorNr: "x".repeat(41) }, { Comments: "x".repeat(2001) }, {}, null, "text", { image: "AAAA" }];
    check("instalator: valori invalide sau cerere goală ⇒ eroare, nimic nu se salvează", bad.every((b) => "error" in cleanPatch(b)) && "patch" in cleanPatch({ latitude: 47.01, longitude: "28,86" }) && "patch" in cleanPatch({ Instalation_Litres: "" }) && (cleanPatch({ Instalation_Litres: "" }) as { patch: { Instalation_Litres: number | null } }).patch.Instalation_Litres === null);
  }
  // raportul de citiri către facturare: ultima citire până la momentul ales, trei câmpuri
  {
    const dec1 = localToUtc(2026, 12, 1, 7, 0), jul1 = localToUtc(2026, 7, 1, 7, 0);
    check("raport: data și ora aleasă în ora Moldovei → UTC (iarna UTC+2, vara UTC+3) și numele fișierului", dec1 === Date.UTC(2026, 11, 1, 5) && jul1 === Date.UTC(2026, 6, 1, 4) && atName(dec1) === "2026-12-01_0700" && localToUtc(2026, 10, 25, 3, 30) > 0);
    check("raport: formate — ora Moldovei ZZ/LL/AAAA HH:MM:SS, și AAAA-LL-ZZ", fmtDmy(dec1) === "01/12/2026 07:00:00" && fmtLocal(dec1) === "2026-12-01 07:00:00" && fmtUtc(dec1) === "2026-12-01 05:00:00" && fmtDmy(Date.UTC(2026, 6, 1, 0, 0, 0)) === "01/07/2026 03:00:00");
    check("raport: momentul raportului lunar = ziua 1 a lunii curente la ora dată (peste schimbarea de oră și de an)", monthStartAt(Date.UTC(2026, 10, 24, 5), 7) === Date.UTC(2026, 10, 1, 5) && monthStartAt(Date.UTC(2026, 11, 5, 12), 7) === dec1 && monthStartAt(Date.UTC(2026, 6, 20, 12), 7) === jul1 && monthStartAt(Date.UTC(2027, 0, 1, 4), 7) === Date.UTC(2027, 0, 1, 5));
    const A = Date.UTC(2026, 9, 30, 10), B = Date.UTC(2026, 9, 30, 20), C = Date.UTC(2026, 9, 30, 22, 30), D = Date.UTC(2026, 9, 31, 5);
    const mp = mergePoints([[B, 6], [A, 5], [D, -1], [Date.UTC(2026, 10, 5), 9]], [[A + 300, 5], [C, 7], [Date.UTC(2026, 8, 1), 1], [D + 1000, Number.NaN]], 0, Date.UTC(2026, 10, 1));
    check("raport: citirile din cele două surse se combină, fără dubluri (aceeași secundă), fără valori negative / invalide, în ordine", JSON.stringify(mp) === JSON.stringify([[Date.UTC(2026, 8, 1), 1], [A, 5], [B, 6], [C, 7]]), JSON.stringify(mp));
    const pts: [number, number][] = [[B, 6], [A, 5], [D, 8], [C, 7]];
    check("raport: cea mai recentă citire până la momentul ales (inclusiv), în orice ordine; nimic înainte de prima citire", JSON.stringify(latestAt(pts, C)) === JSON.stringify([C, 7]) && JSON.stringify(latestAt(pts, C - 1)) === JSON.stringify([B, 6]) && JSON.stringify(latestAt(pts, D + 1e9)) === JSON.stringify([D, 8]) && latestAt(pts, A - 1) === null && latestAt([], 5) === null && latestAt([[A, -1], [B, Number.NaN]], D) === null);
    check("raport: seria radiomodulului din facturare (NUM_RADIO), altfel din numele dispozitivului; linia CSV: serie ; indicația cu 3 zecimale ; data reală a citirii", radioOf({ _id: "x", bill: { NUM_RADIO: " 00039410 " }, s: { n: "S2154_00070948_2022" } }) === "00039410" && radioOf({ _id: "x", s: { n: "S2154_00070948_2022" } }) === "00070948" && radioOf({ _id: "x", s: { n: "ceva" } }) === "" && readingLine("00039410", dec1, 12.3456) === "00039410;12.346;01/12/2026 07:00:00\n" && csvCell('x"y') === '"x""y"' && csvCell("simplu") === "simplu");
    // generatorul, cu o bază de date falsă: o linie pe contor, ultima citire până la momentul ales
    const T = (d: number, h: number) => Date.UTC(2026, 10, d, h);
    const meters = [
      { _id: "m1", s: { n: "S2154_00000001_2022", v: 120, t: T(30, 10) }, bill: { NUM_RADIO: "00000001" } },
      { _id: "m2", s: { n: "S2154_00000002_2022", v: 55, t: T(20, 8) }, bill: { NUM_RADIO: "00000002" } },
      { _id: "m3", s: { n: "S2154_00000003_2022", v: 9, t: T(30, 9) }, bill: { NUM_RADIO: "00000003" } },
      { _id: "m4", s: { n: "S2154_00000004_2022", v: 1, t: T(10, 1) }, bill: {} },
      { _id: "m5", s: { n: "ceva", v: 1, t: T(10, 1) }, bill: {} },
    ];
    const readings = [{ _id: "m1", t: [T(29, 6), T(30, 5), T(30, 9)], v: [100, 110, 115] }, { _id: "m2", t: [T(15, 6)], v: [50] }];
    const fake = { collection: (n: string) => ({
      find: () => (n === "m" ? { sort: () => ({ batchSize: () => ({ async *[Symbol.asyncIterator]() { for (const d of meters) yield d; } }) }) } : { toArray: async () => (n === "r" ? readings : []) }),
    }) } as unknown as Db;
    const at = T(30, 6); // 30.11 la 06:00 UTC
    let out = "";
    for await (const b of reportBatches(fake, { at, onlyBilled: false }, { meters: "m", readings: "r", history: "h" })) out += b.text;
    const lines = out.trim().split("\n");
    check("raport: o linie pe contor, cu ultima citire până la momentul ales (nu cele ulterioare), seria radiomodulului și data reală; contor fără citire sau fără serie nu apare", lines.length === 3 && lines[0] === `00000001;110.000;${fmtDmy(T(30, 5))}` && lines[1] === `00000002;55.000;${fmtDmy(T(20, 8))}` && lines[2] === `00000004;1.000;${fmtDmy(T(10, 1))}`, out);
  }
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

// ───── module LoRaWAN: înregistrare / activare ca în SCADA (cu servere ChirpStack false)
const sectionLw = (async () => {
  check("lorawan: aplicația și profilul la serverul principal după tip și activare; S3010 (partener) ⇒ aplicația 12; fără tip cunoscut ⇒ null", primaryTarget("Comrat_Gas_Meter_DP", "S2154_00072088_2022", "OTAA")?.applicationID === "29" && primaryTarget("Comrat_Gas_Meter_DP", "S2154_1_2022", "OTAA")?.deviceProfileID.startsWith("9af1b76c") === true && primaryTarget("Jooby_Gas_Meter_DP", "S2154_1_2022", "OTAA")?.applicationID === "27" && primaryTarget("Jooby_Gas_Meter_DP", "S2154_1_2022", "ABP")?.applicationID === "23" && primaryTarget("Jooby_Gas_Meter_DP", "S2154_1_2022", "ABP")?.deviceProfileID.startsWith("236b9ff1") === true && primaryTarget("Chisinau_Gas_Meter_DP", "S2154_1_2022", "OTAA")?.applicationID === "44" && primaryTarget("Cahul_Gas_Meter_DP", "S3010_00000001_2026", "OTAA")?.applicationID === "12" && primaryTarget("Cahul_Gas_Meter_DP", "S3010_00000001_2026", "OTAA")?.deviceProfileID.startsWith("8ef5cf24") === true && primaryTarget("ACC_AXIOMA_W1_DP", "SN07539967", "OTAA")?.applicationID === "3" && primaryTarget("Defectate_Jooby_Gaz", "S2154_1_2022", "OTAA") === null);
  check("lorawan: serverul de rezervă (alte aplicații, profil ABP) și serverul v4 (UUID-uri)", backupTarget("Comrat_Gas_Meter_DP")?.applicationID === "7" && backupTarget("Cahul_Gas_Meter_DP")?.applicationID === "14" && backupTarget("Chisinau_Gas_Meter_DP")?.applicationID === "23" && backupTarget("ACC_AXIOMA_W1_DP") === null && v4Target("Ialoveni_Gas_Meter_DP")?.applicationID === "ad02b302-c714-4e79-9830-8c4c75677308" && v4Target("Chisinau_Gas_Meter_DP") === null && GAS_TYPES.length === 13);
  check("lorawan: numele din ChirpStack = fără prima «S» (la ACC Axioma fără «SN»)", chirpName("S2154_00071212_2022", "Jooby_Gas_Meter_DP") === "2154_00071212_2022" && chirpName("SN07539967", "ACC_AXIOMA_W1_DP") === "07539967" && expectedDevAddr("001a79881601162c") === "0001162c");
  const okMod = cleanModule({ name: "S2154_00071212_2022", type: "Comrat_Gas_Meter_DP", activation: "OTAA", devEUI: "001A79881601162C", appKey: "A".repeat(32) });
  const okAbp = cleanModule({ name: "S2154_00071212_2022", type: "Comrat_Gas_Meter_DP", activation: "ABP", devEUI: "001a79881601162c", devAddr: "0001162C", appSKey: "b".repeat(32), nwkSKey: "c".repeat(32), devAaddr: "A0001162C" });
  check("lorawan: validarea înregistrării (devEUI 16 hex, chei 32 hex, devADDR 8 hex; câmpurile cerute depind de activare; litere mici)", "mod" in okMod && okMod.mod.devEUI === "001a79881601162c" && okMod.mod.appKey === "a".repeat(32) && "mod" in okAbp && okAbp.mod.devAddr === "0001162c" && okAbp.mod.devAaddr === "A0001162C" && ["error" in cleanModule({ name: "S2154_1_2022", type: "Comrat_Gas_Meter_DP", activation: "OTAA", devEUI: "123" }), "error" in cleanModule({ name: "S2154_00071212_2022", type: "Comrat_Gas_Meter_DP", activation: "OTAA", devEUI: "001a79881601162c" }), "error" in cleanModule({ name: "S2154_00071212_2022", type: "Altceva", activation: "OTAA", devEUI: "001a79881601162c", appKey: "a".repeat(32) }), "error" in cleanModule({ name: "S2154_00071212_2022", type: "Comrat_Gas_Meter_DP", activation: "ABP", devEUI: "001a79881601162c", devAddr: "0001162c" }), "error" in cleanModule(null)].every(Boolean));
  const blob = encryptJson({ appKey: "a".repeat(32) }, "un-secret-destul-de-lung-1234567");
  let bad1 = false, bad2 = false; try { decryptJson(blob, "alt-secret-destul-de-lung-1234567"); } catch { bad1 = true; } try { decryptJson(blob.slice(0, -3) + "AAA", "un-secret-destul-de-lung-1234567"); } catch { bad2 = true; }
  check("lorawan: cheile se păstrează criptat (AES-GCM): se recitesc cu secretul bun, nu cu altul, nu dacă au fost alterate; textul criptat nu conține cheia", decryptJson<{ appKey: string }>(blob, "un-secret-destul-de-lung-1234567").appKey === "a".repeat(32) && bad1 && bad2 && !blob.includes("a".repeat(32)) && encryptJson({ x: 1 }, "un-secret-destul-de-lung-1234567") !== encryptJson({ x: 1 }, "un-secret-destul-de-lung-1234567"));

  // ChirpStack fals (v3 / v4): ține dispozitivele, cheile, activările și cozile în memorie și își notează apelurile
  type Sim = { devices: Map<string, Record<string, unknown>>; keys: Map<string, unknown>; act: Map<string, string>; queue: Map<string, unknown[]>; calls: string[]; bodies: Record<string, unknown>; conflict: boolean; logins: number; failActivate?: boolean };
  const mkSim = (): Sim => ({ devices: new Map(), keys: new Map(), act: new Map(), queue: new Map(), calls: [], bodies: {}, conflict: false, logins: 0 });
  const mkFetch = (s: Sim, v: 3 | 4): FetchFn => (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url)), method = init?.method ?? "GET", p = u.pathname; const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const send = (st: number, b: unknown = {}) => new Response(JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json" } });
    if (p === "/api/internal/login") { s.logins++; return body.password === "parola" ? send(200, { jwt: "jwt-" + s.logins }) : send(401); }
    const auth = new Headers(init?.headers).get("Grpc-Metadata-Authorization");
    if (!auth) return send(401);
    s.calls.push(method + " " + p);
    const mm = /^\/api\/devices(?:\/([0-9a-f]{16}))?(?:\/(keys|activation|activate|queue))?$/.exec(p);
    if (!mm) return send(404);
    const eui = mm[1], sub = mm[2];
    if (!eui && method === "POST") { s.bodies.device = body; const d = body.device; const k = (d.devEUI ?? d.devEui) as string; if (s.conflict || s.devices.has(k)) return send(409, { message: "object already exists" }); s.devices.set(k, d); return send(200); }
    if (eui && !sub) { if (method === "GET") return s.devices.has(eui) ? send(200, { device: s.devices.get(eui) }) : send(404, { error: "object does not exist" }); if (method === "DELETE") { const had = s.devices.delete(eui) || s.conflict; s.conflict = false; return had ? send(200) : send(404); } }
    if (sub === "keys") { if (method === "GET") return s.keys.has(eui) ? send(200, { deviceKeys: s.keys.get(eui) }) : send(404); s.bodies.keys = body.deviceKeys; s.keys.set(eui, body.deviceKeys); return send(200); }
    if (sub === "activation") return s.act.has(eui) ? send(200, { deviceActivation: { devAddr: s.act.get(eui), devEUI: eui } }) : send(404);
    if (sub === "activate") { if (s.failActivate) return send(500); s.bodies.activation = body.deviceActivation; s.act.set(eui, body.deviceActivation.devAddr); return send(200); }
    if (sub === "queue") { const q = s.queue.get(eui) ?? []; if (method === "GET") return send(200, { totalCount: q.length, deviceQueueItems: q }); if (method === "DELETE") { s.queue.set(eui, []); return send(200); } s.bodies.queue = body.deviceQueueItem; q.push(body.deviceQueueItem); s.queue.set(eui, q); return send(200); }
    void v; return send(404);
  }) as FetchFn;
  const world = () => { const s3 = mkSim(), sb = mkSim(), s4 = mkSim(); const published: { url: string; topic: string; payload: unknown }[] = [], fwd: { url: string; body: unknown }[] = []; const logs: string[] = [];
    const ctx = (o: { dry?: boolean; allowDelete?: boolean } = {}): Ctx => ({ s: { primary: new ChirpStack("http://p", 3, { creds: { email: "api@x", password: "parola" } }, mkFetch(s3, 3)), backup: new ChirpStack("http://b", 3, { creds: { email: "api@x", password: "parola" } }, mkFetch(sb, 3)), v4: new ChirpStack("http://v4", 4, { token: "tok" }, mkFetch(s4, 4)), mqttV4: "mqtt://v4", nodered: ["https://nr1", "https://nr2"], noderedCreds: { email: "api@x", password: "parola" } }, dry: o.dry ?? false, allowDelete: o.allowDelete ?? false, log: (m) => logs.push(m), publish: async (url, topic, payload) => { published.push({ url, topic, payload }); }, forward: async (url, body) => { fwd.push({ url, body }); return true; } });
    return { s3, sb, s4, published, fwd, logs, ctx }; };
  const otaa: ModuleInput = { name: "S2154_00071212_2022", type: "Comrat_Gas_Meter_DP", activation: "OTAA", devEUI: "001a79881601162c", appKey: "a".repeat(32) };
  const abp: ModuleInput = { name: "S2154_00071212_2022", type: "Comrat_Gas_Meter_DP", activation: "ABP", devEUI: "001a79881601162c", devAddr: "0001162c", appSKey: "b".repeat(32), nwkSKey: "c".repeat(32), devAaddr: "A0001162C" };
  // a) modul OTAA nou: creat + cheie
  { const w = world(); const r = await registerPrimary(otaa, w.ctx());
    const d = w.s3.bodies.device as { device?: unknown } & Record<string, unknown>; const dev = (d.device ?? d) as Record<string, unknown>;
    check("lorawan înregistrare OTAA nou: dispozitivul se creează (aplicația 29, nume fără «S», skipFCntCheck) și cheia se scrie (nwkKey = APPKEY); login o singură dată", r.ok && r.result === "registered" && w.s3.calls.join(" | ") === "GET /api/devices/001a79881601162c | POST /api/devices | GET /api/devices/001a79881601162c/keys | POST /api/devices/001a79881601162c/keys" && dev.applicationID === "29" && dev.name === "2154_00071212_2022" && dev.description === "2154_00071212_2022" && dev.skipFCntCheck === true && String(dev.deviceProfileID).startsWith("9af1b76c") && (w.s3.bodies.keys as { nwkKey: string; appKey: string }).nwkKey === "a".repeat(32) && (w.s3.bodies.keys as { appKey: string }).appKey === "" && w.s3.logins === 1, w.s3.calls.join(" | ")); }
  // b) există deja, cu cheie: nicio scriere
  { const w = world(); w.s3.devices.set(otaa.devEUI, { applicationID: "29" }); w.s3.keys.set(otaa.devEUI, {}); const r = await registerPrimary(otaa, w.ctx());
    check("lorawan înregistrare: modul existent cu cheie ⇒ doar citiri, înregistrat (nicio scriere)", r.ok && w.s3.calls.every((c) => c.startsWith("GET")) && r.applicationID === "29"); }
  // c) există, fără cheie: doar cheia
  { const w = world(); w.s3.devices.set(otaa.devEUI, { applicationID: "29" }); const r = await registerPrimary(otaa, w.ctx());
    check("lorawan înregistrare: modul existent fără cheie ⇒ se scrie doar cheia", r.ok && w.s3.calls.filter((c) => c.startsWith("POST")).join() === "POST /api/devices/001a79881601162c/keys"); }
  // d) simulare: doar citiri
  { const w = world(); const r = await registerPrimary(otaa, w.ctx({ dry: true }));
    check("lorawan simulare: doar citiri, nimic scris, rezultat «dry» cu descrierea pașilor", r.ok && r.result === "dry" && w.s3.calls.every((c) => c.startsWith("GET")) && w.logs.some((l) => l.includes("(simulare)"))); }
  // e) conflict: cere confirmare; cu confirmare șterge și recreează
  { const w = world(); w.s3.conflict = true; const r1 = await registerPrimary(otaa, w.ctx());
    const del1 = w.s3.calls.some((c) => c.startsWith("DELETE"));
    const w2 = world(); w2.s3.conflict = true; const r2 = await registerPrimary(otaa, w2.ctx({ allowDelete: true }));
    check("lorawan conflict (409): fără confirmare ⇒ «conflict», nimic șters; cu confirmare ⇒ șterge dispozitivul vechi, îl recreează și scrie cheia", !r1.ok && r1.result === "conflict" && r1.needsConfirm === "delete" && !del1 && r2.ok && w2.s3.calls.filter((c) => c.startsWith("DELETE") || c.startsWith("POST")).join(" | ") === "POST /api/devices | DELETE /api/devices/001a79881601162c | POST /api/devices | POST /api/devices/001a79881601162c/keys", w2.s3.calls.join(" | ")); }
  // f) ABP: activare; ABP inexistent ⇒ eșec (ca în SCADA)
  { const w = world(); w.s3.devices.set(abp.devEUI, { applicationID: "29" }); const r = await registerPrimary(abp, w.ctx()); const a = w.s3.bodies.activation as Record<string, unknown>;
    const w2 = world(); const r2 = await registerPrimary(abp, w2.ctx());
    check("lorawan ABP: activare cu devAddr și chei (fCntUp 0, nwkSEncKey = sNwkSIntKey = fNwkSIntKey = NWKSKEY); dispozitiv ABP inexistent ⇒ eșec, nu se creează", r.ok && a.devAddr === "0001162c" && a.appSKey === "b".repeat(32) && a.nwkSEncKey === "c".repeat(32) && a.sNwkSIntKey === "c".repeat(32) && a.fNwkSIntKey === "c".repeat(32) && a.fCntUp === 0 && !r2.ok && !w2.s3.calls.some((c) => c.startsWith("POST"))); }
  // g) urgență (rezervă)
  { const w = world(); const r = await emergencyBackup(abp, 4, w.ctx()); const a = w.sb.bodies.activation as Record<string, unknown>; const dev = (w.sb.bodies.device as { device?: Record<string, unknown> }).device ?? (w.sb.bodies.device as Record<string, unknown>);
    check("lorawan urgență: dispozitiv nou pe rezervă (aplicația 7, profil ABP), activare cu devAADDR fără «A» (0001162C), «true-reactivated_4», contor 5; datele pleacă la Node-RED; serverul principal neatins", r.ok && r.emergency === "true-reactivated_4" && r.emcCount === 5 && dev.applicationID === "7" && String(dev.deviceProfileID).startsWith("066bc2af") && a.devAddr === "0001162C" && w.s3.calls.length === 0 && w.fwd.length === 2 && (w.fwd[0].body as { email: string; metadata: { ss_devEUI: string } }).metadata.ss_devEUI === abp.devEUI); }
  { const w = world(); w.sb.devices.set(abp.devEUI, {}); w.sb.act.set(abp.devEUI, "0001162c"); const r = await emergencyBackup(abp, 4, w.ctx());
    const w2 = world(); w2.sb.devices.set(abp.devEUI, {}); w2.sb.act.set(abp.devEUI, "00ffffff"); const r2 = await emergencyBackup(abp, 4, w2.ctx());
    const w3 = world(); const r3 = await emergencyBackup({ ...abp, devAaddr: "0001162C" }, 0, w3.ctx());
    const w4 = world(); w4.sb.failActivate = true; const r4 = await emergencyBackup(abp, 0, w4.ctx());
    check("lorawan urgență: adresa corectă (00 + ultimele 6 cifre din devEUI) ⇒ «true-activated-key-ok» fără scrieri; adresă greșită ⇒ reactivare; devAADDR invalid sau activare eșuată ⇒ «false-can_not_activate»", r.emergency === "true-activated-key-ok" && !w.sb.calls.some((c) => c.startsWith("POST")) && r2.emergency === "true-reactivated_4" && r2.emcCount === 5 && w2.sb.act.get(abp.devEUI) === "0001162C" && r3.emergency === "false-can_not_activate" && !r3.ok && r4.emergency === "false-can_not_activate" && !r4.ok); }
  // h) comandă către modul
  { const w = world(); w.s3.devices.set(otaa.devEUI, { applicationID: "29" }); w.s3.act.set(otaa.devEUI, "0001162c"); const r = await otaaDown(otaa, "to_abp", w.ctx());
    const w1 = world(); w1.s3.devices.set(otaa.devEUI, { applicationID: "29" }); w1.s3.act.set(otaa.devEUI, "0001162c"); w1.s3.queue.set(otaa.devEUI, [{}]); const r1 = await otaaDown(otaa, "to_abp", w1.ctx());
    const w3 = world(); w3.s3.devices.set(otaa.devEUI, { applicationID: "29" }); w3.s3.act.set(otaa.devEUI, "0001162c"); w3.s3.queue.set(otaa.devEUI, [{}, {}, {}]); const r3 = await otaaDown(otaa, "soft_restart", w3.ctx());
    const w4 = world(); const r4 = await otaaDown(otaa, "to_abp", w4.ctx());
    check("lorawan comandă: coadă goală ⇒ comanda «trecere pe ABP» (AwIJAVw=); coadă cu 1 element ⇒ nu se trimite (total_queue=1); coadă cu 3 ⇒ se golește și se trimite; modul neînregistrat ⇒ «not-activated»", r.ok && r.step === "mqtt_sent" && (w.s3.bodies.queue as { data: string; confirmed: boolean }).data === "AwIJAVw=" && (w.s3.bodies.queue as { confirmed: boolean }).confirmed === false && r1.step === "total_queue=1" && !w1.s3.calls.some((c) => c.startsWith("POST")) && r3.step === "mqtt_sent" && (w3.s3.bodies.queue as { data: string }).data === "GQBM" && w3.s3.calls.includes("DELETE /api/devices/001a79881601162c/queue") && !r4.ok && r4.step === "not-activated"); }
  // i) extraframe v4
  { const w = world(); w.s4.devices.set(abp.devEUI, {}); w.s4.act.set(abp.devEUI, "0001162c"); const r = await abpExtraFrame(abp, w.ctx()); const a = w.s4.bodies.activation as Record<string, unknown>;
    const w2 = world(); const r2 = await abpExtraFrame(abp, w2.ctx()); const d2 = (w2.s4.bodies.device as { device?: Record<string, unknown> }).device ?? {};
    check("lorawan ABP extraframe (v4): activează cu devAADDR fără «A», apoi trimite prin MQTT comanda de repornire (application/<app>/device/<devEUI>/command/down, GQBM); dispozitivul lipsă se creează (joinEui 0000…, skipFcntCheck); activarea lipsește ⇒ eșec", r.ok && a.devAddr === "0001162C" && w.published.length === 1 && w.published[0].topic === "application/ce9eabf7-5ac5-4c20-930b-0a3674efa315/device/001a79881601162c/command/down" && (w.published[0].payload as { data: string; confirmed: boolean }).data === "GQBM" && d2.joinEui === "0000000000000000" && d2.skipFcntCheck === true && d2.devEui === abp.devEUI && !r2.ok); }
  // j) autentificare: 401 ⇒ reautentificare o dată
  { const s = mkSim(); const cs = new ChirpStack("http://p", 3, { creds: { email: "api@x", password: "parola" } }, mkFetch(s, 3)); await cs.getDevice(otaa.devEUI); await cs.getDevice(otaa.devEUI);
    const bad = new ChirpStack("http://p", 3, { creds: { email: "api@x", password: "gresita" } }, mkFetch(mkSim(), 3)); const rb = await bad.getDevice(otaa.devEUI);
    const offline = new ChirpStack("http://p", 3, { creds: { email: "a", password: "b" } }, (async () => { throw new Error("ECONNREFUSED"); }) as FetchFn); const ro = await offline.getDevice(otaa.devEUI);
    check("lorawan client: login o singură dată pentru mai multe apeluri; parolă greșită ⇒ 401 fără excepție; server căzut ⇒ status 0 fără excepție", s.logins === 1 && rb.status === 401 && !rb.ok && ro.status === 0 && !ro.ok); }
})();

// ───── notificări despre probleme
const sectionNotify = (async () => {
  const NOW = Date.UTC(2026, 10, 24, 12);
  const mk = (br: string, ct: string, ageH: number | null, pf?: string) => ({ br, ct, t: ageH === null ? null : NOW - ageH * H1, pf: pf ?? null });
  const many = (n: number, br: string, ct: string, ageH: number) => Array.from({ length: n }, () => mk(br, ct, ageH));
  const fleet = [...many(100, "05 · Comrat", "Comrat", 2), ...many(40, "05 · Comrat", "Comrat", 60), ...many(300, "20 · Orhei", "Orhei", 5), ...many(8, "20 · Orhei", "Orhei", 100), ...many(30, "05 · Comrat", "Comrat", 24 * 30), mk("Nedeterminată", "—", 100), ...many(50, "27 · Taraclia", "", 90).map((m) => ({ ...m, pf: "Defectate_Jooby_Gaz" })), mk("20 · Orhei", "Orhei", null)];
  const stats = silentByZone(fleet, NOW);
  const comrat = stats.find((s) => s.zone === "05|Comrat"), orhei = stats.find((s) => s.zone === "20|Orhei");
  check("alerte: contoarele se numără pe zonă (filială|oraș): transmit (≤36 h) și «au tăcut de curând» (36 h – 10 zile); mai vechi de 10 zile, defecte, fără filială sau fără citire nu intră", comrat?.recent === 100 && comrat?.lapsed === 40 && orhei?.recent === 300 && orhei?.lapsed === 8 && stats.length === 2, JSON.stringify(stats));
  check("alerte: problemă dacă au tăcut cel puțin 15 și cel puțin 15% (grav la 40%+); Orhei (8 contoare) nu e problemă", silentProblem(comrat!)?.level === "warn" && silentProblem({ zone: "x|y", recent: 20, lapsed: 20 })?.level === "crit" && silentProblem(orhei!) === null && silentProblem({ zone: "x|y", recent: 1000, lapsed: 100 }) === null && silentProblem({ zone: "x|y", recent: 60, lapsed: 20 })?.level === "warn");
  check("alerte: zona unui contor fără oraș = «filială|—»", zoneOf("05 · Comrat", "") === "05|—" && zoneOf("05 · Comrat", "Comrat") === "05|Comrat");
  const day = (back: number, n: number) => ({ d: Date.UTC(2026, 10, 24) - back * D1, n });
  const steady = [1, 2, 3, 4, 5, 6, 7].map((b) => day(b, 100));
  check("alerte: antenă fără mesaje — tace mai mult de 4 intervale obișnuite (min. 3 h), dar nu de peste 14 zile; antenele cu sub 2 mesaje pe zi nu se urmăresc", gatewayDown(NOW - 5 * H1, steady, NOW).down && !gatewayDown(NOW - 2 * H1, steady, NOW).down && !gatewayDown(NOW - 20 * D1, steady, NOW).down && !gatewayDown(NOW - 30 * H1, [1, 2, 3, 4, 5, 6, 7].map((b) => day(b, 1)), NOW).down && gatewayDown(NOW - 40 * H1, [1, 2, 3, 4, 5, 6, 7].map((b) => day(b, 4)), NOW).down && gatewayDown(null, steady, NOW).down === false);
  check("alerte: eficiență scăzută — ieri sub jumătate din mediana celor 7 zile dinainte (mediană ≥ 40); ieri normal sau mediană mică ⇒ fără problemă", gatewayDrop([day(1, 30), ...[2, 3, 4, 5, 6, 7, 8].map((b) => day(b, 100))], NOW).drop && !gatewayDrop([day(1, 80), ...[2, 3, 4, 5, 6, 7, 8].map((b) => day(b, 100))], NOW).drop && !gatewayDrop([day(1, 5), ...[2, 3, 4, 5, 6, 7, 8].map((b) => day(b, 30))], NOW).drop && gatewayDrop([...[2, 3, 4, 5, 6, 7, 8].map((b) => day(b, 100))], NOW).yesterday === 0);
  const P = (key: string, size: number, level: "warn" | "crit" = "warn"): Problem => ({ type: key.startsWith("gw_down") ? "gw_down" : "meters_silent", key, level, title: key, body: "", zones: [], size });
  const pl = planEvents([P("meters_silent|05|Comrat", 40), P("meters_silent|20|Orhei", 20), P("gw_down|aa", 5), P("meters_silent|11|Cahul", 100)], [{ _id: "meters_silent|05|Comrat", type: "meters_silent", level: "warn", nsize: 30 }, { _id: "meters_silent|20|Orhei", type: "meters_silent", level: "warn", nsize: 10 }, { _id: "meters_silent|27|Taraclia", type: "meters_silent", level: "warn", nsize: 20 }, { _id: "gw_down|aa", type: "gw_down", level: "warn", nsize: 5 }], new Set(["meters_silent|05|Comrat", "meters_silent|20|Orhei", "meters_silent|27|Taraclia", "gw_down|aa"]));
  check("alerte: probleme noi se deschid (și se anunță), cele care s-au agravat de 1,5× cu cel puțin 10 se anunță din nou, cele neschimbate doar se actualizează, cele dispărute se închid", pl.open.map((p) => p.key).join() === "meters_silent|11|Cahul" && pl.escalate.map((p) => p.key).join() === "meters_silent|20|Orhei" && pl.update.map((p) => p.key).sort().join() === "gw_down|aa,meters_silent|05|Comrat" && pl.resolve.join() === "meters_silent|27|Taraclia", JSON.stringify(pl));
  const crit = planEvents([P("meters_silent|05|Comrat", 31, "crit")], [{ _id: "meters_silent|05|Comrat", type: "meters_silent", level: "warn", nsize: 30 }], new Set(["meters_silent|05|Comrat"]));
  check("alerte: trecerea de la «atenție» la «grav» se anunță din nou", crit.escalate.length === 1);
  // cine primește: tipul bifat + zona
  const lim = (access: object) => ({ admin: false as const, access: { perms: {}, allZones: false, branches: [], cities: [], ...access } });
  check("notificări: administratorul vede orice zonă; limitatul doar zonele lui; eveniment fără zone doar administratorul; orașul altei filiale cu același nume nu intră", eventVisible({ admin: true, access: { perms: {}, allZones: false, branches: [], cities: [] } }, ["05|Comrat"]) && eventVisible(lim({ cities: ["05|Comrat"] }), ["20|Orhei", "05|Comrat"]) && !eventVisible(lim({ cities: ["05|Comrat"] }), ["20|Orhei"]) && eventVisible(lim({ branches: ["20"] }), ["20|Orhei"]) && !eventVisible(lim({ branches: ["20"] }), []) && !eventVisible(lim({ cities: ["05|Orhei"] }), ["20|Orhei"]) && eventVisible({ admin: true, access: { perms: {}, allZones: false, branches: [], cities: [] } }, []));
  const cn = cleanNotify(["meters_silent", "gw_down", "x", "gw_down", 5 as unknown as string]);
  check("notificări: lista de tipuri se curăță (necunoscute / dubluri ies); valori greșite ⇒ eroare; lipsă ⇒ nimic", "error" in cn && "notify" in cleanNotify(["gw_drop", "gw_drop", "zzz"]) && (cleanNotify(["gw_drop", "gw_drop", "zzz"]) as { notify: string[] }).notify.join() === "gw_drop" && (cleanNotify(undefined) as { notify: string[] }).notify.length === 0 && "error" in cleanNotify("gw_down"));
  check("notificări: abonamentul push se validează (https, chei de lungime rezonabilă)", cleanSub({ endpoint: "https://fcm.googleapis.com/fcm/send/abcdefgh", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }) !== null && cleanSub({ endpoint: "http://x.example/aaaaaaaaaa", keys: { p256dh: "B".repeat(87), auth: "a".repeat(22) } }) === null && cleanSub({ endpoint: "https://x.example/aaaaaaaa", keys: { p256dh: "B", auth: "a" } }) === null && cleanSub(null) === null);
  // livrarea: cine primește ce, abonamente moarte șterse (bază de date falsă)
  const users = [
    { _id: "adm", role: "super_admin", notify: ["meters_silent", "gw_down"] },
    { _id: "comrat", role: "user", access: { pages: ["meters"], branches: [], cities: ["05|Comrat"] }, notify: ["meters_silent"] },
    { _id: "orhei", role: "user", access: { pages: ["meters"], branches: ["20"], cities: [] }, notify: ["meters_silent"] },
    { _id: "nutip", role: "user", access: { pages: ["meters"], branches: ["05"], cities: [] }, notify: ["gw_down"] },
    { _id: "off", role: "user", access: { pages: ["meters"], branches: ["05"], cities: [] }, notify: ["meters_silent"], disabled: true },
    { _id: "gol", role: "user", access: { perms: {}, allZones: false, branches: [], cities: [] }, notify: ["meters_silent"] },
  ];
  const subs = [{ _id: "s1", userId: "adm", endpoint: "https://p/1", keys: { p256dh: "x".repeat(30), auth: "y".repeat(10) } }, { _id: "s2", userId: "comrat", endpoint: "https://p/2", keys: { p256dh: "x".repeat(30), auth: "y".repeat(10) } }, { _id: "s3", userId: "comrat", endpoint: "https://p/3", keys: { p256dh: "x".repeat(30), auth: "y".repeat(10) } }, { _id: "s4", userId: "orhei", endpoint: "https://p/4", keys: { p256dh: "x".repeat(30), auth: "y".repeat(10) } }];
  const deleted: unknown[] = [];
  const fakeDb = { collection: (n: string) => ({
    // la fel ca baza de date: abonamentele după utilizatorii ceruți, utilizatorii după tipul bifat și fără conturile dezactivate
    find: (q: { userId?: { $in: string[] }; notify?: string; disabled?: unknown }) => ({ toArray: async () => (n === "push_subs" ? subs.filter((s) => q.userId?.$in.includes(s.userId)) : users.filter((u) => (!q.notify || u.notify.includes(q.notify)) && (q.disabled === undefined || (u as { disabled?: boolean }).disabled !== true))) }),
    deleteMany: async (q: { _id: { $in: unknown[] } }) => { deleted.push(...q._id.$in); },
  }) } as unknown as Db;
  const sentTo: string[] = [];
  const send: Sender = async (s: PushSub) => { sentTo.push(s.endpoint); return s.endpoint === "https://p/3" ? "gone" : "ok"; };
  const evC = { type: "meters_silent" as const, key: "k", level: "warn" as const, title: "t", body: "b", zones: ["05|Comrat"] };
  const rc = await recipients(fakeDb, evC), rcO = await recipients(fakeDb, { ...evC, zones: ["20|Orhei"] }), rcG = await recipients(fakeDb, { type: "gw_down", zones: ["05|Comrat"] }), rcNone = await recipients(fakeDb, { ...evC, zones: [] });
  check("notificări: destinatari = tipul bifat + zona vizibilă; conturile dezactivate sau fără zonă nu primesc; fără zone doar administratorul", rc.join() === "adm,comrat" && rcO.join() === "adm,orhei" && rcG.join() === "adm,nutip" && rcNone.join() === "adm", JSON.stringify([rc, rcO, rcG, rcNone]));
  const dr = await deliver(fakeDb, send, evC);
  check("notificări: se trimite la fiecare dispozitiv al destinatarilor, nu altora; abonamentul expirat (410) se șterge", dr.users === 2 && dr.sent === 2 && dr.gone === 1 && dr.failed === 0 && sentTo.sort().join() === "https://p/1,https://p/2,https://p/3" && deleted.join() === "s3", JSON.stringify([dr, sentTo, deleted]));
})();

// ───── antene (ecranul instalatorului de antene)
{
  check("antene: codul QR → identificatorul antenei (16 cifre hexazecimale), cu sau fără prefix; altceva ⇒ null", parseAntennaQr("5031395355324750") === "5031395355324750" && parseAntennaQr("EUI:AC1F09FFFE1060FB") === "ac1f09fffe1060fb" && parseAntennaQr("x ac1f09fffe1060fb;y") === "ac1f09fffe1060fb" && parseAntennaQr("ac1f09fffe1060fb0") === null && parseAntennaQr("abc") === null && parseAntennaQr("") === null);
  check("antene: id valid (fără căi / spații), cu litere mici", antennaIdOk("ac1f09fffe1060fb") && antennaIdOk("m-324750") && !antennaIdOk("../x") && !antennaIdOk("a b") && !antennaIdOk("ab") && !antennaIdOk("AC1F09FFFE1060FB"));
  const okp = cleanAntennaPatch({ NumeInstalator: " Alex ", Gateways_latitude: "47,89337", Gateways_longitude: 28.29785, Instalta: true, Antena_mobila: "true", NrTel_SIM: "069154363", ip_address: "172.17.1.79", Comments: "Floresti", Client: "x", evil: "y", image: "AAAA", _id: "z" });
  check("antene: se păstrează doar câmpurile cunoscute, curățate (virgula zecimală, spații la capete); image / _id / străine ignorate", "patch" in okp && JSON.stringify(okp.patch) === JSON.stringify({ NumeInstalator: "Alex", NrTel_SIM: "069154363", ip_address: "172.17.1.79", Client: "x", Comments: "Floresti", Gateways_latitude: 47.89337, Gateways_longitude: 28.29785, Instalta: true, Antena_mobila: true }) || ("patch" in okp && okp.patch.NumeInstalator === "Alex" && okp.patch.Gateways_latitude === 47.89337 && okp.patch.Antena_mobila === true && !("image" in okp.patch)));
  const na = cleanNewAntenna({ id: "EUI:AC1F09FFFE1060FB", name: " M-1060FB_Orhei ", description: "Orhei, spital", latitude: "47,89", longitude: 28.29, Client: "x", evil: 1 });
  check("antene noi: EUI-ul (și din cod QR) → litere mici, numele curățat, coordonatele numere, altitudine implicit 0, câmpuri străine ignorate", "antenna" in na && na.antenna.id === "ac1f09fffe1060fb" && na.antenna.name === "M-1060FB_Orhei" && na.antenna.latitude === 47.89 && na.antenna.longitude === 28.29 && na.antenna.altitude === 0 && !("evil" in na.antenna));
  check("antene noi: EUI scurt, nume cu spațiu / prea scurt, o singură coordonată, coordonată în afara limitelor ⇒ eroare", [{ id: "abc", name: "Antena1" }, { id: "ac1f09fffe1060fb", name: "Antena noua" }, { id: "ac1f09fffe1060fb", name: "ab" }, { id: "ac1f09fffe1060fb", name: "Antena1", latitude: 47 }, { id: "ac1f09fffe1060fb", name: "Antena1", latitude: 95, longitude: 20 }, { id: "ac1f09fffe1060fb", name: "Antena1", altitude: 99999 }, null].every((b) => "error" in cleanNewAntenna(b)));
  const cf = "antenna" in na ? chirpstackFields(na.antenna) : [];
  check("antene noi: câmpurile pentru ChirpStack în ordinea formularului (nume, descriere, Gateway ID, latitudine, longitudine, altitudine); fără descriere se pune numele", cf.map((x) => x.label).join("|") === "Gateway name|Gateway description|Gateway ID|Latitude|Longitude|Gateway altitude (meters)" && cf[2].value === "ac1f09fffe1060fb" && cf[3].value === "47.89" && chirpstackText({ id: "ac1f09fffe1060fb", name: "Antena1", description: "", latitude: null, longitude: null, altitude: 0 }).split(String.fromCharCode(10))[1] === "Gateway description: Antena1");
  check("antene: valori invalide sau cerere goală ⇒ eroare", [{ Gateways_latitude: 91 }, { Gateways_longitude: "x" }, { Gateways_latitude: "" }, { Comments: "x".repeat(2001) }, { NumeInstalator: "x".repeat(61) }, {}, null, "text"].every((b) => "error" in cleanAntennaPatch(b)));
  const mk = (id: string, o: Partial<AntennaRow>): AntennaRow => ({ id, name: "", active: false, state: "off", last: null, msgs: 0, Comments: "", Client: "", NrTel_SIM: "", ip_address: "", NumeInstalator: "", latitude: null, longitude: null, Instalta: false, Antena_mobila: false, hasPhoto: false, ...o });
  const rows = [mk("aaaa0001", { name: "M-324750", last: 300, msgs: 5, Comments: "Rezina-gaz", NumeInstalator: "Sergio" }), mk("bbbb0002", { last: null, msgs: 9, Client: "Oleg" }), mk("cccc0003", { name: "RAK_60FB_Floresti", last: 100, msgs: 1, ip_address: "172.17.1.79" })];
  const ids = (r: AntennaRow[]) => r.map((x) => x.id.slice(0, 4)).join(",");
  check("antene: căutare în id, nume, comentarii, client, SIM, IP, instalator (fără diferență între litere)", ids(queryAntennas(rows, "rezina", "id", "asc")) === "aaaa" && ids(queryAntennas(rows, "oleg", "id", "asc")) === "bbbb" && ids(queryAntennas(rows, "172.17", "id", "asc")) === "cccc" && ids(queryAntennas(rows, "SERGIO", "id", "asc")) === "aaaa" && ids(queryAntennas(rows, "zzz", "id", "asc")) === "" && ids(queryAntennas(rows, "  ", "id", "desc")) === "cccc,bbbb,aaaa");
  check("antene: sortare după ultima activitate / mesaje, lipsurile la sfârșit în ambele sensuri", ids(queryAntennas(rows, "", "lastActivityTime", "desc")) === "aaaa,cccc,bbbb" && ids(queryAntennas(rows, "", "lastActivityTime", "asc")) === "cccc,aaaa,bbbb" && ids(queryAntennas(rows, "", "CounterMessages", "desc")) === "bbbb,aaaa,cccc" && ids(queryAntennas(rows, "", "Comments", "asc")) === "aaaa,bbbb,cccc");
  check("antene: data ca în tabelul din SCADA (ziua și luna fără zero în față)", fdtA(new Date(2026, 3, 15, 7, 48, 48).getTime()) === "15/4/2026 07:48:48" && fdtA(new Date(2026, 10, 24, 18, 16, 30).getTime()) === "24/11/2026 18:16:30" && fdtA(null) === "" && fdtA(0) === "");
  const tryRO = (m: string, p: string) => { try { assertReadOnly(m, p); return true; } catch { return false; } };
  check("antene: din SCADA se citește doar lista dispozitivelor de tip gatewayType(1), nimic altceva nou", tryRO("GET", "/api/tenant/devices?type=gatewayType&pageSize=100&page=0") && tryRO("GET", "/api/tenant/devices?type=gatewayType1&pageSize=100&page=2") && !tryRO("GET", "/api/tenant/devices?type=Other&pageSize=100&page=0") && !tryRO("POST", "/api/tenant/devices?type=gatewayType&pageSize=100&page=0") && !tryRO("DELETE", "/api/tenant/devices?type=gatewayType&pageSize=100&page=0"));
}

// ───── lista instalatorului în browser: căutare / sortare locale
{
  const d = { nm: ["S2154_00000003_2022", "S2154_00000001_2022", "S4254_00000002_2025", "S2154_00000010_2022"], cn: ["", "AB-77", "", "ab-12"], ia: [300, null, 100, 200], vol: [5, 9, null, 1], il: [null, 10, 20, 5], vl: [1, 2, 3, 4], mi: [0, 0, 0, 0] };
  const names = (o: Int32Array) => Array.from(o, (i) => d.nm[i].slice(6, 14)).join(",");
  check("lista instalatorului: fără căutare, după nume crescător / descrescător", names(queryInstaller(d, "", "name", "asc")) === "00000001,00000003,00000010,00000002" && names(queryInstaller(d, "", "name", "desc")) === "00000002,00000010,00000003,00000001");
  check("lista instalatorului: căutare în nume și în ContorNr, fără diferență între litere mari / mici", names(queryInstaller(d, "S4254", "name", "asc")) === "00000002" && names(queryInstaller(d, "ab-", "name", "asc")) === "00000001,00000010" && names(queryInstaller(d, "  00000003 ", "name", "asc")) === "00000003" && queryInstaller(d, "zzz", "name", "asc").length === 0);
  check("lista instalatorului: sortare numerică, lipsurile la sfârșit în ambele sensuri", names(queryInstaller(d, "", "Volume_m3_Total", "asc")) === "00000010,00000003,00000001,00000002" && names(queryInstaller(d, "", "Volume_m3_Total", "desc")) === "00000001,00000003,00000010,00000002" && names(queryInstaller(d, "", "Instalation_Litres", "asc")) === "00000010,00000001,00000002,00000003");
  check("lista instalatorului: «active» / «ActiveTime» / «lastActivityTime» se sortează după ultima activitate", names(queryInstaller(d, "", "ActiveTime", "desc")) === "00000003,00000010,00000002,00000001" && names(queryInstaller(d, "", "lastActivityTime", "asc")) === "00000002,00000010,00000003,00000001");
}

// ───── acces: utilizatori limitați la filiale / orașe
{
  const lim = (access: Partial<Viewer["access"]>): Viewer => ({ admin: false, access: { perms: {}, allZones: false, branches: [], cities: [], ...access } });
  const adm: Viewer = { admin: true, access: { perms: {}, allZones: false, branches: [], cities: [] } };
  const COM = "05 · Comrat", ORH = "20 · Orhei";
  check("acces: administratorul vede orice contor", allowsMeter(adm, COM, "Comrat") && allowsMeter(adm, "Nedeterminată", "—"));
  check("acces: filială bifată întreagă ⇒ toate orașele ei (și „fără oraș”), nimic din alte filiale", (() => { const v = lim({ branches: ["05"] }); return allowsMeter(v, COM, "Comrat") && allowsMeter(v, COM, "Ceadir-Lunga") && allowsMeter(v, COM, "—") && !allowsMeter(v, ORH, "Orhei"); })());
  check("acces: doar anumite orașe ⇒ numai ele, în filiala lor (același oraș din altă filială nu intră)", (() => { const v = lim({ cities: ["05|Comrat", "20|Orhei"] }); return allowsMeter(v, COM, "Comrat") && allowsMeter(v, ORH, "Orhei") && !allowsMeter(v, COM, "Ceadir-Lunga") && !allowsMeter(v, ORH, "Comrat") && !allowsMeter(v, COM, "—"); })());
  check("acces: „fără oraș” se bifează separat (05|—)", (() => { const v = lim({ cities: ["05|—"] }); return allowsMeter(v, COM, "—") && allowsMeter(v, COM, "") && !allowsMeter(v, COM, "Comrat"); })());
  check("acces: nimic bifat ⇒ niciun contor; filială necunoscută / nedeterminată nu intră niciodată la limitați", !allowsMeter(lim({}), COM, "Comrat") && !allowsMeter(lim({ branches: ["05"] }), "Nedeterminată", "—") && !allowsMeter(lim({ branches: ["05"] }), "", ""));
  check("acces: orașul cu „|” în nume rămâne în filiala lui", (() => { const v = lim({ cities: ["05|A|B"] }); return allowsMeter(v, COM, "A|B") && !allowsMeter(v, COM, "A"); })());
  const P = (perms: NonNullable<Viewer["access"]["perms"]>, extra: Partial<Viewer["access"]> = {}) => lim({ perms, ...extra });
  check("acces: pagini — limitatul vede doar ce e bifat, administratorul tot; prima pagină permisă", canPage(P({ installer: ["view", "edit"] }), "installer") && !canPage(P({ installer: ["view"] }), "meters") && canPage(adm, "meters") && firstPath(P({ installer: ["view"] })) === "/instalator" && firstPath(P({ meters: ["view"], installer: ["view"] })) === "/" && firstPath(lim({})) === null && firstPath(adm) === "/");
  check("acces: acțiuni separate — editarea nu dă ștergerea, administratorul poate tot, fără dreptul pe pagină nimic", can(P({ reports: ["view", "edit"] }, { allZones: true }), "reports", "edit") && !can(P({ reports: ["view", "edit"] }, { allZones: true }), "reports", "delete") && !can(P({ reports: ["view"] }, { allZones: true }), "reports", "export") && can(adm, "reports", "delete") && !can(lim({}), "meters") && canOf(P({ module: ["view", "edit"] }), "module").edit === true && canOf(P({ module: ["view", "edit"] }), "module").run === false);
  check("acces: cheia zonei nu depinde de ordinea bifelor și diferă între zone", scopeKey(lim({ branches: ["20", "05"], cities: ["11|B", "11|A"] })) === scopeKey(lim({ branches: ["05", "20"], cities: ["11|A", "11|B"] })) && scopeKey(lim({ branches: ["05"] })) !== scopeKey(lim({ branches: ["20"] })) && scopeKey(adm) === "");
  const c1 = cleanAccess({ perms: { meters: ["view", "view"], instalator: ["view"], installer: ["view", "zbor", "delete"] }, branches: ["05", "x", "05", "999999"], cities: ["05|Comrat", "20|Orhei", "bad", "20|"] });
  check("acces: validare — pagini / acțiuni / filiale / orașe necunoscute sunt scoase, duplicatele la fel, orașele din filiale bifate întregi dispar", "access" in c1 && c1.access.perms.meters?.join() === "view" && c1.access.perms.installer?.join() === "view" && !("instalator" in c1.access.perms) && c1.access.branches.join() === "05" && c1.access.cities.join() === "20|Orhei", JSON.stringify(c1));
  check("acces: validare — cerere greșită respinsă", "error" in cleanAccess(null) && "error" in cleanAccess({ perms: "meters", branches: [], cities: [] }) && "error" in cleanAccess({ perms: {}, branches: [1], cities: [] }) && "error" in cleanAccess({ perms: { meters: "view" }, branches: [], cities: [] }) && "error" in cleanAccess({ pages: "meters", branches: [], cities: [] }));
  // legătura dintre acțiuni
  const lk = cleanAccess({ perms: { module: ["run"], reports: ["delete", "export"], integration: ["edit"] }, allZones: true, branches: [], cities: [] });
  check("acces: acțiunile se leagă — rulare ⇒ și editare + vizualizare; ștergere / descărcare ⇒ vizualizare", "access" in lk && lk.access.perms.module?.join() === "view,edit,run" && lk.access.perms.reports?.join() === "view,delete,export" && lk.access.perms.integration?.join() === "view,edit");
  check("acces: o acțiune pe care pagina n-o are se ignoră (contoare nu se editează, facturarea nu se șterge)", (() => { const c = cleanAccess({ perms: { meters: ["view", "edit", "delete"], billing: ["view", "run"] }, allZones: true, branches: [], cities: [] }); return "access" in c && c.access.perms.meters?.join() === "view" && c.access.perms.billing?.join() === "view"; })());
  // paginile cu date din toate filialele cer «Toate filialele»
  const gl = cleanAccess({ perms: { reports: ["view"], meters: ["view"] }, branches: ["05"], cities: [] });
  const gr = cleanAccess({ perms: { reports: ["view"], meters: ["view"] }, branches: ["05"], cities: [] }, false);
  check("acces: pagină globală fără «Toate filialele» ⇒ la scriere eroare explicită, la citire se ignoră (contul nu se blochează)", "error" in gl && /Toate filialele/.test((gl as { error: string }).error) && "access" in gr && !("reports" in gr.access.perms) && gr.access.perms.meters?.join() === "view");
  const az = cleanAccess({ perms: { reports: ["view"] }, allZones: true, branches: ["05"], cities: ["05|Comrat"] });
  check("acces: «Toate filialele» ⇒ vede orice contor, filialele / orașele bifate nu mai contează, cheia zonei e goală", "access" in az && az.access.allZones && az.access.branches.length === 0 && allowsMeter({ admin: false, access: az.access }, COM, "Comrat") && allowsMeter({ admin: false, access: az.access }, ORH, "—") && scopeKey({ admin: false, access: az.access }) === "");
  // drepturile vechi (listă de pagini) se citesc ca matrice: instalatorii puteau și salva, restul doar vedeau
  const lg = cleanAccess({ pages: ["meters", "installer", "antennas", "nimic"], branches: ["05"], cities: [] });
  check("acces: drepturile vechi (listă de pagini) se convertesc: contoare = vizualizare; instalator și antene = vizualizare + editare", "access" in lg && lg.access.perms.meters?.join() === "view" && lg.access.perms.installer?.join() === "view,edit" && lg.access.perms.antennas?.join() === "view,edit" && viewerFromDoc({ role: "user", access: { pages: ["installer"], branches: ["05"], cities: [] } }).access.perms.installer?.join() === "view,edit" && viewerFromDoc({ role: "super_admin" }).admin && !viewerFromDoc({ role: "user", access: "stricat" }).admin);
  // cine poate da ce
  const mgr = P({ users: ["view", "edit"], reports: ["view", "edit"], meters: ["view"] }, { branches: ["05"], cities: ["20|Orhei"], allZones: false });
  const tgt = (perms: NonNullable<Viewer["access"]["perms"]>, extra: Partial<Viewer["access"]> = {}) => ({ perms, allZones: false, branches: [], cities: [], ...extra });
  check("acces: «cine poate da ce» — nu poți da o acțiune sau o pagină pe care n-o ai, nici toată zona; poți da mai puțin", grantable(mgr, tgt({ meters: ["view"] }, { branches: ["05"] })) && !grantable(mgr, tgt({ reports: ["view", "delete"] })) && !grantable(mgr, tgt({ module: ["view"] })) && !grantable(mgr, tgt({ meters: ["view"] }, { allZones: true })) && grantable(adm, tgt({ module: ["view", "run"] }, { allZones: true })));
  check("acces: «cine poate da ce» — zona: filială proprie, oraș propriu sau oraș dintr-o filială proprie da; filială sau oraș străin nu", grantable(mgr, tgt({ meters: ["view"] }, { cities: ["05|Comrat", "20|Orhei"] })) && !grantable(mgr, tgt({ meters: ["view"] }, { branches: ["20"] })) && !grantable(mgr, tgt({ meters: ["view"] }, { cities: ["20|Soroca"] })) && !grantable(mgr, tgt({ meters: ["view"] }, { branches: ["99"] })));
  check("acces: aceleași drepturi (sameAccess) ignoră ordinea bifelor", sameAccess(tgt({ meters: ["view"] }, { branches: ["05", "20"] }), tgt({ meters: ["view"] }, { branches: ["20", "05"] })) && !sameAccess(tgt({ meters: ["view"] }), tgt({ meters: ["view", "edit"] })) && !sameAccess(tgt({ meters: ["view"] }), tgt({ meters: ["view"] }, { allZones: true })));
  check("acces: toate rețetele sunt valide (trec de validarea strictă, fără acțiuni inexistente) și nu cer mai mult decât zona lor", PRESETS.every((p) => { const c = cleanAccess({ perms: p.perms, allZones: p.allZones, branches: [], cities: [] }); return "access" in c && PAGES.every((d) => (c.access.perms[d.key] ?? []).join() === (p.perms[d.key] ?? []).join()); }));
  // legătura antenei cu contoarele de gaz
  const NOW = Date.parse("2026-11-24T12:00:00Z"), D = 86_400_000;
  check("antene: legătura cu gazul — contoare auzite la noi ⇒ acum; în SCADA: ≤7 zile acum, ≤30 zile în ultima lună, mai demult «demult», 0 ⇒ niciodată, fără date ⇒ necunoscut", gasLink({ devices: 3, gas: 0, gasAt: null }, NOW) === "recent" && gasLink({ devices: 0, gas: 50, gasAt: NOW - 2 * D }, NOW) === "recent" && gasLink({ devices: 0, gas: 50, gasAt: NOW - 20 * D }, NOW) === "month" && gasLink({ devices: 0, gas: 50, gasAt: NOW - 90 * D }, NOW) === "older" && gasLink({ devices: 0, gas: 0, gasAt: null }, NOW) === "never" && gasLink({ devices: 0, gas: null, gasAt: null }, NOW) === "unknown");
  check("antene: «cu contoarele noastre» = acum sau în ultima lună; demult / niciodată / necunoscut nu", ours("recent") && ours("month") && !ours("older") && !ours("never") && !ours("unknown"));
  // simulare de login: cine pe cine
  const acc = (perms: NonNullable<Viewer["access"]["perms"]>, extra: Partial<Viewer["access"]> = {}) => ({ perms, allZones: false, branches: [] as string[], cities: [] as string[], ...extra });
  const impA = (o: Partial<ImpActor> = {}): ImpActor => ({ id: "a", admin: false, access: acc({ users: ["view", "impersonate"], meters: ["view"], reports: ["view", "edit"] }, { allZones: true }), ...o });
  const impT = (o: Partial<ImpTarget> = {}): ImpTarget => ({ id: "t", admin: false, disabled: false, access: acc({ meters: ["view"] }, { allZones: true }), ...o });
  check("simulare: administratorul intră în orice cont activ (și în alt administrator); nu în propriul cont, nu într-unul dezactivat", canImpersonate(impA({ admin: true }), true, impT({ admin: true })).ok && canImpersonate(impA({ admin: true }), true, impT()).ok && !canImpersonate(impA({ admin: true }), true, impT({ id: "a" })).ok && !canImpersonate(impA({ admin: true }), true, impT({ disabled: true })).ok);
  check("simulare: fără dreptul «Simulare» nu merge; în timpul unei simulări nu se pornește alta", !canImpersonate(impA(), false, impT()).ok && !canImpersonate(impA({ admin: true, impersonation: { byId: "x", byName: "X", byEmail: "x@x", expiresAt: Date.now() + 1e6 } }), true, impT()).ok);
  check("simulare: un cont limitat intră doar în conturi cu drepturi mai mici sau egale, niciodată în administrator", canImpersonate(impA(), true, impT()).ok && !canImpersonate(impA(), true, impT({ admin: true })).ok && !canImpersonate(impA(), true, impT({ access: acc({ meters: ["view"], module: ["view"] }, { allZones: true }) })).ok && !canImpersonate(impA(), true, impT({ access: acc({ reports: ["view", "delete"] }, { allZones: true }) })).ok && !canImpersonate(impA({ access: acc({ meters: ["view"] }, { branches: ["05"] }) }), true, impT({ access: acc({ meters: ["view"] }, { allZones: true }) })).ok);
  check("simulare: durata fixă de 6 ore; timpul rămas se scrie citibil", IMPERSONATION_TTL_MS === 6 * 3_600_000 && formatRemaining(5 * 3_600_000 + 12 * 60_000) === "5 h 12 min" && formatRemaining(48 * 60_000) === "48 min" && formatRemaining(30_000) === "sub 1 min" && formatRemaining(-5) === "0 min");
  check("simulare: tot ce se face în simulare rămâne în jurnal pe contul real (actorOf adaugă «simulat de»), iar în simulare conturile nu se modifică", readFileSync("lib/audit-actor.ts", "utf8").includes("sim: { id: u.impersonation.byId") && readFileSync("lib/guard.ts", "utf8").includes("simBlocked") && readFileSync("app/api/notifications/route.ts", "utf8").includes("w.user.impersonation") && readFileSync("proxy.ts", "utf8").includes("mg_session_orig"));
  // parolă: reguli, resetare prin e-mail
  check("parolă: minim 8 caractere, nu doar cifre / același caracter / parole banale / adresa de e-mail / parola veche; o parolă bună trece", passwordProblem("scurta") !== null && passwordProblem("12345678") !== null && passwordProblem("aaaaaaaaaa") !== null && passwordProblem("Parola1234") !== null && passwordProblem("ion.popescu@x.md", { email: "Ion.Popescu@x.md" }) !== null && passwordProblem("ion.popescu", { email: "ion.popescu@x.md" }) !== null && passwordProblem("AceastaEBuna-7", { current: "AceastaEBuna-7" }) !== null && passwordProblem("x".repeat(PASSWORD_MAX + 1)) !== null && passwordProblem("Cai-verzi pe pereți 42", { email: "a@b.md", current: "veche1234" }) === null && PASSWORD_MIN === 8);
  check("parolă: indicatorul de putere crește cu lungimea și varietatea", passwordStrength("") === 0 && passwordStrength("abcdefgh") === 1 && passwordStrength("abcdefghijkl") === 2 && passwordStrength("Abcdefghijkl") === 3 && passwordStrength("Abcdefghij1!") === 4);
  const acct = readFileSync("lib/services/account.ts", "utf8");
  check("resetare parolă: în baza de date stă doar hash-ul tokenului (nu tokenul), valabil 60 de minute, de unică folosință, cu limitare pe adresă și pe IP", acct.includes("_id: hashToken(token)") && !/insertOne\([^)]*token[^)]*\)/.test(acct.replace(/hashToken\(token\)/g, "")) && acct.includes("TTL_MS = 60 * 60_000") && acct.includes("findOneAndDelete") && acct.includes("hit(`fp-em|") && acct.includes("hit(`fp-ip|") && acct.includes("expireAfterSeconds: 0"));
  check("resetare parolă: după resetare toate sesiunile contului se închid, iar răspunsul la cerere e același și când adresa nu există", acct.includes("sessions)).deleteMany") && /if \(!user \|\| user\.disabled\) \{[\s\S]*?return \{ ok: true \};/.test(acct));
  const pr = readFileSync("proxy.ts", "utf8");
  check("autentificare: «Ai uitat parola?» și resetarea sunt pagini publice (proxy), iar login-ul trimite la ele", ["/login", "/uita-parola", "/reset-parola"].every((x) => pr.includes(`"${x}"`)) && readFileSync("app/(auth)/login/LoginForm.tsx", "utf8").includes("/uita-parola"));
  {
    const nav = readFileSync("app/api/audit/navigare/route.ts", "utf8"), trk = readFileSync("app/components/AuditTracker.tsx", "utf8");
    check("navigare: ruta cere sesiune, are limită pe cont, plafon de mărime / număr și scrie în grup (nu pagină cu pagină)", nav.includes("getCurrentUser") && nav.includes("hit(") && nav.includes("20_000") && nav.includes("slice(0, 40)") && nav.includes("logAuditMany"));
    check("navigare: nu se păstrează parole / tokenuri din adresă, iar căile sunt validate", nav.includes("NOT_SECRET") && nav.includes("PATH.test"));
    check("navigare: acțiunile nav.* sunt în catalog, în modulul «nav» și pot fi ascunse din listă", ["nav.view", "nav.leave", "nav.query", "nav.click"].every((a) => AUDIT_ACTIONS[a]?.module === "nav") && sanitizeAuditFilters({ hideNav: "1" }).hideNav === true && readFileSync("lib/services/audit.ts", "utf8").includes('m: { $ne: "nav" }'));
    check("navigare: browserul trimite pagina, timpul petrecut, filtrele și clicurile prin sendBeacon, fără a citi câmpuri de text", trk.includes("sendBeacon") && trk.includes('t: "view"') && trk.includes('t: "leave"') && trk.includes('t: "query"') && trk.includes('t: "click"') && !trk.includes(".value"));
    check("navigare: urmărirea e în ambele cadre (aplicație + instalator)", readFileSync("app/(app)/layout.tsx", "utf8").includes("<AuditTracker />") && readFileSync("app/(installer)/layout.tsx", "utf8").includes("<AuditTracker />"));
  }
  {
    const gl = readFileSync("app/components/GatewayLayer.tsx", "utf8"), gs = readFileSync("lib/services/gateways.ts", "utf8");
    check("hartă: liniile antenei (până la 10 000) se desenează pe UN canvas, nu cu un obiect Leaflet pe linie; detaliile pentru hartă sunt compacte (tablouri) și fără lista completă (lite)", gs.includes("MAX_LINES = 10_000") && gs.includes("lite ? []") && gl.includes("className=\"gw-lines\"") && gl.includes("fan.current") && !/det.devices/.test(gl) && readFileSync("app/api/integration/gateways/route.ts", "utf8").includes('"lite"'));
  }
  check("securitate: pagina și API-ul sunt pentru contul propriu (fără drept special), blocate în simulare de login", readFileSync("app/api/securitate/route.ts", "utf8").includes("user.impersonation") && readFileSync("app/(app)/securitate/page.tsx", "utf8").includes("user.impersonation") && acct.includes("user.impersonation"));
  check("mail: fără SMTP_HOST / expeditor / APP_URL funcția e oprită (nu se trimite nimic)", readFileSync("lib/mailer.ts", "utf8").includes("export const mailConfigured") && acct.includes("if (!mailConfigured())"));
  check("acces: fiecare pagină are «Vizualizare»; acțiunile paginii au descriere; căile sunt unice", PAGES.every((d) => !!d.actions.view && Object.values(d.actions).every((t) => !!t)) && new Set(PAGES.map((d) => d.path)).size === PAGES.length);
  // paginile de administrare și API-urile lor cer „admin”; contoarele cer zona
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  // fiecare API cere pagina ȘI acțiunea potrivită (matricea din lib/access.ts), nu doar „e administrator”
  const guards: Record<string, string[]> = {
    "app/api/control/suspects/route.ts": ['apiGuard("control")'],
    "app/api/integration/check/route.ts": ['apiGuard("integration")'],
    "app/api/integration/counters/route.ts": ['apiGuard("integration")', 'apiGuard("integration", "delete")'],
    "app/api/integration/devices/route.ts": ['apiGuard("integration")'],
    "app/api/integration/kept/route.ts": ['apiGuard("integration")', 'apiGuard("integration", "delete")'],
    "app/api/integration/reprocess/route.ts": ['apiGuard("integration", "edit")'],
    "app/api/integration/stats/route.ts": ['apiGuard("integration")'],
    "app/api/reports/route.ts": ['apiGuard("reports")', 'apiGuard("reports", "edit")'],
    "app/api/reports/[id]/route.ts": ['apiGuard("reports", "export")', 'apiGuard("reports", "delete")'],
    "app/api/sources/[source]/dataset/route.ts": ['apiGuard(source === "billing" ? "billing" : "lorawan")'],
    "app/api/lorawan/route.ts": ['apiGuard("module")', 'apiGuard("module", "edit")', 'apiGuard("module", "delete")'],
    "app/api/users/route.ts": ['apiGuard("users")', 'apiGuard("users", "edit")'],
    "app/api/users/[id]/route.ts": ['apiGuard("users", "edit")', 'apiGuard("users", "delete")'],
    "app/api/antennas/overview/route.ts": ['apiGuard("antennaInfo")'],
    "app/api/audit/route.ts": ['apiGuard("audit")'],
    "app/api/simulare/route.ts": ['apiGuard("users", "impersonate")'],
    "app/api/audit/export/route.ts": ['apiGuard("audit", "export")'],
    "app/api/antennas/[id]/route.ts": ['apiGuard("antennas")', 'apiGuard("antennas", "edit")'],
    "app/api/antennas/[id]/photo/route.ts": ['apiGuard("antennas")', 'apiGuard("antennas", "edit")'],
    "app/api/installer/meters/[id]/route.ts": ['apiMeterGuard("installer", id)', 'apiMeterGuard("installer", id, "edit")'],
    "app/api/installer/meters/[id]/photo/route.ts": ['apiMeterGuard("installer", id, "edit")'],
  };
  const badG = Object.entries(guards).filter(([f, gs]) => { const t = read(f); let at = -1; return !gs.every((g) => { at = t.indexOf(g, at + 1); return at >= 0; }) || t.includes('apiGuard("admin")') || t.includes("getCurrentUser"); }).map(([f]) => f);
  check("acces: fiecare API cere pagina și acțiunea potrivită (vizualizare / editare / ștergere / descărcare / rulare), în ordinea handlerelor", badG.length === 0, badG.join(", "));
  check("acces: rularea reală în ChirpStack cere dreptul «Rulare» (altfel doar simulare), nu doar «Editare»", read("app/api/lorawan/route.ts").includes('can(g.user, "module", "run")') && /dry === false/.test(read("app/api/lorawan/route.ts")));
  check("acces: conturi — doar în limita drepturilor proprii (grantable / mayManage), fără a-și schimba singur drepturile", ["grantable(actor, c.access)", "mayManage(actor, cur)", "Nu-ți poți schimba singur drepturile"].every((x) => read("lib/services/users.ts").includes(x)));
  const meterRoutes = ["app/api/meters/[id]/route.ts", "app/api/meters/[id]/history/route.ts", "app/api/meters/[id]/photo/route.ts", "app/api/installer/meters/[id]/route.ts", "app/api/installer/meters/[id]/photo/route.ts"];
  check("acces: API-urile unui contor verifică zona utilizatorului (apiMeterGuard)", meterRoutes.every((f) => read(f).includes("apiMeterGuard(") && !read(f).includes("getCurrentUser")), meterRoutes.filter((f) => !read(f).includes("apiMeterGuard(")).join(", "));
  const pageGates: [string, string][] = [["app/(app)/control/page.tsx", 'requirePage("control")'], ["app/(app)/integration/page.tsx", 'requirePage("integration")'], ["app/(app)/rapoarte/page.tsx", 'requirePage("reports")'], ["app/(app)/module/page.tsx", 'requirePage("module")'], ["app/(app)/date-antene/page.tsx", 'requirePage("antennaInfo")'], ["app/(app)/audit/page.tsx", 'requirePage("audit")'], ["app/(app)/utilizatori/page.tsx", 'requirePage("users")'], ["app/components/SourcePage.tsx", 'requirePage(source === "billing" ? "billing" : "lorawan")'], ["app/(installer)/instalator/page.tsx", 'requirePage("installer")'], ["app/(installer)/antene/page.tsx", 'requirePage("antennas")']];
  check("acces: fiecare pagină cere dreptul propriu (requirePage pe pagină), nu «admin»", pageGates.every(([f, g]) => read(f).includes(g) && !read(f).includes('requirePage("admin")')), pageGates.filter(([f, g]) => !read(f).includes(g)).map(([f]) => f).join(", "));
  const noAuth = ["app/api/meters/dataset/route.ts", "app/api/meters/delta/route.ts", "app/api/installer/meters/route.ts", "app/api/installer/prefs/route.ts", "app/api/installer/dataset/route.ts", "app/api/installer/edits/route.ts", "app/api/antennas/route.ts", "app/api/antennas/[id]/route.ts", "app/api/antennas/[id]/photo/route.ts", "app/api/antennas/[id]/stats/route.ts", "app/api/antennas/prefs/route.ts", "app/api/integration/gateways/route.ts"];
  check("acces: lista de contoare, instalatorul și antenele folosesc verificarea de acces, nu doar autentificarea", noAuth.every((f) => (read(f).includes("apiGuard(") || read(f).includes("apiMeterGuard(")) && !read(f).includes("getCurrentUser")), noAuth.filter((f) => !(read(f).includes("apiGuard(") || read(f).includes("apiMeterGuard("))).join(", "));
}

// ───── jurnal de audit
{
  const walkA = (d: string): string[] => readdirSync(d).flatMap((n) => (n === "node_modules" || n === ".next" || n.startsWith(".") ? [] : statSync(join(d, n)).isDirectory() ? walkA(join(d, n)) : /\.(ts|tsx)$/.test(n) ? [join(d, n)] : []));
  const src = ["app", "lib"].flatMap(walkA).filter((f) => !/audit-meta\.ts$/.test(f));
  const used = new Set(src.flatMap((f) => [...readFileSync(f, "utf8").matchAll(/action: (?:dry \? )?"([a-z_]+\.[a-z_]+)"(?: : "([a-z_]+\.[a-z_]+)")?/g)].flatMap((m) => [m[1], m[2]].filter(Boolean) as string[])));
  const unknown = [...used].filter((a) => !(a in AUDIT_ACTIONS));
  check("audit: toate acțiunile scrise în cod au etichetă în lib/audit-meta.ts", used.size >= 20 && unknown.length === 0, unknown.join(", ") || `${used.size} acțiuni folosite`);
  const unusedA = Object.keys(AUDIT_ACTIONS).filter((a) => !used.has(a));
  check("audit: fiecare acțiune din catalog este scrisă undeva (fără acțiuni moarte)", unusedA.length === 0, unusedA.join(", "));
  check("audit: fiecare acțiune are modul cunoscut, etichetă completă și etichetă scurtă", Object.entries(AUDIT_ACTIONS).every(([k, m]) => (AUDIT_MODULES as readonly string[]).includes(m.module) && m.label.length > 5 && m.short.length > 2 && /^[a-z]+\.[a-z_]+$/.test(k)));
  check("audit: gravitatea — eșecul unei acțiuni obișnuite devine «atenție»; ștergerile și drepturile sunt «atenție»; adminul nou și blocarea sunt «grave»", actionSeverity("installer.save", true) === "info" && actionSeverity("installer.save", false) === "warn" && actionSeverity("user.delete", true) === "warn" && actionSeverity("user.permissions_change", true) === "warn" && actionSeverity("user.admin_change", true) === "crit" && actionSeverity("auth.login_blocked", false) === "crit" && actionSeverity("necunoscută", true) === "info");
  const sf = sanitizeAuditFilters({ user: "507f1f77bcf86cd799439011", module: "users", action: "user.delete", severity: "warn", status: "fail", from: "2026-11-01", to: "2026-11-30", q: "  orhei  ", changes: "1", evil: "x" });
  check("audit: filtrele valide trec, cele nevalide dispar (id care nu e hex, modul / acțiune necunoscute, dată greșită)", sf.user === "507f1f77bcf86cd799439011" && sf.module === "users" && sf.action === "user.delete" && sf.severity === "warn" && sf.status === "fail" && sf.q === "orhei" && sf.changes && !("evil" in sf) && countAuditFilters(sf) === 8 && JSON.stringify(sanitizeAuditFilters({ user: "x", module: "nimic", action: "A B", severity: "x", status: "x", from: "31.12.2026", to: "2026-13-45" })) === JSON.stringify(EMPTY_AUDIT_FILTERS));
  check("audit: filtrele ↔ adresă (dus-întors)", JSON.stringify(sanitizeAuditFilters(Object.fromEntries(auditFiltersToParams(sf).entries()))) === JSON.stringify(sf) && auditFiltersToParams(EMPTY_AUDIT_FILTERS).toString() === "");
  const ch = diffFields({ ContorNr: "12", Aragaz: false, latitude: 47.1, Comments: "" }, { ContorNr: "13", Aragaz: true, latitude: 47.1, Comments: "" }, INSTALLER_SPEC);
  check("audit: compararea — doar câmpurile schimbate, cu valori citibile (da / nu), nimic la valori egale sau lipsă", ch.length === 2 && ch[0].label === "Contor nr." && ch[0].old === "12" && ch[0].new === "13" && ch[1].old === "Nu" && ch[1].new === "Da" && diffFields({ a: 1 }, { a: 1 }, [{ key: "a", label: "A" }]).length === 0 && diffFields({ a: 1 }, {}, [{ key: "a", label: "A" }]).length === 0 && diffFields(null, { ContorNr: "5" }, INSTALLER_SPEC)[0].old === null);
  check("audit: gol / spații / liste / boolean la formatare", fmtAuditValue("  ") === null && fmtAuditValue(null) === null && fmtAuditValue([1, "b", null]) === "1, b, —" && fmtAuditValue(true) === "Da" && fmtAuditValue(Number.NaN) === null && ANTENNA_SPEC.every((s) => s.label));
  const aa = { perms: { reports: ["view"] as ("view")[], meters: ["view"] as ("view")[] }, allZones: false, branches: ["05"], cities: [] as string[] };
  const bb = { perms: { reports: ["view", "edit", "export"] as ("view" | "edit" | "export")[], billing: ["view"] as ("view")[] }, allZones: true, branches: [] as string[], cities: [] as string[] };
  const da = diffAccess(aa, bb), db0 = diffAccess(null, bb);
  check("audit: drepturile — pe pagină (veche → nouă), «Toate filialele» și zona; fără schimbări ⇒ nimic", da.find((c) => c.label === "Pagină: Rapoarte (facturare)")?.new === "vizualizare, editare, descărcare" && da.find((c) => c.label === "Pagină: Contoare, hartă și grafice")?.new === null && da.find((c) => c.field === "allZones")?.new === "Da" && da.some((c) => c.field === "zone" && /05/.test(c.old ?? "")) && diffAccess(aa, aa).length === 0 && db0.every((c) => c.old === null || c.field === "allZones"));
  check("audit: rezumatul într-un rând taie valorile lungi și arată câte mai sunt", summarizeChanges([{ field: "a", label: "A", old: "x", new: "y" }])! === "A x → y" && summarizeChanges(Array.from({ length: 5 }, (_, i) => ({ field: "f" + i, label: "F" + i, old: null, new: "z".repeat(40) })))!.endsWith("(+3)") && summarizeChanges([]) === null);
  check("audit: user-agent — browser, sistem, dispozitiv", describeAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Edg/124.0")?.browser === "Edge 124" && describeAgent("Mozilla/5.0 (Linux; Android 14; Pixel 7) Mobile Chrome/120.0")?.device === "telefon" && describeAgent("") === null);
  // jurnalul nu păstrează secrete: nicio valoare de parolă / cheie nu intră în apelurile de scriere
  const callSites = src.flatMap((f) => readFileSync(f, "utf8").split("\n").filter((l) => /logAudit(Once)?\(/.test(l)).map((l) => [f, l] as const));
  const leaks = callSites.filter(([, l]) => /\b(appKey|nwkSKey|appSKey|passwordHash|body\.password|\.password\b|token\b)/.test(l.slice(l.indexOf("logAudit")).replace(/"[^"]*"/g, "")));
  check("audit: apelurile de scriere în jurnal nu primesc parole, chei sau tokenuri", callSites.length >= 25 && leaks.length === 0, leaks.map(([f]) => f).join(", ") || `${callSites.length} apeluri`);
  const AUDIT_DELETE_RIGHT = !!PAGES.find((p) => p.key === "audit")?.actions.delete || !!PAGES.find((p) => p.key === "audit")?.actions.edit;
  check("audit: jurnalul nu se poate șterge din aplicație (nicio rută DELETE / deleteMany pe audit_log; păstrare doar prin TTL)", !src.some((f) => /audit/.test(f) && /deleteMany|deleteOne|drop\(/.test(readFileSync(f, "utf8"))) && readFileSync("lib/services/audit.ts", "utf8").includes("expireAfterSeconds") && !AUDIT_DELETE_RIGHT);
  check("audit: scrierea nu încetinește acțiunea (după răspuns, cu after) și nu aruncă", /after\(write\)/.test(readFileSync("lib/services/audit.ts", "utf8")) && /catch \(e\) \{\s*console\.error\("\[audit\] jurnalul nu a putut fi pregătit/.test(readFileSync("lib/services/audit.ts", "utf8")));
}

section7.then(() => section8).then(() => sectionNotify).then(() => sectionLw).then(() => {
  console.log(bad ? `\n${bad} EȘECURI` : "\nToate verificările au trecut.");
  process.exit(bad ? 1 : 0);
});
