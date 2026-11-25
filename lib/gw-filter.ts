/**
 * Filtrul antenelor: RAZA DE ACȚIUNE (distanța antenă ↔ contor, în km, ca interval «de la – până la») și PERIOADA (când a auzit antena ultima oară contorul).
 * Logică pură (fără baze de date), folosită și de browser, și de server; testată în `npm run check`.
 *
 *  - Perioada = de la ce contoare a primit date antena (ultimul mesaj auzit al contorului): ultima oră / 24 h · azi · ieri · ultimele 3 / 7 / 14 / 30 de zile · mai vechi de 7 / 30 de zile · un interval de date ales · toate.
 *    Limitele se calculează în browser (miezul nopții LOCAL al utilizatorului) și se trimit ca milisecunde (`pf` / `pt`).
 *  - Raza: 1 km · 3 km · 10 km · toate · sau un interval ales (două puncte). `kmax` lipsă = fără limită superioară.
 *  - Un contor fără distanță cunoscută (fără coordonate, sau antenă fără poziție) trece DOAR când raza nu e restrânsă.
 */
export type GwPeriod = "all" | "1h" | "24h" | "today" | "yesterday" | "3d" | "7d" | "14d" | "30d" | "older" | "older30" | "range";
export type GwRadius = "all" | "1" | "3" | "10" | "range";
/** alegerea din interfață */
export type GwFilter = { per: GwPeriod; rad: GwRadius; kmMin: number; kmMax: number | null; /** interval de date ales (AAAA-LL-ZZ, ziua locală); gol = fără capăt */ pFrom: string; pTo: string };
/** ce se trimite serverului: `kmax` / `pf` / `pt` = null → fără limită */
export type GwQuery = { kmin: number; kmax: number | null; pf: number | null; pt: number | null };

export const DEFAULT_FILTER: GwFilter = { per: "all", rad: "all", kmMin: 0, kmMax: null, pFrom: "", pTo: "" };
export const NO_QUERY: GwQuery = { kmin: 0, kmax: null, pf: null, pt: null };
export const PERIODS: [GwPeriod, string][] = [
  ["all", "Toate"], ["1h", "Ultima oră"], ["24h", "Ultimele 24 de ore"], ["today", "Azi"], ["yesterday", "Ieri"], ["3d", "Ultimele 3 zile"], ["7d", "Ultimele 7 zile"], ["14d", "Ultimele 14 zile"], ["30d", "Ultimele 30 de zile"],
  ["older", "Mai vechi de 7 zile"], ["older30", "Mai vechi de 30 de zile"], ["range", "Interval de date…"],
];
/** zilele (ale căror contoare se cer) pentru perioadele «ultimele N zile»: azi + N-1 zile înapoi */
const LAST_DAYS: Partial<Record<GwPeriod, number>> = { "3d": 3, "7d": 7, "14d": 14, "30d": 30 };
export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const RADII: [GwRadius, string][] = [["1", "Până la 1 km"], ["3", "Până la 3 km"], ["10", "Până la 10 km"], ["all", "Toate"], ["range", "Interval"]];
/** capătul de sus al glisorului: la maxim înseamnă «fără limită» */
export const KM_SLIDER_MAX = 30;
/** limitele grupelor de distanță din graficul «contoare după distanță»: 0–0,5 · 0,5–1 · 1–2 · 2–3 · 3–5 · 5–10 · 10–20 · peste 20 km */
export const KM_EDGES = [0.5, 1, 2, 3, 5, 10, 20];

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** Raza efectivă a alegerii (kmin, kmax) */
export function radiusOf(f: GwFilter): { kmin: number; kmax: number | null } {
  if (f.rad === "all") return { kmin: 0, kmax: null };
  if (f.rad === "range") {
    const lo = Math.max(0, num(f.kmMin, 0)), hi = f.kmMax === null ? null : Math.max(0, num(f.kmMax, 0));
    return hi !== null && hi < lo ? { kmin: hi, kmax: lo } : { kmin: lo, kmax: hi };
  }
  return { kmin: 0, kmax: Number(f.rad) };
}

/** Ziua AAAA-LL-ZZ ca început de zi LOCAL (ms), sau null dacă nu e o dată validă. */
export function localDayStart(v: string): number | null {
  if (!DATE_RE.test(v)) return null;
  const [y, m, d] = v.split("-").map(Number), t = new Date(y, m - 1, d, 0, 0, 0, 0);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d ? t.getTime() : null;
}

/** Limitele perioadei, în ms: ziua începe la miezul nopții local; «ultima oră» / «24 de ore» se numără de la acum. */
export function periodBounds(per: GwPeriod, now: number, from = "", to = ""): { pf: number | null; pt: number | null } {
  const mid = new Date(now);
  mid.setHours(0, 0, 0, 0);
  const back = (n: number) => { const d = new Date(mid); d.setDate(d.getDate() - n); return d.getTime(); };
  switch (per) {
    case "1h": return { pf: now - 3_600_000, pt: null };
    case "24h": return { pf: now - 86_400_000, pt: null };
    case "today": return { pf: mid.getTime(), pt: null };
    case "yesterday": return { pf: back(1), pt: mid.getTime() - 1 };
    case "older": return { pf: null, pt: back(6) - 1 };
    case "older30": return { pf: null, pt: back(29) - 1 };
    case "range": {
      const a = localDayStart(from), b = localDayStart(to);
      const end = b === null ? null : (() => { const d = new Date(b); d.setDate(d.getDate() + 1); return d.getTime() - 1; })();
      // capetele puse invers se întorc
      return a !== null && end !== null && end < a ? { pf: b, pt: (() => { const d = new Date(a); d.setDate(d.getDate() + 1); return d.getTime() - 1; })() } : { pf: a, pt: end };
    }
    case "all": return { pf: null, pt: null };
    default: return { pf: back((LAST_DAYS[per] ?? 1) - 1), pt: null };
  }
}

