import { NO_CITY, filOf } from "./access";

/**
 * Regulile care decid când apare o problemă (logică pură, fără baze de date — se verifică în `npm run check`). Pragurile sunt aici, la vedere:
 *  - contoare care nu mai transmit: într-un oraș, contoarele cu ultima citire între 36 h și 10 zile în urmă («au transmis de curând, acum tac») față de cele care transmit (≤ 36 h);
 *    problemă dacă sunt cel puțin 15 și cel puțin 15 % dintre cele care transmiteau. Contoarele mute de mai mult de 10 zile și cele «Defectate_*» nu intră (nu sunt o problemă nouă);
 *  - antenă fără mesaje: o antenă care primea cel puțin 2 mesaje pe zi (media ultimelor 7 zile întregi) și tace de mai mult de 4 ori intervalul ei obișnuit dintre mesaje (cel puțin 3 h, cel mult 36 h),
 *    dar nu de mai mult de 14 zile (o antenă oprită de mult nu mai e o problemă nouă);
 *  - eficiență scăzută: ieri (zi UTC întreagă) antena a primit sub jumătate din mediana celor 7 zile dinainte, dacă mediana era de cel puțin 40 de mesaje pe zi.
 */
export const HOUR = 3_600_000, DAY = 86_400_000;
export const RECENT_MS = 36 * HOUR, LAPSED_MAX_MS = 10 * DAY;
export const MIN_LAPSED = 15, MIN_LAPSED_RATIO = 0.15, CRIT_RATIO = 0.4;

export type MeterLite = { br: string; ct: string; t: number | null; pf?: string | null };
export type ZoneStat = { zone: string; recent: number; lapsed: number };

/** „05|Comrat” (fără oraș: „05|—”) — aceeași formă ca zonele din drepturile utilizatorilor. */
export const zoneOf = (br: string, ct: string): string => `${filOf(br)}|${ct && ct !== "" ? ct : NO_CITY}`;

/** Pe fiecare zonă (filială + oraș): câte contoare transmit și câte au tăcut de curând. */
export function silentByZone(meters: Iterable<MeterLite>, now: number): ZoneStat[] {
  const by = new Map<string, ZoneStat>();
  for (const m of meters) {
    if (!/^\d{1,3}$/.test(filOf(m.br))) continue; // fără filială nu putem ști cui să anunțăm
    if (m.pf && /^Defectate_/i.test(m.pf)) continue;
    if (typeof m.t !== "number" || !(m.t > 0) || m.t > now + HOUR) continue;
    const age = now - m.t;
    if (age > LAPSED_MAX_MS) continue;
    const z = zoneOf(m.br, m.ct);
    let s = by.get(z);
    if (!s) by.set(z, (s = { zone: z, recent: 0, lapsed: 0 }));
    if (age <= RECENT_MS) s.recent++; else s.lapsed++;
  }
  return [...by.values()];
}

/** Zona are o problemă? (și cât de gravă) */
export function silentProblem(s: ZoneStat): { level: "warn" | "crit"; ratio: number } | null {
  const all = s.recent + s.lapsed;
  if (s.lapsed < MIN_LAPSED || all === 0) return null;
  const ratio = s.lapsed / all;
  if (ratio < MIN_LAPSED_RATIO) return null;
  return { level: ratio >= CRIT_RATIO ? "crit" : "warn", ratio };
}

export type Day = { d: number; n: number };
const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
/** Mesajele pe zile (UTC) ale unei antene: lipsa unei zile = 0. `to` = ziua exclusă (de obicei azi). */
function series(days: Day[], from: number, to: number): number[] {
  const m = new Map(days.map((x) => [dayStart(x.d), x.n]));
  const out: number[] = [];
  for (let d = dayStart(from); d < dayStart(to); d += DAY) out.push(m.get(d) ?? 0);
  return out;
}
const median = (a: number[]): number => { if (!a.length) return 0; const s = a.slice().sort((x, y) => x - y); const h = s.length >> 1; return s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2; };

/** Antena nu mai primește mesaje? `avg` = mesaje pe zi (ultimele 7 zile întregi), `limitH` = cât poate tăcea înainte să fie o problemă. */
export function gatewayDown(last: number | null, days: Day[], now: number): { down: boolean; avg: number; limitH: number; silentH: number } {
  const today = dayStart(now);
  const s = series(days, today - 7 * DAY, today);
  const avg = s.reduce((a, b) => a + b, 0) / 7;
  const silent = last ? now - last : Infinity;
  const limit = Math.min(36 * HOUR, Math.max(3 * HOUR, avg > 0 ? 4 * (DAY / avg) : Infinity));
  const down = avg >= 2 && last !== null && silent > limit && silent <= 14 * DAY;
  return { down, avg, limitH: Math.round(limit / HOUR), silentH: Math.round(silent / HOUR) };
}

/** Eficiență scăzută: ieri sub jumătate din mediana celor 7 zile dinainte (mediană ≥ 40 / zi). */
export function gatewayDrop(days: Day[], now: number): { drop: boolean; yesterday: number; med: number } {
  const today = dayStart(now);
  const y = series(days, today - DAY, today)[0] ?? 0;
  const med = median(series(days, today - 8 * DAY, today - DAY));
  return { drop: med >= 40 && y < med / 2, yesterday: y, med };
}
