/**
 * Consum nemăsurat: analiza nopților. Idee: dacă într-o noapte (00:00–06:00, ora Moldovei) contorul nu înregistrează consum (sau foarte puțin), deși ziua
 * consumă și temperatura din jurul lui nu scade (încălzirea merge), gazul poate trece pe lângă contor. Rezultatul e un INDICIU, nu o dovadă.
 *
 * Intrare: citirile unui contor (moment, volum total, temperatură) — cele pe care sincronizarea le păstrează în `meter_readings` (+ arhiva de volum veche).
 * Contorul trimite la 4–6 ore, deci volumul la 00:00 și la 06:00 se află prin INTERPOLARE LINIARĂ între citirile vecine, doar dacă ele sunt la cel mult
 * `MAX_GAP_MS` una de alta (altfel noaptea e „necunoscută”). Fără biblioteci, fără rețea; testat în `npm run check`.
 */
export const TZ = "Europe/Chisinau";
export const H = 3_600_000;
export const DAY = 24 * H;
/** noaptea = primele 6 ore ale zilei locale */
export const NIGHT_HOURS = 6;
/** cât de departe pot fi două citiri vecine ca să interpolăm între ele */
export const MAX_GAP_MS = 8 * H;
/** câte nopți se calculează și se păstrează */
export const NIGHTS = 30;

export type Pt = { t: number; v: number; tp: number | null };

const fmt = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
function parts(t: number): { y: number; m: number; d: number; h: number } {
  const o: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(t))) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour };
}
/** decalajul orei Moldovei față de UTC la momentul t (ms) */
export function offsetAt(t: number): number {
  const p = parts(t);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, new Date(t).getUTCMinutes(), new Date(t).getUTCSeconds());
  return asUtc - Math.floor(t / 1000) * 1000;
}
/** miezul nopții local (ms UTC) al zilei calendaristice y-m-d */
export function localMidnight(y: number, m: number, d: number): number {
  const guess = Date.UTC(y, m - 1, d);
  let ts = guess - offsetAt(guess);
  const off2 = offsetAt(ts);
  if (guess - off2 !== ts) ts = guess - off2;
  return ts;
}
/** începutul zilei locale care conține t */
export function dayStart(t: number): number {
  const p = parts(t);
  return localMidnight(p.y, p.m, p.d);
}
/** Ultimele `n` zile locale COMPLETE (fără cea de azi), cea mai veche prima: începuturile lor (ms). */
export function lastDays(now: number, n: number): number[] {
  const today = dayStart(now);
  const out: number[] = [];
  let cur = today;
  for (let i = 0; i < n; i++) {
    cur = dayStart(cur - 12 * H); // începutul zilei precedente (sigur în interiorul ei, chiar la schimbarea orei)
    out.push(cur);
  }
  return out.reverse();
}

/** Volumul interpolat la momentul x; NaN dacă citirile vecine sunt la mai mult de MAX_GAP_MS. `pts` sortat după t. */
export function volumeAt(pts: Pt[], x: number): number {
  let lo = 0, hi = pts.length - 1;
  if (hi < 0 || x < pts[0].t || x > pts[hi].t) return NaN;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid].t <= x) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  if (a.t === x) return a.v;
  if (b.t === x) return b.v;
  if (b.t - a.t > MAX_GAP_MS) return NaN;
  return a.v + ((b.v - a.v) * (x - a.t)) / (b.t - a.t);
}

export type NightRow = {
  /** consum noaptea 00–06 (m³) */ nc: (number | null)[];
  /** consum ziua 06–24 (m³) */ dc: (number | null)[];
  /** temperatura minimă din citirile de noapte (°C) */ nt: (number | null)[];
  /** temperatura medie pe toată ziua (°C) */ ta: (number | null)[];
};
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Metricile fiecărei zile din `days` (începuturile zilelor locale). Valorile necunoscute sunt null. */
export function nightMetrics(pts: Pt[], days: number[]): NightRow {
  const row: NightRow = { nc: [], dc: [], nt: [], ta: [] };
  for (const d0 of days) {
    const d1 = dayStart(d0 + DAY + 12 * H); // începutul zilei următoare
    const n6 = d0 + NIGHT_HOURS * H;
    const v0 = volumeAt(pts, d0), v6 = volumeAt(pts, n6), v24 = volumeAt(pts, d1);
    const nc = v6 - v0, dc = v24 - v6;
    row.nc.push(Number.isFinite(nc) && nc >= 0 ? r3(nc) : null);
    row.dc.push(Number.isFinite(dc) && dc >= 0 ? r3(dc) : null);
    let nMin = Infinity, sum = 0, cnt = 0;
    for (const p of pts) {
      if (p.t < d0 || p.t >= d1 || p.tp === null) continue;
      sum += p.tp; cnt++;
      if (p.t < n6 && p.tp < nMin) nMin = p.tp;
    }
    row.nt.push(nMin === Infinity ? null : nMin);
    row.ta.push(cnt ? Math.round((sum / cnt) * 10) / 10 : null);
  }
  return row;
}

/** Parametrii filtrului (editabili în pagină). */
export type SuspectParams = {
  /** câte dintre ultimele nopți se iau în calcul */ nights: number;
  /** consum de noapte maxim (m³, total 00–06) */ maxNight: number;
  /** consum de zi minim (m³) — ca să nu apară casele goale; 0 = fără condiție */ minDay: number;
  /** temperatură minimă (°C); null = fără condiție de temperatură */ minTemp: number | null;
  /** temperatura de comparat: minima din noapte sau media pe zi */ tempMode: "night" | "day";
  /** în câte nopți trebuie să se potrivească */ minNights: number;
};
export const DEFAULT_PARAMS: SuspectParams = { nights: 14, maxNight: 1, minDay: 5, minTemp: 22, tempMode: "night", minNights: 3 };

/** O noapte e suspectă: consum de noapte ≤ prag, consum de zi ≥ prag, temperatura ≥ prag (dacă e cerută și se cunoaște). */
export function nightMatches(row: NightRow, i: number, p: SuspectParams): boolean {
  const nc = row.nc[i], dc = row.dc[i];
  if (nc === null || nc > p.maxNight) return false;
  if (p.minDay > 0 && (dc === null || dc < p.minDay)) return false;
  if (p.minTemp !== null) {
    const t = p.tempMode === "night" ? row.nt[i] : row.ta[i];
    if (t === null || t < p.minTemp) return false;
  }
  return true;
}
/** Câte din ultimele `p.nights` nopți se potrivesc (nopțile sunt ordonate de la cea mai veche la cea mai nouă) + câte nopți au date. */
export function countMatches(row: NightRow, p: SuspectParams): { matched: number; known: number } {
  const n = row.nc.length;
  let matched = 0, known = 0;
  for (let i = Math.max(0, n - p.nights); i < n; i++) {
    if (row.nc[i] !== null) known++;
    if (nightMatches(row, i, p)) matched++;
  }
  return { matched, known };
}
