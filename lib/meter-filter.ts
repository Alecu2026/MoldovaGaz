import { DEFECT_PROFILE } from "./meter-scope";
import { ALERT_FLAGS, FLAG, activityOf, isStatusOk } from "./meter-shared";
import type { MeterStore } from "./meter-store";

/**
 * Filtrarea și sortarea listei de contoare, în browser, într-o singură trecere peste vectori tipizați.
 *  - Filtrele cu mai multe valori (aplicație, concentrator, tip, stare, filială, oraș, profil, frecvență, port, model, an) se scriu `a|b|c` și înseamnă
 *    „oricare dintre ele” (SAU); între filtre diferite se aplică ȘI. Valorile se transformă întâi în tabele pe dicționar (câteva zeci / sute de intrări).
 *  - `order` e sortat după ultima citire descrescător ⇒ la „ultima oră / 24 h / 7 zile” trecerea se OPREȘTE la primul rând mai vechi.
 *  - Căutarea liberă: fiecare cuvânt trebuie să apară în numele contorului, devEUI, număr radio, cont, adresă sau consumator (text precalculat în litere mici),
 *    sau în numele concentratorului / tipului de mesaj.
 */
export type Filters = {
  q: string;
  /** doar în numele sau devEUI-ul contorului (filtrul din antetul coloanei „Contor”) */
  name: string;
  app: string;
  gw: string;
  type: string;
  /** un singur contor: id, devEUI sau nume */
  dev: string;
  /** stare (a|b): alert | batt | button | magnet | inactive | active (active = true în SCADA) | dup (seria se repetă) | ok (raport de stare fără probleme) | nostatus (fără raport) */
  flag: string;
  /** filiala (a|b), ex. „05 · Comrat” */
  branch: string;
  city: string;
  /** profilul de dispozitiv (a|b), ex. Comrat_Gas_Meter_DP */
  profile: string;
  /** frecvență în kHz (a|b) */
  fr: string;
  port: string;
  model: string;
  year: string;
  /** "" | 1 (legat de facturare) | 0 (fără facturare) */
  billed: string;
  /** coordonate GPS: "" | 1 (are) | 0 (nu are) */
  geo: string;
  /** contoare marcate „Defectate_*” în SCADA (după profil): "" | 1 (doar ele) | 0 (fără ele) */
  defect: string;
  /** treapta de activitate (a|b), după momentul ultimei citiri: act (< 24 h, verde) | warn (1–7 zile, galben) | crit (> 7 zile, roșu) | noact (fără citire) */
  band: string;
  /** atributul `active` din SCADA: "" | 1 (activ) | 0 (inactiv) */
  actv: string;
  /** lastActivityTime din SCADA (ultima activitate văzută de platformă): interval "YYYY-MM-DDTHH:mm" (ora locală) */
  acFrom: string; acTo: string;
  /** inactivityAlarmTime din SCADA (momentul alarmei de inactivitate): interval, și "" | 1 (are alarmă) | 0 (nu are) */
  iaFrom: string; iaTo: string; iaHas: string;
  rssiMin: string; rssiMax: string;
  snrMin: string; snrMax: string;
  /** Volume (m3) */
  valMin: string; valMax: string;
  /** baterie, % */
  batMin: string; batMax: string;
  /** consum zilnic, litri */
  dcMin: string; dcMax: string;
  fcMin: string; fcMax: string;
  /** "" | 1h | 24h | 7d | 30d  (după ultima citire) */
  range: string;
  /** interval personalizat: "YYYY-MM-DDTHH:mm" (ora locală), are prioritate față de `range` */
  from: string;
  to: string;
};

export const NO_FILTERS: Filters = {
  q: "", name: "", app: "", gw: "", type: "", dev: "", flag: "", branch: "", city: "", profile: "", fr: "", port: "", model: "", year: "", billed: "", geo: "", defect: "", band: "", actv: "", acFrom: "", acTo: "", iaFrom: "", iaTo: "", iaHas: "",
  rssiMin: "", rssiMax: "", snrMin: "", snrMax: "", valMin: "", valMax: "", batMin: "", batMax: "", dcMin: "", dcMax: "", fcMin: "", fcMax: "",
  range: "", from: "", to: "",
};

