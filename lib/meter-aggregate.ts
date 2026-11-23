import { ALERT_FLAGS, FLAG, activityOf, isStatusOk } from "./meter-shared";
import { RANGE_MS, type Filters } from "./meter-filter";
import type { MeterStore } from "./meter-store";

/**
 * Agregările din spatele graficelor, calculate într-o SINGURĂ trecere peste vectorii tipizați (câțiva ms la zeci de mii de contoare).
 * Se rulează de două ori cu aceleași găleți: pe rândurile filtrate (valoarea) și pe toate (contextul gri din spatele barelor).
 * Găleții de timp și scările pentru volum / consum vin din `AggCtx`, deci cele două rulări se suprapun exact.
 */
export const RSSI_MIN = -130, RSSI_STEP = 5, RSSI_BINS = 16; // -130 … -50
export const SNR_MIN = -20, SNR_STEP = 2, SNR_BINS = 17; // -20 … +14
export const BAT_BINS = 10; // 0–10 %, … 90–100 %
export const SCALE_BINS = 16; // volum și consum zilnic: scală neliniară (rădăcină pătrată)
export const HEAT_X = 36, HEAT_Y = 32; // RSSI × SNR
export const HEAT_RSSI_MIN = -130, HEAT_RSSI_STEP = 2; // -130 … -58
export const HEAT_SNR_MIN = -20, HEAT_SNR_STEP = 1; // -20 … +12
/** pragurile „prospețimii” (vechimea ultimei citiri); ultimul interval = nicio citire */
export const FRESH_EDGES = [0, 3_600_000, 6 * 3_600_000, 24 * 3_600_000, 3 * 86_400_000, 7 * 86_400_000, Infinity];
export const FRESH_LABELS = ["< 1 oră", "1–6 ore", "6–24 ore", "1–3 zile", "3–7 zile", "> 7 zile", "niciodată"];

export type AggCtx = { tStart: number; tStep: number; tN: number; valMax: number; dcMax: number; now: number };

export type Agg = {
  n: number;
  time: Int32Array; hour: Int32Array; wday: Int32Array;
  rssi: Int32Array; rssiNone: number; snr: Int32Array; snrNone: number;
  bat: Int32Array; batNone: number;
  val: Int32Array; valNone: number; dc: Int32Array; dcNone: number;
  apps: Int32Array; gws: Int32Array; noGw: number; types: Int32Array; noTypes: number;
  brs: Int32Array; brVol: Float64Array; cts: Int32Array; pfs: Int32Array;
  freq: Int32Array; ports: Int32Array; models: Int32Array; years: Int32Array;
  fresh: Int32Array; heat: Int32Array;
  flags: { dup: number; batt: number; offline: number; button: number; magnet: number; inactive: number; alert: number; billed: number; noBilled: number; statusOk: number; noStatus: number; act: number; warn: number; crit: number; noact: number };
  /** contoarele cu cel mai mare consum zilnic: [index rând, litri] */
  topDc: [number, number][];
  sums: { rssi: number; rssiN: number; snr: number; snrN: number; val: number; valN: number; bat: number; batN: number; dc: number; dcN: number };
};

const NICE_STEPS = [60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 2 * 86_400_000, 7 * 86_400_000];

/** Găleți comune pentru ambele rulări. Intervalul de timp urmează filtrul de perioadă, dacă există; altfel tot ce e în memorie. */
/** Percentila 99,5 a valorilor ≥ 0: scara histogramelor nu e dictată de câteva valori aberante (acestea intră în ultima bară). */
function robustMax(a: ArrayLike<number>, n: number): number {
  const v = new Float64Array(n);
  let c = 0;
  for (let i = 0; i < n; i++) if (a[i] >= 0) v[c++] = a[i];
  if (c === 0) return 1;
  const s = v.subarray(0, c).sort();
  return Math.max(1, s[Math.floor(0.995 * (c - 1))]);
}

