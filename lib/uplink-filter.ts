import { ALERT_FLAGS, FLAG } from "./uplink-shared";
import type { UplinkStore } from "./uplink-store";

/**
 * Filtrarea și sortarea listei, în browser, într-o singură trecere peste vectori tipizați.
 *  - Filtrele pe dicționar (aplicație, dispozitiv, model, an) se rezolvă mai întâi pe DICȚIONAR (câteva mii de intrări), nu pe cele sute de mii de rânduri;
 *    căutarea liberă la fel: pentru fiecare cuvânt se construiește un tabel „dispozitiv potrivit / gateway potrivit / mască de tipuri”.
 *  - Filtrele cu mai multe valori (aplicație, gateway, tip, stare, DR, frecvență, port, model, an) se scriu `a|b|c` și înseamnă „oricare dintre ele” (SAU);
 *    între filtre diferite se aplică ȘI.
 *  - `order` e sortat după timp descrescător ⇒ la „ultima oră / 24 h / 7 zile” trecerea se OPREȘTE la primul rând mai vechi.
 */
export type Filters = {
  q: string;
  /** nume aplicații (a|b) */
  app: string;
  /** nume gateway-uri (a|b) */
  gw: string;
  /** tipuri de mesaj / ieType (a|b) */
  type: string;
  /** devEUI (sau nume, dacă nu are devEUI) — un singur dispozitiv */
  dev: string;
  /** stare (a|b): alert | batt | offline | button | magnet */
  flag: string;
  /** data rate (a|b): 0..5 */
  dr: string;
  /** frecvență în kHz (a|b) */
  fr: string;
  /** fPort (a|b) */
  port: string;
  /** "" | 1 (ADR activ) | 0 (ADR oprit) */
  adr: string;
  /** câte gateway-uri au auzit mesajul: "" | 1 | 2 | 3 (3 sau mai multe) */
  gn: string;
  /** modelul din nume, ex. 2154 (a|b) */
  model: string;
  /** anul din nume, ex. 2022 (a|b) */
  year: string;
  rssiMin: string;
  rssiMax: string;
  snrMin: string;
  snrMax: string;
  /** valoarea principală din mesaj (citirea) */
  valMin: string;
  valMax: string;
  fcMin: string;
  fcMax: string;
  /** "" | 1h | 24h | 7d | 30d */
  range: string;
  /** interval personalizat: "YYYY-MM-DDTHH:mm" (ora locală), are prioritate față de `range` */
  from: string;
  to: string;
};

export const NO_FILTERS: Filters = {
  q: "", app: "", gw: "", type: "", dev: "", flag: "", dr: "", fr: "", port: "", adr: "", gn: "", model: "", year: "",
  rssiMin: "", rssiMax: "", snrMin: "", snrMax: "", valMin: "", valMax: "", fcMin: "", fcMax: "", range: "", from: "", to: "",
};

export const RANGE_MS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const FLAG_MASK: Record<string, number> = { alert: ALERT_FLAGS, batt: FLAG.BATT, offline: FLAG.OFFLINE, button: FLAG.BTN, magnet: FLAG.MAG };
export const FLAG_LABELS: Record<string, string> = { alert: "Alerte (baterie / offline)", batt: "Baterie slabă", offline: "Offline", button: "Buton apăsat", magnet: "Magnet detectat" };

/** a|b|c ↔ ["a","b","c"] */
export const toList = (s: string): string[] => (s ? s.split("|").filter(Boolean) : []);
export const fromList = (a: string[]): string => a.join("|");
export const toggleIn = (s: string, v: string): string => {
  const l = toList(s);
  return fromList(l.includes(v) ? l.filter((x) => x !== v) : [...l, v]);
};

export type SortKey = "ts" | "dev" | "gw" | "rssi" | "snr" | "dr" | "fc" | "val";
export type Sort = { key: SortKey; dir: 1 | -1 };
export const DEFAULT_SORT: Sort = { key: "ts", dir: -1 };
const SORT_KEYS: SortKey[] = ["ts", "dev", "gw", "rssi", "snr", "dr", "fc", "val"];

export type FilterResult = {
  /** indecșii rândurilor care trec de filtre, în ordinea cerută */
  idx: Int32Array;
  matched: number;
  /** dispozitive distincte în rezultat */
  devices: number;
  /** rânduri cu baterie slabă / offline în rezultat */
  alerts: number;
};

/** Câte grupuri de filtre sunt active (intervalul de timp, fiecare interval numeric și fiecare listă contează câte unul). */
export function activeFilters(f: Filters): number {
  let n = 0;
  if (f.q.trim()) n++;
  for (const k of ["app", "gw", "type", "dev", "flag", "dr", "fr", "port", "adr", "gn", "model", "year"] as const) if (f[k]) n++;
  if (f.rssiMin || f.rssiMax) n++;
  if (f.snrMin || f.snrMax) n++;
  if (f.valMin || f.valMax) n++;
  if (f.fcMin || f.fcMax) n++;
  if (f.from || f.to || f.range) n++;
  return n;
}