export const RANGE_MS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const FLAG_MASK: Record<string, number> = { alert: ALERT_FLAGS, batt: FLAG.BATT, button: FLAG.BTN, magnet: FLAG.MAG, inactive: FLAG.INACTIVE, active: FLAG.ACTIVE, dup: FLAG.DUP };
export const FLAG_LABELS: Record<string, string> = {
  alert: "Alerte (baterie slabă / inactiv)", batt: "Baterie slabă", active: "Marcat activ în SCADA (active = true)", button: "Buton apăsat", magnet: "Magnet detectat", inactive: "Inactiv în SCADA", dup: "Serie repetată", ok: "OK (raport de stare fără probleme)", nostatus: "Fără raport de stare",
  act: "Activ (citire în ultimele 24 h)", warn: "Avertizare (1–7 zile fără citire)", crit: "Critic (peste 7 zile fără citire)", noact: "Fără nicio citire",
};
/** Treptele de activitate (token → bitul treptei, vezi activityOf). */
export const ACT_TOKENS: Record<string, number> = { act: 1, warn: 2, crit: 4, noact: 8 };

/** a|b|c ↔ ["a","b","c"] */
export const toList = (s: string): string[] => (s ? s.split("|").filter(Boolean) : []);
export const fromList = (a: string[]): string => a.join("|");
export const toggleIn = (s: string, v: string): string => {
  const l = toList(s);
  return fromList(l.includes(v) ? l.filter((x) => x !== v) : [...l, v]);
};

export type SortKey = "ts" | "dev" | "br" | "gw" | "rssi" | "snr" | "val" | "bat" | "dc" | "fc";
export type Sort = { key: SortKey; dir: 1 | -1 };
export const DEFAULT_SORT: Sort = { key: "ts", dir: -1 };
const SORT_KEYS: SortKey[] = ["ts", "dev", "br", "gw", "rssi", "snr", "val", "bat", "dc", "fc"];

export type FilterResult = {
  /** indecșii rândurilor care trec de filtre, în ordinea cerută */
  idx: Int32Array;
  matched: number;
  /** rânduri cu baterie slabă / offline în rezultat */
  alerts: number;
  /** suma Volume (m3) a rândurilor din rezultat (doar valorile ≥ 0) */
  volume: number;
  /** consumul din perioada CURENTĂ (litri), cum îl raportează contoarele în SCADA: ziua calendaristică / luna calendaristică, și câte contoare au raportat */
  consDay: number; consDayN: number; consMonth: number; consMonthN: number;
};

const LIST_KEYS = ["app", "gw", "type", "dev", "flag", "branch", "city", "profile", "fr", "port", "model", "year", "billed", "geo", "defect", "iaHas", "band", "actv"] as const;
/** Câte grupuri de filtre sunt active (intervalul de timp și fiecare interval numeric contează câte unul). */
export function activeFilters(f: Filters): number {
  let n = 0;
  if (f.q.trim()) n++;
  if (f.name.trim()) n++;
  for (const k of LIST_KEYS) if (f[k]) n++;
  for (const [a, b] of [["rssiMin", "rssiMax"], ["snrMin", "snrMax"], ["valMin", "valMax"], ["batMin", "batMax"], ["dcMin", "dcMax"], ["fcMin", "fcMax"], ["acFrom", "acTo"], ["iaFrom", "iaTo"]] as const) if (f[a] || f[b]) n++;
  if (f.from || f.to || f.range) n++;
  return n;
}

const num = (s: string, dflt: number): number => {
  if (s === "") return dflt;
  const v = Number(s);
  return Number.isFinite(v) ? v : dflt;
};

/** Tabel „intrare de dicționar potrivită” pentru o listă de nume; null = filtru inactiv. `any` = false ⇒ nicio valoare cunoscută ⇒ rezultat gol. */
function dictSet(selected: string, dict: string[]): { ok: Uint8Array | null; any: boolean } {
  if (!selected) return { ok: null, any: true };
  const ok = new Uint8Array(dict.length + 1); // poziția 0 = „necunoscut” (index -1): niciodată potrivit
  let any = false;
  for (const name of toList(selected)) {
    const k = dict.indexOf(name);
    if (k >= 0) { ok[k + 1] = 1; any = true; }
  }
  return { ok, any };
}

