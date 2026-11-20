import { ALERT_FLAGS, FLAG } from "./uplink-shared";
import type { UplinkStore } from "./uplink-store";

/**
 * Filtrarea și sortarea listei, în browser, într-o singură trecere peste vectorii tipizați.
 *  - Căutarea liberă se rezolvă mai întâi pe DICȚIONAR (câteva mii de dispozitive / gateway-uri), nu pe cele sute de mii de rânduri: pentru fiecare cuvânt
 *    se construiește un tabel „dispozitiv potrivit / gateway potrivit / mască de tipuri”, iar un rând se verifică doar cu căutări în tablouri.
 *  - `order` e sortat după timp descrescător ⇒ la „ultima oră / 24 h / 7 zile” trecerea se OPREȘTE la primul rând mai vechi.
 */
export type Filters = {
  q: string;
  /** numele aplicației */
  app: string;
  /** numele gateway-ului */
  gw: string;
  /** tipul mesajului (ieType) */
  type: string;
  /** devEUI (sau nume, dacă nu are devEUI) */
  dev: string;
  /** "" | alert | batt | offline | button | magnet */
  flag: string;
  /** "" | 1h | 24h | 7d | 30d */
  range: string;
  /** interval personalizat: "YYYY-MM-DDTHH:mm" (ora locală), are prioritate față de `range` */
  from: string;
  to: string;
};

export const NO_FILTERS: Filters = { q: "", app: "", gw: "", type: "", dev: "", flag: "", range: "", from: "", to: "" };

export const RANGE_MS: Record<string, number> = { "1h": 3_600_000, "24h": 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const FLAG_MASK: Record<string, number> = { alert: ALERT_FLAGS, batt: FLAG.BATT, offline: FLAG.OFFLINE, button: FLAG.BTN, magnet: FLAG.MAG };

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

export function activeFilters(f: Filters): number {
  let n = 0;
  if (f.q.trim()) n++;
  if (f.app) n++;
  if (f.gw) n++;
  if (f.type) n++;
  if (f.dev) n++;
  if (f.flag) n++;
  if (f.from || f.to || f.range) n++;
  return n;
}

export function runFilter(st: UplinkStore, f: Filters, sort: Sort, now: number = Date.now()): FilterResult {
  st.prepare();
  const n = st.n;
  const nd = st.dict.dev.length;
  const ng = st.dict.gw.length;
  const empty: FilterResult = { idx: new Int32Array(0), matched: 0, devices: 0, alerts: 0 };

  // — filtre pe dicționar: aplicație + dispozitiv —
  let devOk: Uint8Array | null = null;
  if (f.app || f.dev) {
    const appIdx = f.app ? st.dict.ap.indexOf(f.app) : -2;
    devOk = new Uint8Array(nd);
    for (let d = 0; d < nd; d++) {
      const e = st.dict.dev[d];
      devOk[d] = (!f.app || e[2] === appIdx) && (!f.dev || e[1] === f.dev || e[0] === f.dev) ? 1 : 0;
    }
  }
  const gwOn = !!f.gw;
  const gwWant = gwOn ? st.dict.gw.indexOf(f.gw) : -1;
  if (gwOn && gwWant < 0) return empty;
  const tyOn = !!f.type;
  const tyIdx = tyOn ? st.dict.ty.indexOf(f.type) : -1;
  if (tyOn && tyIdx < 0) return empty;
  const tyMaskWant = tyOn ? 1 << tyIdx : 0;
  const flagMask = f.flag ? FLAG_MASK[f.flag] ?? 0 : 0;

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
    const gm = new Uint8Array(ng + 1); // poziția 0 = rând fără gateway
    for (let g = 0; g < ng; g++) if (st.lcGw[g].includes(word)) gm[g + 1] = 1;
    let tm = 0;
    for (let t = 0; t < st.lcTy.length; t++) if (st.lcTy[t].includes(word)) tm |= 1 << t;
    devM.push(dm);
    gwM.push(gm);
    tyM[w] = tm;
    numV[w] = /^-?\d+(\.\d+)?$/.test(word) ? Number(word) : NaN;
  }

  const { order, ts, dev, gw, tm, fl, fc, pt, val, dr } = st;
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
    if (gwOn && gw[i] !== gwWant) continue;
    if (tyOn && (tm[i] & tyMaskWant) === 0) continue;
    const flags = fl[i];
    if (flagMask !== 0 && (flags & flagMask) === 0) continue;
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
  const range = s("range", 4);
  return {
    q: s("q"),
    app: s("app"),
    gw: s("gw"),
    type: s("type"),
    dev: s("dev"),
    flag: FLAG_MASK[s("flag", 10)] ? s("flag", 10) : "",
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

export function toQuery(f: Filters, sort: Sort): string {
  const p = new URLSearchParams();
  for (const k of Object.keys(f) as (keyof Filters)[]) if (f[k]) p.set(k, f[k]);
  if (sort.key !== DEFAULT_SORT.key || sort.dir !== DEFAULT_SORT.dir) {
    p.set("sort", sort.key);
    p.set("dir", sort.dir === 1 ? "asc" : "desc");
  }
  return p.toString();
}
