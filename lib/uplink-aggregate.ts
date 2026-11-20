import { ALERT_FLAGS, FLAG } from "./uplink-shared";
import { RANGE_MS, type Filters } from "./uplink-filter";
import type { UplinkStore } from "./uplink-store";

/**
 * Agregările din spatele graficelor, calculate într-o SINGURĂ trecere peste vectorii tipizați (câțiva ms la 300.000 de rânduri).
 * Se rulează de două ori cu aceleași găleți: pe rândurile filtrate (valoarea) și pe toate (contextul gri din spatele barelor).
 * Găleții de timp, de RSSI / SNR / valoare vin din `AggCtx`, deci cele două rulări se suprapun exact.
 */

export const RSSI_MIN = -130, RSSI_STEP = 5, RSSI_BINS = 16; // -130 … -50
export const SNR_MIN = -20, SNR_STEP = 2, SNR_BINS = 17; // -20 … +14
export const VAL_BINS = 16;
export const HEAT_X = 36, HEAT_Y = 32; // RSSI × SNR
export const HEAT_RSSI_MIN = -130, HEAT_RSSI_STEP = 2; // -130 … -58
export const HEAT_SNR_MIN = -20, HEAT_SNR_STEP = 1; // -20 … +12
/** pragurile „prospețimii” unui dispozitiv (vechimea ultimului mesaj) */
export const FRESH_EDGES = [0, 3_600_000, 6 * 3_600_000, 24 * 3_600_000, 3 * 86_400_000, 7 * 86_400_000, Infinity];
export const FRESH_LABELS = ["< 1 oră", "1–6 ore", "6–24 ore", "1–3 zile", "3–7 zile", "> 7 zile"];

export type AggCtx = {
  tStart: number;
  tStep: number;
  tN: number;
  valMax: number;
  now: number;
};

export type Agg = {
  n: number;
  devices: number;
  time: Int32Array;
  hour: Int32Array;
  wday: Int32Array;
  rssi: Int32Array;
  rssiNone: number;
  snr: Int32Array;
  snrNone: number;
  val: Int32Array;
  valNone: number;
  apps: Int32Array;
  gws: Int32Array;
  noGw: number;
  types: Int32Array;
  noTypes: number;
  dr: Int32Array;
  drNone: number;
  freq: Int32Array; // pe (kHz / 100)
  ports: Int32Array; // pe port + 1
  gn: Int32Array; // 0 = necunoscut, 1, 2, 3+
  models: Int32Array;
  years: Int32Array;
  fresh: Int32Array;
  heat: Int32Array;
  flags: { adr: number; noAdr: number; batt: number; offline: number; button: number; magnet: number; alert: number; statusOk: number; noStatus: number };
  /** dispozitivele cu cele mai multe mesaje: [index în dict.dev, mesaje] */
  topDev: [number, number][];
  sums: { rssi: number; rssiN: number; snr: number; snrN: number; val: number; valN: number; gn: number; gnN: number };
};

const NICE_STEPS = [60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000, 30 * 60_000, 3_600_000, 2 * 3_600_000, 3 * 3_600_000, 6 * 3_600_000, 12 * 3_600_000, 86_400_000, 2 * 86_400_000, 7 * 86_400_000];

/** Găleți comune pentru ambele rulări. Intervalul de timp urmează filtrul de perioadă, dacă există; altfel tot ce e în memorie. */
export function makeCtx(st: UplinkStore, f: Filters, now: number = Date.now()): AggCtx {
  let valMax = 0;
  const v = st.val;
  for (let i = 0; i < st.n; i++) if (v[i] > valMax) valMax = v[i]; // NaN nu trece de comparație
  let lo = st.n > 0 ? st.ts[st.order[st.n - 1]] : now - 3_600_000;
  let hi = st.n > 0 ? st.ts[st.order[0]] : now;
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
  return { tStart, tStep, tN: Math.max(1, tN), valMax: valMax > 0 ? valMax : 1, now };
}