/** Începutul zilei / lunii curente, ca în SCADA (momentul la care e înscris consumul): miezul nopții (UTC) al datei locale, respectiv prima zi a lunii. */
export function periodStarts(now: number): { dayStart: number; monthStart: number } {
  const d = new Date(now);
  return { dayStart: Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()), monthStart: Date.UTC(d.getFullYear(), d.getMonth(), 1) };
}

export function runFilter(st: MeterStore, f: Filters, sort: Sort, now: number = Date.now()): FilterResult {
  st.prepare();
  const n = st.n;
  const empty: FilterResult = { idx: new Int32Array(0), matched: 0, alerts: 0, volume: 0, consDay: 0, consDayN: 0, consMonth: 0, consMonthN: 0 };

  const app = dictSet(f.app, st.dict.ap), gwS = dictSet(f.gw, st.dict.gw), br = dictSet(f.branch, st.dict.br), ct = dictSet(f.city, st.dict.ct), pf = dictSet(f.profile, st.dict.pf);
  if (!app.any || !gwS.any || !br.any || !ct.any || !pf.any) return empty;
  const modelSet = f.model ? new Set(toList(f.model)) : null;
  const yearSet = f.year ? new Set(toList(f.year)) : null;
  const modelOk = modelSet ? Uint8Array.from(st.models, (m) => (modelSet.has(m) ? 1 : 0)) : null;
  const yearOk = yearSet ? Uint8Array.from(st.years, (y) => (yearSet.has(y) ? 1 : 0)) : null;

  let tyMaskWant = 0;
  if (f.type) {
    for (const name of toList(f.type)) {
      const t = st.dict.ty.indexOf(name);
      if (t >= 0) tyMaskWant |= 1 << t;
    }
    if (tyMaskWant === 0) return empty;
  }
  let flagMask = 0;
  let wantOk = false, wantNoStatus = false, actWant = 0;
  for (const k of toList(f.flag)) {
    flagMask |= FLAG_MASK[k] ?? 0;
    actWant |= ACT_TOKENS[k] ?? 0;
    if (k === "ok") wantOk = true;
    if (k === "nostatus") wantNoStatus = true;
  }
  const flagOn = flagMask !== 0 || wantOk || wantNoStatus || actWant !== 0;
  let frOk: Uint8Array | null = null;
  if (f.fr) {
    frOk = new Uint8Array(10_001);
    for (const v of toList(f.fr)) {
      const k = Math.round(Number(v) / 100);
      if (k >= 0 && k <= 10_000) frOk[k] = 1;
    }
  }
  let ptOk: Uint8Array | null = null;
  if (f.port) {
    ptOk = new Uint8Array(258);
    for (const v of toList(f.port)) {
      const p = Number(v);
      if (Number.isInteger(p) && p >= 0 && p < 256) ptOk[p + 1] = 1;
    }
  }
  const billedNeed = f.billed === "1" ? 1 : f.billed === "0" ? 2 : 0;
  const geoNeed = f.geo === "1" ? 1 : f.geo === "0" ? 2 : 0;
  const dtMs = (v: string, dflt: number): number => { if (!v) return dflt; const t = Date.parse(v); return t === t ? t : dflt; };
  const acFrom = dtMs(f.acFrom, -Infinity), acTo = dtMs(f.acTo, Infinity), acOn = acFrom > -Infinity || acTo < Infinity;
  const iaFrom = dtMs(f.iaFrom, -Infinity), iaTo = dtMs(f.iaTo, Infinity), iaOn = iaFrom > -Infinity || iaTo < Infinity;
  let bandWant = 0;
  for (const k of toList(f.band)) bandWant |= ACT_TOKENS[k] ?? 0;
  const actvNeed = f.actv === "1" ? FLAG.ACTIVE : f.actv === "0" ? FLAG.INACTIVE : 0;
  const iaNeed = f.iaHas === "1" ? 1 : f.iaHas === "0" ? 2 : 0;
  const defectNeed = f.defect === "1" ? 1 : f.defect === "0" ? 2 : 0;
  const defectPf = defectNeed !== 0 ? Uint8Array.from({ length: st.dict.pf.length + 1 }, (_, k) => (k > 0 && DEFECT_PROFILE.test(st.dict.pf[k - 1]) ? 1 : 0)) : null;
  const rMin = num(f.rssiMin, -Infinity), rMax = num(f.rssiMax, Infinity), rOn = rMin > -Infinity || rMax < Infinity;
  const sMin = num(f.snrMin, -Infinity), sMax = num(f.snrMax, Infinity), sOn = sMin > -Infinity || sMax < Infinity;
  const vMin = num(f.valMin, -Infinity), vMax = num(f.valMax, Infinity), vOn = vMin > -Infinity || vMax < Infinity;
  const bMin = num(f.batMin, -Infinity), bMax = num(f.batMax, Infinity), bOn = bMin > -Infinity || bMax < Infinity;
  const dMin = num(f.dcMin, -Infinity), dMax = num(f.dcMax, Infinity), dOn = dMin > -Infinity || dMax < Infinity;
  const cMin = num(f.fcMin, -Infinity), cMax = num(f.fcMax, Infinity), cOn = cMin > -Infinity || cMax < Infinity;

  // — interval de timp (după ultima citire) —
  let from = -Infinity;
  let to = Infinity;
  if (f.from || f.to) {
    const a = f.from ? Date.parse(f.from) : NaN;
    const b = f.to ? Date.parse(f.to) : NaN;
    if (a === a) from = a;
    if (b === b) to = b;
  } else if (f.range && RANGE_MS[f.range]) from = now - RANGE_MS[f.range];
  const timeOn = from > -Infinity || to < Infinity;

  // — căutare liberă —
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const nw = words.length;
  const gwM: Uint8Array[] = [];
  const tyM = new Int32Array(nw);
  const numV = new Float64Array(nw);
  for (let w = 0; w < nw; w++) {
    const word = words[w];
    const gm = new Uint8Array(st.dict.gw.length + 1);
    for (let g = 0; g < st.dict.gw.length; g++) if (st.lcGw[g].includes(word)) gm[g + 1] = 1;
    let tm = 0;
    for (let t = 0; t < st.lcTy.length; t++) if (st.lcTy[t].includes(word)) tm |= 1 << t;
    gwM.push(gm);
    tyM[w] = tm;
    numV[w] = /^-?\d+(\.\d+)?$/.test(word) ? Number(word) : NaN;
  }

  const nameWords = f.name.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4);
  const { order, ts, gw, tm, fl, fc, pt, val, rssi, snr, fr, bat, dc, id, eu, nm, lq, ln } = st;
  const out = new Int32Array(n);
  let c = 0, alerts = 0, volume = 0, consDay = 0, consDayN = 0, consMonth = 0, consMonthN = 0;
  const { dayStart, monthStart } = periodStarts(now);
  const { dt, mt, dc: dcv, mc: mcv } = st;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const t = ts[i];
    if (timeOn) {
      if (t < from) break; // `order` e descrescător după ultima citire: restul sunt și mai vechi
      if (t > to) continue;
    }
    if (app.ok !== null && app.ok[st.ap[i] + 1] === 0) continue;
    if (gwS.ok !== null && gwS.ok[gw[i] + 1] === 0) continue;
    if (br.ok !== null && br.ok[st.br[i] + 1] === 0) continue;
    if (ct.ok !== null && ct.ok[st.ct[i] + 1] === 0) continue;
    if (pf.ok !== null && pf.ok[st.pf[i] + 1] === 0) continue;
    if (modelOk !== null && modelOk[st.model[i]] === 0) continue;
    if (yearOk !== null && yearOk[st.year[i]] === 0) continue;
    if (tyMaskWant !== 0 && (tm[i] & tyMaskWant) === 0) continue;
    const flags = fl[i];
    // stările bifate se combină cu SAU (inclusiv „OK” și „fără raport de stare”)
    if (flagOn && !((flagMask !== 0 && (flags & flagMask) !== 0) || (wantOk && isStatusOk(flags)) || (wantNoStatus && (flags & FLAG.STATUS) === 0) || (actWant !== 0 && (actWant & (1 << activityOf(t, now))) !== 0))) continue;
    if (billedNeed !== 0 && (billedNeed === 1) !== ((flags & FLAG.BILLED) !== 0)) continue;
    if (geoNeed !== 0 && (geoNeed === 1) !== (st.la[i] === st.la[i] && st.lo[i] === st.lo[i])) continue;
    if (defectPf !== null && (defectPf[st.pf[i] + 1] === 1) !== (defectNeed === 1)) continue;
    if (bandWant !== 0 && (bandWant & (1 << activityOf(t, now))) === 0) continue;
    if (actvNeed !== 0 && (flags & actvNeed) === 0) continue;
    if (acOn && !(st.ac[i] >= acFrom && st.ac[i] <= acTo)) continue;
    if (iaOn && !(st.ia[i] >= iaFrom && st.ia[i] <= iaTo)) continue;
    if (iaNeed !== 0 && (iaNeed === 1) !== (st.ia[i] === st.ia[i])) continue;
    if (frOk !== null && frOk[((fr[i] / 100) + 0.5) | 0] === 0) continue;
    if (ptOk !== null && ptOk[pt[i] + 1] === 0) continue;
    if (nameWords.length > 0) {
      const t = ln[i];
      let ok = true;
      for (let w = 0; w < nameWords.length; w++) if (!t.includes(nameWords[w])) { ok = false; break; }
      if (!ok) continue;
    }
    if (f.dev && eu[i] !== f.dev && nm[i] !== f.dev && id[i] !== f.dev) continue;
    if (rOn) { const v = rssi[i]; if (v !== v || v < rMin || v > rMax) continue; }
    if (sOn) { const v = snr[i]; if (v !== v || v < sMin || v > sMax) continue; }
    if (vOn) { const v = val[i]; if (v !== v || v < vMin || v > vMax) continue; }
    if (bOn) { const v = bat[i]; if (v !== v || v < bMin || v > bMax) continue; }
    if (dOn) { const v = dc[i]; if (v !== v || v < dMin || v > dMax) continue; }
    if (cOn) { const v = fc[i]; if (v < 0 || v < cMin || v > cMax) continue; }
    if (nw > 0) {
      let ok = true;
      const text = lq[i];
      for (let w = 0; w < nw; w++) {
        if (text.includes(words[w]) || gwM[w][gw[i] + 1] === 1 || (tm[i] & tyM[w]) !== 0) continue;
        const nv = numV[w];
        if (nv === nv && (fc[i] === nv || val[i] === nv)) continue;
        ok = false;
        break;
      }
      if (!ok) continue;
    }
    out[c++] = i;
    if ((flags & ALERT_FLAGS) !== 0) alerts++;
    const v = val[i];
    if (v >= 0) volume += v;
    if (dt[i] === dayStart && dcv[i] >= 0) { consDay += dcv[i]; consDayN++; }
    if (mt[i] === monthStart && mcv[i] >= 0) { consMonth += mcv[i]; consMonthN++; }
  }

  let idx: Int32Array = out.subarray(0, c);
  if (sort.key === "ts") {
    if (sort.dir === 1) idx = idx.slice().reverse();
  } else {
    idx = sortIdx(st, idx.slice(), sort);
  }
  return { idx, matched: c, alerts, volume, consDay, consDayN, consMonth, consMonthN };
}