export function toQuery(f: GwFilter, now: number): GwQuery {
  const r = radiusOf(f), p = periodBounds(f.per, now, f.pFrom, f.pTo);
  return { kmin: r.kmin, kmax: r.kmax, pf: p.pf, pt: p.pt };
}

export const radiusActive = (q: GwQuery): boolean => q.kmin > 0 || q.kmax !== null;
export const periodActive = (q: GwQuery): boolean => q.pf !== null || q.pt !== null;
export const queryActive = (q: GwQuery): boolean => radiusActive(q) || periodActive(q);

/** Trece contorul (la distanța `km`, auzit ultima oară la `last`) de filtru? */
export function passes(q: GwQuery, km: number | null, last: number): boolean {
  if (q.pf !== null && last < q.pf) return false;
  if (q.pt !== null && last > q.pt) return false;
  if (!radiusActive(q)) return true;
  if (km === null || !Number.isFinite(km)) return false;
  return km >= q.kmin && (q.kmax === null || km <= q.kmax);
}

/** Doar partea de rază (perioada nu contează) — pentru graficul pe distanță și pentru antenele unui contor. */
export const inRadius = (q: GwQuery, km: number | null): boolean => passes({ ...q, pf: null, pt: null }, km, 0);

/** În parametri de URL: doar ce nu e implicit (cererile fără filtru rămân identice cu cele de dinainte). */
export function queryParams(q: GwQuery): Record<string, string> {
  const o: Record<string, string> = {};
  if (q.kmin > 0) o.kmin = String(q.kmin);
  if (q.kmax !== null) o.kmax = String(q.kmax);
  if (q.pf !== null) o.pf = String(Math.round(q.pf));
  if (q.pt !== null) o.pt = String(Math.round(q.pt));
  return o;
}
export const queryString = (q: GwQuery): string => new URLSearchParams(queryParams(q)).toString();

/** Din parametrii URL (citire prietenoasă: valorile greșite se ignoră, kmin ≤ kmax). */
export function parseQuery(sp: URLSearchParams): GwQuery {
  const n = (k: string): number | null => {
    const v = sp.get(k);
    if (v === null || v.trim() === "") return null;
    const x = Number(v);
    return Number.isFinite(x) ? x : null;
  };
  let kmin = Math.min(1000, Math.max(0, n("kmin") ?? 0)), kmax = n("kmax");
  if (kmax !== null) kmax = Math.min(1000, Math.max(0, kmax));
  if (kmax !== null && kmax < kmin) [kmin, kmax] = [kmax, kmin];
  const pf = n("pf"), pt = n("pt");
  return { kmin, kmax, pf: pf !== null && pf > 0 ? pf : null, pt: pt !== null && pt > 0 ? pt : null };
}

/** Grupa de distanță a unui contor (0 … KM_EDGES.length) — ultima = «peste 20 km». */
export function bandOf(km: number): number {
  let i = 0;
  while (i < KM_EDGES.length && km >= KM_EDGES[i]) i++;
  return i;
}
export function bandLabel(i: number): string {
  const f = (x: number) => String(x).replace(".", ",");
  if (i === 0) return `sub ${f(KM_EDGES[0])} km`;
  if (i >= KM_EDGES.length) return `peste ${f(KM_EDGES[KM_EDGES.length - 1])} km`;
  return `${f(KM_EDGES[i - 1])}–${f(KM_EDGES[i])} km`;
}

const dmy = (v: string) => (DATE_RE.test(v) ? v.split("-").reverse().join(".") : "");
/** Perioada în cuvinte (cu litere mici), pentru titluri: «azi», «ultimele 7 zile», «01.11.2026 – 05.11.2026»; gol pentru «toate». */
export function periodText(f: GwFilter): string {
  if (f.per === "all") return "";
  if (f.per === "range") {
    const a = dmy(f.pFrom), b = dmy(f.pTo);
    return a && b ? `${a} – ${b}` : a ? `de la ${a}` : b ? `până la ${b}` : "";
  }
  return PERIODS.find((p) => p[0] === f.per)?.[1].toLowerCase() ?? "";
}

/** Text scurt pentru ce e ales (pentru titluri și rezumate). */
export function describe(f: GwFilter): string {
  const r = radiusOf(f);
  const km = (x: number) => String(x).replace(".", ",");
  const rad = f.rad === "all" ? "" : r.kmax === null ? `de la ${km(r.kmin)} km` : r.kmin > 0 ? `${km(r.kmin)}–${km(r.kmax)} km` : `până la ${km(r.kmax)} km`;
  return [rad, periodText(f)].filter(Boolean).join(" · ");
}