export function makeCtx(st: MeterStore, f: Filters, now: number = Date.now()): AggCtx {
  let lo = Infinity, hi = 0;
  const valMax = robustMax(st.val, st.n), dcMax = robustMax(st.dc, st.n);
  for (let i = 0; i < st.n; i++) {
    const t = st.ts[i];
    if (t > 0) { if (t < lo) lo = t; if (t > hi) hi = t; }
  }
  if (lo === Infinity) { lo = now - 86_400_000; hi = now; }
  if (f.from || f.to) {
    const a = f.from ? Date.parse(f.from) : NaN;
    const b = f.to ? Date.parse(f.to) : NaN;
    const l2 = a === a ? Math.max(lo, a) : lo;
    const h2 = b === b ? Math.min(hi, b) : hi;
    if (h2 > l2) { lo = l2; hi = h2; }
  } else if (f.range && RANGE_MS[f.range]) {
    const l2 = Math.max(lo, now - RANGE_MS[f.range]);
    if (hi > l2) lo = l2;
  }
  const span = Math.max(1, hi - lo + 1);
  const tStep = NICE_STEPS.find((s) => span / s <= 90) ?? NICE_STEPS[NICE_STEPS.length - 1];
  const tStart = Math.floor(lo / tStep) * tStep;
  const tN = Math.min(160, Math.floor((hi - tStart) / tStep) + 1);
  return { tStart, tStep, tN: Math.max(1, tN), valMax, dcMax, now };
}