/** Sortare după o coloană; valorile lipsă (NaN) rămân mereu la sfârșit, indiferent de sens. Egalitățile păstrează ordinea de timp (sortare stabilă). */
function sortIdx(st: MeterStore, idx: Int32Array, sort: Sort): Int32Array {
  const dir = sort.dir;
  let key: (i: number) => number;
  switch (sort.key) {
    case "dev": { const r = st.ranks().nm; key = (i) => r[i]; break; }
    case "br": { const r = st.ranks().br, b = st.br; key = (i) => (b[i] < 0 ? NaN : r[b[i]]); break; }
    case "gw": { const r = st.ranks().gw, g = st.gw; key = (i) => (g[i] < 0 ? NaN : r[g[i]]); break; }
    case "rssi": key = (i) => st.rssi[i]; break;
    case "snr": key = (i) => st.snr[i]; break;
    case "bat": key = (i) => st.bat[i]; break;
    case "dc": key = (i) => st.dc[i]; break;
    case "fc": key = (i) => (st.fc[i] < 0 ? NaN : st.fc[i]); break;
    default: key = (i) => st.val[i];
  }
  return idx.sort((a, b) => {
    const x = key(a), y = key(b);
    const xn = x !== x, yn = y !== y;
    if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
    return x === y ? 0 : x < y ? -dir : dir;
  });
}