const num = (s: string, dflt: number): number => {
  if (s === "") return dflt;
  const v = Number(s);
  return Number.isFinite(v) ? v : dflt;
};

export function runFilter(st: UplinkStore, f: Filters, sort: Sort, now: number = Date.now()): FilterResult {
  st.prepare();
  const n = st.n;
  const nd = st.dict.dev.length;
  const ng = st.dict.gw.length;
  const empty: FilterResult = { idx: new Int32Array(0), matched: 0, devices: 0, alerts: 0 };

  // — filtre pe dicționar: aplicație, dispozitiv, model, an —
  let devOk: Uint8Array | null = null;
  if (f.app || f.dev || f.model || f.year) {
    const apps = new Set(toList(f.app).map((a) => st.dict.ap.indexOf(a)));
    const models = new Set(toList(f.model));
    const years = new Set(toList(f.year));
    devOk = new Uint8Array(nd);
    for (let d = 0; d < nd; d++) {
      const e = st.dict.dev[d];
      devOk[d] =
        (!f.app || apps.has(e[2])) &&
        (!f.dev || e[1] === f.dev || e[0] === f.dev) &&
        (!f.model || models.has(st.models[st.devModel[d]])) &&
        (!f.year || years.has(st.years[st.devYear[d]]))
          ? 1
          : 0;
    }
  }
  // — gateway (listă) —
  let gwOk: Uint8Array | null = null;
  if (f.gw) {
    gwOk = new Uint8Array(ng + 1); // poziția 0 = rând fără gateway (niciodată potrivit)
    let any = false;
    for (const name of toList(f.gw)) {
      const g = st.dict.gw.indexOf(name);
      if (g >= 0) {
        gwOk[g + 1] = 1;
        any = true;
      }
    }
    if (!any) return empty;
  }
  // — tipuri de mesaj (listă ⇒ mască) —
  let tyMaskWant = 0;
  if (f.type) {
    for (const name of toList(f.type)) {
      const t = st.dict.ty.indexOf(name);
      if (t >= 0) tyMaskWant |= 1 << t;
    }
    if (tyMaskWant === 0) return empty;
  }
  let flagMask = 0;
  for (const k of toList(f.flag)) flagMask |= FLAG_MASK[k] ?? 0;
  // — DR / frecvență / port (liste) —
  let drOk: Uint8Array | null = null;
  if (f.dr) {
    drOk = new Uint8Array(17); // poziția 0 = necunoscut
    for (const v of toList(f.dr)) {
      const d = Number(v);
      if (Number.isInteger(d) && d >= 0 && d < 16) drOk[d + 1] = 1;
    }
  }
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
  const adrNeed = f.adr === "1" ? 1 : f.adr === "0" ? 2 : 0;
  const gnMin = f.gn ? Number(f.gn) || 0 : 0;
  const gnMax = f.gn === "3" ? 255 : f.gn ? Number(f.gn) || 255 : 255;
  // — intervale numerice (rândurile fără valoare nu trec când intervalul e activ) —
  const rMin = num(f.rssiMin, -Infinity), rMax = num(f.rssiMax, Infinity), rOn = rMin > -Infinity || rMax < Infinity;
  const sMin = num(f.snrMin, -Infinity), sMax = num(f.snrMax, Infinity), sOn = sMin > -Infinity || sMax < Infinity;
  const vMin = num(f.valMin, -Infinity), vMax = num(f.valMax, Infinity), vOn = vMin > -Infinity || vMax < Infinity;
  const cMin = num(f.fcMin, -Infinity), cMax = num(f.fcMax, Infinity), cOn = cMin > -Infinity || cMax < Infinity;

  // — interval de timp —
  let from = -Infinity;
  let to = Infinity;
  if (f.from || f.to) {
    const a = f.from ? Date.parse(f.from) : NaN;
    const b = f.to ? Date.parse(f.to) : NaN;
    if (a === a) from = a;
    if (b === b) to = b;
  } else if (f.range && RANGE_MS[f.range]) from = now - RANGE_MS[f.range];

  // — căutare liberă: câte un tabel pe cuvânt (toate cuvintele trebuie să se potrivească) —
  const words = f.q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 6);
  const nw = words.length;
  const devM: Uint8Array[] = [];
  const gwM: Uint8Array[] = [];
  const tyM = new Int32Array(nw);
  const numV = new Float64Array(nw);
  for (let w = 0; w < nw; w++) {
    const word = words[w];
    const dm = new Uint8Array(nd);
    for (let d = 0; d < nd; d++) if (st.lcDev[d].includes(word)) dm[d] = 1;
    const gm = new Uint8Array(ng + 1);
    for (let g = 0; g < ng; g++) if (st.lcGw[g].includes(word)) gm[g + 1] = 1;
    let tm = 0;
    for (let t = 0; t < st.lcTy.length; t++) if (st.lcTy[t].includes(word)) tm |= 1 << t;
    devM.push(dm);
    gwM.push(gm);
    tyM[w] = tm;
    numV[w] = /^-?\d+(\.\d+)?$/.test(word) ? Number(word) : NaN;
  }

  const { order, ts, dev, gw, tm, fl, fc, pt, val, dr, rssi, snr, fr, gn } = st;
  const out = new Int32Array(n);
  const seen = new Uint8Array(nd);
  let c = 0;
  let devices = 0;
  let alerts = 0;
  for (let k = 0; k < n; k++) {
    const i = order[k];
    const t = ts[i];
    if (t < from) break; // `order` e descrescător după timp: restul sunt și mai vechi
    if (t > to) continue;
    const d = dev[i];
    if (devOk !== null && devOk[d] === 0) continue;
    if (gwOk !== null && gwOk[gw[i] + 1] === 0) continue;
    if (tyMaskWant !== 0 && (tm[i] & tyMaskWant) === 0) continue;
    const flags = fl[i];
    if (flagMask !== 0 && (flags & flagMask) === 0) continue;
    if (adrNeed !== 0 && (adrNeed === 1) !== ((flags & FLAG.ADR) !== 0)) continue;
    if (drOk !== null && drOk[dr[i] + 1] === 0) continue;
    if (frOk !== null && frOk[((fr[i] / 100) + 0.5) | 0] === 0) continue;
    if (ptOk !== null && ptOk[pt[i] + 1] === 0) continue;
    if (gnMin !== 0 || gnMax !== 255) {
      const g = gn[i];
      if (g < gnMin || g > gnMax) continue;
    }
    if (rOn) { const v = rssi[i]; if (v !== v || v < rMin || v > rMax) continue; }
    if (sOn) { const v = snr[i]; if (v !== v || v < sMin || v > sMax) continue; }
    if (vOn) { const v = val[i]; if (v !== v || v < vMin || v > vMax) continue; }
    if (cOn) { const v = fc[i]; if (v < 0 || v < cMin || v > cMax) continue; }
    if (nw > 0) {
      let ok = true;
      for (let w = 0; w < nw; w++) {
        const nv = numV[w];
        if (devM[w][d] === 1 || gwM[w][gw[i] + 1] === 1 || (tm[i] & tyM[w]) !== 0) continue;
        if (nv === nv && (fc[i] === nv || pt[i] === nv || val[i] === nv || dr[i] === nv)) continue;
        ok = false;
        break;
      }
      if (!ok) continue;
    }
    out[c++] = i;
    if (seen[d] === 0) {
      seen[d] = 1;
      devices++;
    }
    if ((flags & ALERT_FLAGS) !== 0) alerts++;
  }

  let idx: Int32Array = out.subarray(0, c);
  if (sort.key === "ts") {
    if (sort.dir === 1) idx = idx.slice().reverse();
  } else {
    idx = sortIdx(st, idx.slice(), sort);
  }
  return { idx, matched: c, devices, alerts };
}