export function aggregate(st: MeterStore, idx: Int32Array | null, ctx: AggCtx): Agg {
  const m = idx ? idx.length : st.n;
  const d = st.dict;
  const a: Agg = {
    n: m,
    time: new Int32Array(ctx.tN), hour: new Int32Array(24), wday: new Int32Array(7),
    rssi: new Int32Array(RSSI_BINS), rssiNone: 0, snr: new Int32Array(SNR_BINS), snrNone: 0, bat: new Int32Array(BAT_BINS), batNone: 0,
    val: new Int32Array(SCALE_BINS), valNone: 0, dc: new Int32Array(SCALE_BINS), dcNone: 0,
    apps: new Int32Array(d.ap.length), gws: new Int32Array(d.gw.length), noGw: 0, types: new Int32Array(32), noTypes: 0,
    brs: new Int32Array(d.br.length), brVol: new Float64Array(d.br.length), cts: new Int32Array(d.ct.length), pfs: new Int32Array(d.pf.length),
    freq: new Int32Array(10_001), ports: new Int32Array(258), models: new Int32Array(st.models.length), years: new Int32Array(st.years.length),
    fresh: new Int32Array(FRESH_LABELS.length), heat: new Int32Array(HEAT_X * HEAT_Y),
    flags: { dup: 0, batt: 0, offline: 0, button: 0, magnet: 0, inactive: 0, alert: 0, billed: 0, noBilled: 0, statusOk: 0, noStatus: 0, act: 0, warn: 0, crit: 0, noact: 0 },
    topDc: [], sums: { rssi: 0, rssiN: 0, snr: 0, snrN: 0, val: 0, valN: 0, bat: 0, batN: 0, dc: 0, dcN: 0 },
  };
  const { ts, gw, rssi, snr, fr, fl, pt, tm, val, bat, dc, ap, br, ct, pf, model, year } = st;
  const offCache = new Map<number, number>(); // abaterea de fus orar pe zi (ora de vară)
  const { tStart, tStep, tN, valMax, dcMax, now } = ctx;
  const tz = (t: number): number => {
    const day = Math.floor(t / 86_400_000);
    let o = offCache.get(day);
    if (o === undefined) { o = new Date(day * 86_400_000 + 43_200_000).getTimezoneOffset(); offCache.set(day, o); }
    return o;
  };
  const top: [number, number][] = [];

  for (let k = 0; k < m; k++) {
    const i = idx ? idx[k] : k;
    const t = ts[i];
    if (t > 0) {
      const b = Math.floor((t - tStart) / tStep);
      if (b >= 0 && b < tN) a.time[b]++;
      const local = t - tz(t) * 60_000;
      a.hour[((Math.floor(local / 3_600_000) % 24) + 24) % 24]++;
      a.wday[(((Math.floor(local / 86_400_000) + 3) % 7) + 7) % 7]++; // luni = 0 (1 ian 1970 = joi)
      const age = Math.max(0, now - t);
      let q = 0;
      while (q < 5 && age >= FRESH_EDGES[q + 1]) q++;
      a.fresh[q]++;
    } else a.fresh[6]++;

    const r = rssi[i], s = snr[i];
    if (r === r) { a.sums.rssi += r; a.sums.rssiN++; a.rssi[Math.max(0, Math.min(RSSI_BINS - 1, Math.floor((r - RSSI_MIN) / RSSI_STEP)))]++; } else a.rssiNone++;
    if (s === s) { a.sums.snr += s; a.sums.snrN++; a.snr[Math.max(0, Math.min(SNR_BINS - 1, Math.floor((s - SNR_MIN) / SNR_STEP)))]++; } else a.snrNone++;
    if (r === r && s === s) {
      const x = Math.floor((r - HEAT_RSSI_MIN) / HEAT_RSSI_STEP), y = Math.floor((s - HEAT_SNR_MIN) / HEAT_SNR_STEP);
      if (x >= 0 && x < HEAT_X && y >= 0 && y < HEAT_Y) a.heat[y * HEAT_X + x]++;
    }
    const b = bat[i];
    if (b === b) { a.sums.bat += b; a.sums.batN++; a.bat[Math.max(0, Math.min(BAT_BINS - 1, Math.floor(b / 10)))]++; } else a.batNone++;
    const v = val[i];
    if (v === v && v >= 0) { a.sums.val += v; a.sums.valN++; a.val[Math.min(SCALE_BINS - 1, Math.floor(SCALE_BINS * Math.sqrt(v / valMax)))]++; } else a.valNone++; // fără citire sau negativă
    const c = dc[i];
    if (c === c && c >= 0) {
      a.sums.dc += c; a.sums.dcN++; a.dc[Math.min(SCALE_BINS - 1, Math.floor(SCALE_BINS * Math.sqrt(c / dcMax)))]++;
      if (top.length < 10 || c > top[top.length - 1][1]) {
        let p = top.length;
        while (p > 0 && top[p - 1][1] < c) p--;
        top.splice(p, 0, [i, c]);
        if (top.length > 10) top.pop();
      }
    } else a.dcNone++;

    if (ap[i] >= 0) a.apps[ap[i]]++;
    if (gw[i] >= 0) a.gws[gw[i]]++; else a.noGw++;
    if (br[i] >= 0) { a.brs[br[i]]++; if (v === v && v >= 0) a.brVol[br[i]] += v; }
    if (ct[i] >= 0) a.cts[ct[i]]++;
    if (pf[i] >= 0) a.pfs[pf[i]]++;
    a.models[model[i]]++;
    a.years[year[i]]++;
    const mask = tm[i];
    if (mask === 0) a.noTypes++;
    else for (let q = 0; q < 32; q++) if (mask & (1 << q)) a.types[q]++;
    a.freq[((fr[i] / 100) + 0.5) | 0]++;
    a.ports[pt[i] + 1]++;

    const f = fl[i];
    if (f & FLAG.DUP) a.flags.dup++;
    if (f & FLAG.BATT) a.flags.batt++;
    if (f & FLAG.OFFLINE) a.flags.offline++;
    if (f & FLAG.BTN) a.flags.button++;
    if (f & FLAG.MAG) a.flags.magnet++;
    if (f & FLAG.INACTIVE) a.flags.inactive++;
    if (f & ALERT_FLAGS) a.flags.alert++;
    if (f & FLAG.BILLED) a.flags.billed++; else a.flags.noBilled++;
    if (isStatusOk(f)) a.flags.statusOk++;
    if (!(f & FLAG.STATUS)) a.flags.noStatus++;
    const act = activityOf(ts[i], now);
    if (act === 0) a.flags.act++; else if (act === 1) a.flags.warn++; else if (act === 2) a.flags.crit++; else a.flags.noact++;
  }
  a.topDc = top;
  return a;
}