/* ---------- starea filtrelor ↔ URL ---------- */

export function filtersFromParams(get: (k: string) => string | undefined): Filters {
  const s = (k: string, max = 200) => (get(k) ?? "").slice(0, max);
  const numeric = (k: string) => (/^-?\d+(\.\d+)?$/.test(s(k, 24)) ? s(k, 24) : "");
  const digits = (k: string, max: number) => fromList(toList(s(k, max)).filter((x) => /^\d+$/.test(x)));
  const range = s("range", 4);
  return {
    q: s("q"),
    name: s("name", 80),
    app: s("app", 600), gw: s("gw", 800), type: s("type", 400), dev: s("dev", 80),
    flag: fromList(toList(s("flag", 80)).filter((x) => x in FLAG_MASK || x in ACT_TOKENS || x === "ok" || x === "nostatus")),
    band: fromList(toList(s("band", 40)).filter((x) => x in ACT_TOKENS)),
    actv: s("actv", 1) === "1" ? "1" : s("actv", 1) === "0" ? "0" : "",
    branch: s("branch", 400), city: s("city", 800), profile: s("profile", 600),
    fr: digits("fr", 80), port: digits("port", 80), model: digits("model", 80), year: digits("year", 80),
    billed: s("billed", 1) === "1" ? "1" : s("billed", 1) === "0" ? "0" : "",
    geo: s("geo", 1) === "1" ? "1" : s("geo", 1) === "0" ? "0" : "",
    defect: s("defect", 1) === "1" ? "1" : s("defect", 1) === "0" ? "0" : "",
    acFrom: s("acFrom", 16), acTo: s("acTo", 16), iaFrom: s("iaFrom", 16), iaTo: s("iaTo", 16),
    iaHas: s("iaHas", 1) === "1" ? "1" : s("iaHas", 1) === "0" ? "0" : "",
    rssiMin: numeric("rssiMin"), rssiMax: numeric("rssiMax"), snrMin: numeric("snrMin"), snrMax: numeric("snrMax"),
    valMin: numeric("valMin"), valMax: numeric("valMax"), batMin: numeric("batMin"), batMax: numeric("batMax"),
    dcMin: numeric("dcMin"), dcMax: numeric("dcMax"), fcMin: numeric("fcMin"), fcMax: numeric("fcMax"),
    range: RANGE_MS[range] ? range : "", from: s("from", 16), to: s("to", 16),
  };
}