/** Sortare după o coloană; valorile lipsă (NaN) rămân mereu la sfârșit, indiferent de sens. Egalitățile păstrează ordinea de timp (sortare stabilă). */
function sortIdx(st: UplinkStore, idx: Int32Array, sort: Sort): Int32Array {
  const dir = sort.dir;
  let key: (i: number) => number;
  switch (sort.key) {
    case "dev": {
      const r = st.rankDev!, dv = st.dev;
      key = (i) => r[dv[i]];
      break;
    }
    case "gw": {
      const r = st.rankGw!, g = st.gw;
      key = (i) => (g[i] < 0 ? NaN : r[g[i]]);
      break;
    }
    case "rssi": key = (i) => st.rssi[i]; break;
    case "snr": key = (i) => st.snr[i]; break;
    case "dr": key = (i) => (st.dr[i] < 0 ? NaN : st.dr[i]); break;
    case "fc": key = (i) => (st.fc[i] < 0 ? NaN : st.fc[i]); break;
    default: key = (i) => st.val[i];
  }
  return idx.sort((a, b) => {
    const x = key(a),
      y = key(b);
    const xn = x !== x,
      yn = y !== y;
    if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
    return x === y ? 0 : x < y ? -dir : dir;
  });
}

/* ---------- starea filtrelor ↔ URL ---------- */