export function aggregate(st: UplinkStore, idx: Int32Array | null, ctx: AggCtx): Agg {
  st.prepare();
  const m = idx ? idx.length : st.n;
  const nd = st.dict.dev.length;
  const a: Agg = {
    n: m, devices: 0,
    time: new Int32Array(ctx.tN), hour: new Int32Array(24), wday: new Int32Array(7),
    rssi: new Int32Array(RSSI_BINS), rssiNone: 0, snr: new Int32Array(SNR_BINS), snrNone: 0, val: new Int32Array(VAL_BINS), valNone: 0,
    apps: new Int32Array(st.dict.ap.length), gws: new Int32Array(st.dict.gw.length), noGw: 0,
    types: new Int32Array(32), noTypes: 0, dr: new Int32Array(16), drNone: 0,
    freq: new Int32Array(10_001), ports: new Int32Array(258), gn: new Int32Array(4),
    models: new Int32Array(st.models.length), years: new Int32Array(st.years.length),
    fresh: new Int32Array(FRESH_LABELS.length), heat: new Int32Array(HEAT_X * HEAT_Y),
    flags: { adr: 0, noAdr: 0, batt: 0, offline: 0, button: 0, magnet: 0, alert: 0, statusOk: 0, noStatus: 0 },
    topDev: [], sums: { rssi: 0, rssiN: 0, snr: 0, snrN: 0, val: 0, valN: 0, gn: 0, gnN: 0 },
  };
  const { ts, dev, gw, rssi, snr, fr, dr, fl, pt, tm, val, gn, devApp, devModel, devYear } = st;
  const cnt = new Int32Array(nd);
  const last = new Float64Array(nd).fill(-1);
  const offCache = new Map<number, number>(); // abaterea de fus orar pe zi (ora de vară)
  const { tStart, tStep, tN, valMax, now } = ctx;
  const tz = (t: number): number => {
    const day = Math.floor(t / 86_400_000);
    let o = offCache.get(day);
    if (o === undefined) { o = new Date(day * 86_400_000 + 43_200_000).getTimezoneOffset(); offCache.set(day, o); }
    return o;
  };

  for (let k = 0; k < m; k++) {
    const i = idx ? idx[k] : k;
    const t = ts[i];
    const d = dev[i];
    cnt[d]++;
    if (t > last[d]) last[d] = t;
    const b = Math.floor((t - tStart) / tStep);
    if (b >= 0 && b < tN) a.time[b]++;
    const local = t - tz(t) * 60_000;
    a.hour[(((Math.floor(local / 3_600_000) % 24) + 24) % 24)]++;
    a.wday[(((Math.floor(local / 86_400_000) + 3) % 7) + 7) % 7]++; // luni = 0 (1 ian 1970 = joi)

    const r = rssi[i];
    if (r === r) {
      a.sums.rssi += r; a.sums.rssiN++;
      a.rssi[Math.max(0, Math.min(RSSI_BINS - 1, Math.floor((r - RSSI_MIN) / RSSI_STEP)))]++;
    } else a.rssiNone++;
    const s = snr[i];
    if (s === s) {
      a.sums.snr += s; a.sums.snrN++;
      a.snr[Math.max(0, Math.min(SNR_BINS - 1, Math.floor((s - SNR_MIN) / SNR_STEP)))]++;
    } else a.snrNone++;
    if (r === r && s === s) {
      const x = Math.floor((r - HEAT_RSSI_MIN) / HEAT_RSSI_STEP), y = Math.floor((s - HEAT_SNR_MIN) / HEAT_SNR_STEP);
      if (x >= 0 && x < HEAT_X && y >= 0 && y < HEAT_Y) a.heat[y * HEAT_X + x]++;
    }
    const v = val[i];
    if (v === v && v >= 0) {
      a.sums.val += v; a.sums.valN++;
      a.val[Math.min(VAL_BINS - 1, Math.floor(VAL_BINS * Math.sqrt(v / valMax)))]++;
    } else a.valNone++;

    a.apps[devApp[d]]++;
    a.models[devModel[d]]++;
    a.years[devYear[d]]++;
    if (gw[i] >= 0) a.gws[gw[i]]++; else a.noGw++;
    const mask = tm[i];
    if (mask === 0) a.noTypes++;
    else for (let q = 0; q < 32; q++) if (mask & (1 << q)) a.types[q]++;
    if (dr[i] >= 0 && dr[i] < 16) a.dr[dr[i]]++; else a.drNone++;
    a.freq[((fr[i] / 100) + 0.5) | 0]++;
    a.ports[pt[i] + 1]++;
    const g = gn[i];
    a.gn[g > 3 ? 3 : g]++;
    if (g > 0) { a.sums.gn += g; a.sums.gnN++; }

    const f = fl[i];
    if (f & FLAG.ADR) a.flags.adr++; else a.flags.noAdr++;
    if (f & FLAG.BATT) a.flags.batt++;
    if (f & FLAG.OFFLINE) a.flags.offline++;
    if (f & FLAG.BTN) a.flags.button++;
    if (f & FLAG.MAG) a.flags.magnet++;
    if (f & ALERT_FLAGS) a.flags.alert++;
    if (f & FLAG.STATUS) { if (!(f & ALERT_FLAGS)) a.flags.statusOk++; } else a.flags.noStatus++;
  }

  // dispozitive distincte, prospețime (vechimea ultimului mesaj) și top după număr de mesaje
  const top: [number, number][] = [];
  for (let d = 0; d < nd; d++) {
    if (cnt[d] === 0) continue;
    a.devices++;
    const age = Math.max(0, now - last[d]);
    let q = 0;
    while (q < FRESH_LABELS.length - 1 && age >= FRESH_EDGES[q + 1]) q++;
    a.fresh[q]++;
    if (top.length < 10 || cnt[d] > top[top.length - 1][1]) {
      let p = top.length;
      while (p > 0 && top[p - 1][1] < cnt[d]) p--;
      top.splice(p, 0, [d, cnt[d]]);
      if (top.length > 10) top.pop();
    }
  }
  a.topDev = top;
  return a;
}