export function sortFromParams(get: (k: string) => string | undefined): Sort {
  const key = get("sort") as SortKey | undefined;
  if (!key || !SORT_KEYS.includes(key)) return DEFAULT_SORT;
  return { key, dir: get("dir") === "asc" ? 1 : -1 };
}

export function toQuery(f: Filters, sort: Sort, extra?: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const k of Object.keys(f) as (keyof Filters)[]) if (f[k]) p.set(k, f[k]);
  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) {
    p.set("sort", sort.key);
    p.set("dir", sort.dir === 1 ? "asc" : "desc");
  }
  for (const [k, v] of Object.entries(extra ?? {})) if (v) p.set(k, v);
  return p.toString();
}

/** Filtrele active ca etichete (chips) cu ce trebuie golit ca să dispară. */
export type ActiveChip = { id: string; label: string; clear: Partial<Filters> };
export function describeFilters(f: Filters, nameOf: (id: string) => string = (x) => x): ActiveChip[] {
  const chips: ActiveChip[] = [];
  const add = (id: string, label: string, clear: Partial<Filters>) => chips.push({ id, label, clear });
  const join = (l: string[]) => (l.length > 3 ? `${l.slice(0, 3).join(", ")} +${l.length - 3}` : l.join(", "));
  const range = (a: string, b: string, unit = "") => (a && b ? `${a} … ${b}${unit}` : a ? `≥ ${a}${unit}` : `≤ ${b}${unit}`);
  if (f.name.trim()) add("name", `Contor conține: „${f.name.trim()}”`, { name: "" });
  if (f.q.trim()) add("q", `Căutare: „${f.q.trim()}”`, { q: "" });
  if (f.branch) add("branch", `Filială: ${join(toList(f.branch))}`, { branch: "" });
  if (f.city) add("city", `Oraș: ${join(toList(f.city))}`, { city: "" });
  if (f.profile) add("profile", `Profil: ${join(toList(f.profile))}`, { profile: "" });
  if (f.app) add("app", `Aplicație: ${join(toList(f.app))}`, { app: "" });
  if (f.gw) add("gw", `Concentrator: ${join(toList(f.gw))}`, { gw: "" });
  if (f.type) add("type", `Tip mesaj: ${join(toList(f.type))}`, { type: "" });
  if (f.dev) add("dev", `Contor: ${nameOf(f.dev)}`, { dev: "" });
  if (f.flag) add("flag", `Stare: ${join(toList(f.flag).map((x) => FLAG_LABELS[x] ?? x))}`, { flag: "" });
  if (f.billed) add("billed", f.billed === "1" ? "Cu facturare" : "Fără facturare", { billed: "" });
  if (f.defect) add("defect", f.defect === "1" ? "Doar „Defectate” în SCADA" : "Fără „Defectate” în SCADA", { defect: "" });
  const when = (a: string, b: string) => `${(a || "…").replace("T", " ")} → ${(b || "…").replace("T", " ")}`;
  if (f.acFrom || f.acTo) add("ac", `Ultima activitate (SCADA): ${when(f.acFrom, f.acTo)}`, { acFrom: "", acTo: "" });
  if (f.iaFrom || f.iaTo) add("ia", `Alarmă de inactivitate: ${when(f.iaFrom, f.iaTo)}`, { iaFrom: "", iaTo: "" });
  if (f.iaHas) add("iaHas", f.iaHas === "1" ? "Cu alarmă de inactivitate" : "Fără alarmă de inactivitate", { iaHas: "" });
  if (f.band) add("band", `Activitate: ${toList(f.band).map((k) => ({ act: "< 24 h", warn: "1–7 zile", crit: "> 7 zile", noact: "fără citire" } as Record<string, string>)[k] ?? k).join(" sau ")}`, { band: "" });
  if (f.actv) add("actv", f.actv === "1" ? "Activ în SCADA" : "Inactiv în SCADA", { actv: "" });
  if (f.geo) add("geo", f.geo === "1" ? "Cu coordonate GPS" : "Fără coordonate GPS", { geo: "" });
  if (f.fr) add("fr", `Frecvență: ${join(toList(f.fr).map((x) => (Number(x) === 0 ? "necunoscută" : `${(Number(x) / 1000).toFixed(1)} MHz`)))}`, { fr: "" });
  if (f.port) add("port", `Port: ${join(toList(f.port))}`, { port: "" });
  if (f.model) add("model", `Model: ${join(toList(f.model))}`, { model: "" });
  if (f.year) add("year", `An: ${join(toList(f.year))}`, { year: "" });
  if (f.valMin || f.valMax) add("val", `Volume: ${range(f.valMin, f.valMax, " m³")}`, { valMin: "", valMax: "" });
  if (f.dcMin || f.dcMax) add("dc", `Consum zilnic: ${range(f.dcMin, f.dcMax, " L")}`, { dcMin: "", dcMax: "" });
  if (f.batMin || f.batMax) add("bat", `Baterie: ${range(f.batMin, f.batMax, "%")}`, { batMin: "", batMax: "" });
  if (f.rssiMin || f.rssiMax) add("rssi", `RSSI: ${range(f.rssiMin, f.rssiMax, " dBm")}`, { rssiMin: "", rssiMax: "" });
  if (f.snrMin || f.snrMax) add("snr", `SNR: ${range(f.snrMin, f.snrMax, " dB")}`, { snrMin: "", snrMax: "" });
  if (f.fcMin || f.fcMax) add("fc", `fCnt: ${range(f.fcMin, f.fcMax)}`, { fcMin: "", fcMax: "" });
  if (f.from || f.to) add("time", `Ultima citire: ${(f.from || "…").replace("T", " ")} → ${(f.to || "…").replace("T", " ")}`, { from: "", to: "" });
  else if (f.range) add("time", `Ultima citire: ${({ "1h": "ultima oră", "24h": "24 ore", "7d": "7 zile", "30d": "30 zile" } as Record<string, string>)[f.range] ?? f.range}`, { range: "" });
  return chips;
}