export function filtersFromParams(get: (k: string) => string | undefined): Filters {
  const s = (k: string, max = 200) => (get(k) ?? "").slice(0, max);
  const numeric = (k: string) => (/^-?\d+(\.\d+)?$/.test(s(k, 24)) ? s(k, 24) : "");
  const range = s("range", 4);
  const flags = toList(s("flag", 80)).filter((x) => x in FLAG_MASK);
  return {
    q: s("q"),
    app: s("app", 400),
    gw: s("gw", 600),
    type: s("type", 400),
    dev: s("dev"),
    flag: fromList(flags),
    dr: fromList(toList(s("dr", 40)).filter((x) => /^\d+$/.test(x))),
    fr: fromList(toList(s("fr", 80)).filter((x) => /^\d+$/.test(x))),
    port: fromList(toList(s("port", 80)).filter((x) => /^\d+$/.test(x))),
    adr: s("adr", 1) === "1" ? "1" : s("adr", 1) === "0" ? "0" : "",
    gn: ["1", "2", "3"].includes(s("gn", 1)) ? s("gn", 1) : "",
    model: s("model", 80),
    year: s("year", 80),
    rssiMin: numeric("rssiMin"),
    rssiMax: numeric("rssiMax"),
    snrMin: numeric("snrMin"),
    snrMax: numeric("snrMax"),
    valMin: numeric("valMin"),
    valMax: numeric("valMax"),
    fcMin: numeric("fcMin"),
    fcMax: numeric("fcMax"),
    range: RANGE_MS[range] ? range : "",
    from: s("from", 16),
    to: s("to", 16),
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
export function describeFilters(f: Filters): ActiveChip[] {
  const chips: ActiveChip[] = [];
  const add = (id: string, label: string, clear: Partial<Filters>) => chips.push({ id, label, clear });
  const join = (l: string[]) => (l.length > 3 ? `${l.slice(0, 3).join(", ")} +${l.length - 3}` : l.join(", "));
  const range = (a: string, b: string, unit = "") => (a && b ? `${a} … ${b}${unit}` : a ? `≥ ${a}${unit}` : `≤ ${b}${unit}`);
  if (f.q.trim()) add("q", `Căutare: „${f.q.trim()}”`, { q: "" });
  if (f.app) add("app", `Aplicație: ${join(toList(f.app))}`, { app: "" });
  if (f.gw) add("gw", `Gateway: ${join(toList(f.gw))}`, { gw: "" });
  if (f.type) add("type", `Tip: ${join(toList(f.type))}`, { type: "" });
  if (f.dev) add("dev", `Dispozitiv: ${f.dev}`, { dev: "" });
  if (f.flag) add("flag", `Stare: ${join(toList(f.flag).map((x) => FLAG_LABELS[x] ?? x))}`, { flag: "" });
  if (f.dr) add("dr", `DR: ${join(toList(f.dr))}`, { dr: "" });
  if (f.fr) add("fr", `Frecvență: ${join(toList(f.fr).map((x) => `${(Number(x) / 1000).toFixed(1)} MHz`))}`, { fr: "" });
  if (f.port) add("port", `Port: ${join(toList(f.port))}`, { port: "" });
  if (f.adr) add("adr", f.adr === "1" ? "ADR activ" : "ADR oprit", { adr: "" });
  if (f.gn) add("gn", f.gn === "3" ? "3+ gateway-uri" : `${f.gn} gateway`, { gn: "" });
  if (f.model) add("model", `Model: ${join(toList(f.model))}`, { model: "" });
  if (f.year) add("year", `An: ${join(toList(f.year))}`, { year: "" });
  if (f.rssiMin || f.rssiMax) add("rssi", `RSSI: ${range(f.rssiMin, f.rssiMax, " dBm")}`, { rssiMin: "", rssiMax: "" });
  if (f.snrMin || f.snrMax) add("snr", `SNR: ${range(f.snrMin, f.snrMax, " dB")}`, { snrMin: "", snrMax: "" });
  if (f.valMin || f.valMax) add("val", `Valoare: ${range(f.valMin, f.valMax)}`, { valMin: "", valMax: "" });
  if (f.fcMin || f.fcMax) add("fc", `fCnt: ${range(f.fcMin, f.fcMax)}`, { fcMin: "", fcMax: "" });
  if (f.from || f.to) add("time", `Perioadă: ${(f.from || "…").replace("T", " ")} → ${(f.to || "…").replace("T", " ")}`, { from: "", to: "" });
  else if (f.range) add("time", `Perioadă: ${({ "1h": "ultima oră", "24h": "24 ore", "7d": "7 zile", "30d": "30 zile" } as Record<string, string>)[f.range] ?? f.range}`, { range: "" });
  return chips;
}
