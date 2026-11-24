import type { Db } from "mongodb";
import { unpack, type Pts } from "./meter-history";
import { offsetAt } from "./night-analysis";

/**
 * Raportul de citiri către facturare (Oracle): pentru fiecare contor, CEA MAI RECENTĂ citire până la data și ora aleasă (ex. 01/12/2026 07:00).
 * În fișier ajung doar trei câmpuri: numărul de serie al radiomodulului, indicația (volumul total, m³) și data reală a citirii (momentul în care a fost făcută de fapt).
 *
 * Surse (doar din baza NOASTRĂ, nimic din SCADA): citirile proprii (`meter_readings`, de la punerea în funcțiune a istoricului), arhiva veche de volum
 * (`meter_history`, seria `x` = Volume_m3_Total la fiecare transmisie) și ultima citire din documentul contorului. Se combină, se scot dublurile (aceeași secundă)
 * și se alege ultima citire cu momentul ≤ cel ales. Orele sunt în ora Moldovei (Europe/Chisinau).
 * Logică pură + un generator pe loturi de contoare (nu ține tot raportul în memorie).
 */
export type ReportParams = { /** momentul ales (ms UTC): se ia ultima citire făcută până atunci (inclusiv) */ at: number; onlyBilled: boolean };

export const REPORT_HEADER = ["num_radio", "indicatia_m3", "data_citire"] as const;

export type ReportStatus = "running" | "done" | "error";
/** Un raport generat, așa cum îl arată pagina. */
export type ReportRow = {
  id: string; kind: "manual" | "scheduled"; by: string; createdAt: number; finishedAt: number | null;
  at: number; onlyBilled: boolean; status: ReportStatus;
  scanned: number; total: number; meters: number; rows: number; bytes: number; file: string | null; sha256: string | null; error: string | null;
};

/* ───────── ora locală ───────── */
const HOUR = 3_600_000;
const offCache = new Map<number, number>();
/** Decalajul orei locale; se reține pe oră UTC (schimbările de oră au loc la ore fixe UTC), ca formatarea a milioane de rânduri să fie ieftină. */
const offAt = (t: number): number => {
  const k = Math.floor(t / HOUR);
  let o = offCache.get(k);
  if (o === undefined) {
    o = offsetAt(k * HOUR);
    if (offCache.size > 8000) offCache.clear();
    offCache.set(k, o);
  }
  return o;
};
const p2 = (n: number) => String(n).padStart(2, "0");
/** „AAAA-LL-ZZ HH:MM:SS” în ora Moldovei */
export function fmtLocal(t: number): string {
  const d = new Date(t + offAt(t));
  return `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
/** „ZZ/LL/AAAA HH:MM:SS” în ora Moldovei (formatul din fișierul pentru facturare) */
export function fmtDmy(t: number): string {
  const d = new Date(t + offAt(t));
  return `${p2(d.getUTCDate())}/${p2(d.getUTCMonth() + 1)}/${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())}`;
}
/** „AAAA-LL-ZZ HH:MM:SS” în UTC */
export const fmtUtc = (t: number): string => new Date(t).toISOString().slice(0, 19).replace("T", " ");

/** Data și ora de pe perete în Moldova (an, lună, zi, oră, minut) → ms UTC. Ora inexistentă (trecerea la ora de vară) se mută înainte. */
export function localToUtc(y: number, m: number, d: number, h = 0, mi = 0): number {
  const wall = Date.UTC(y, m - 1, d, h, mi);
  let u = wall - offsetAt(wall);
  u = wall - offsetAt(u);
  return u;
}
/** „AAAA-LL-ZZ HHMM” (momentul ales, în ora locală) pentru numele fișierului: „2026-12-01_0700” */
export const atName = (at: number): string => fmtLocal(at).slice(0, 16).split(" ").join("_").split(":").join("");
/** Ziua 1 a lunii în care se află `now` (ora locală), la ora dată: momentul ales pentru raportul automat de pe 1 ale lunii (ex. 1 la 07:00). */
export function monthStartAt(now: number, hour: number): number {
  const d = new Date(now + offAt(now));
  return localToUtc(d.getUTCFullYear(), d.getUTCMonth() + 1, 1, hour, 0);
}

/* ───────── puncte ───────── */
/**
 * Citirile unui contor în [from, to): proprii + arhivă, ordonate în timp, fără dubluri (aceeași secundă; rămâne prima). Valorile invalide / negative se ignoră.
 */
export function mergePoints(own: Pts, hist: Pts, from: number, to: number): Pts {
  const all: Pts = [];
  for (const p of hist) if (p[0] >= from && p[0] < to && Number.isFinite(p[1]) && p[1] >= 0) all.push(p);
  for (const p of own) if (p[0] >= from && p[0] < to && Number.isFinite(p[1]) && p[1] >= 0) all.push(p);
  all.sort((a, b) => a[0] - b[0]);
  const out: Pts = [];
  let lastSec = NaN;
  for (const p of all) {
    const sec = Math.round(p[0] / 1000);
    if (sec === lastSec) continue;
    lastSec = sec;
    out.push(p);
  }
  return out;
}

/** Cea mai recentă citire cu momentul ≤ `at` (sau null dacă nu există). `points` poate fi în orice ordine. */
export function latestAt(points: Pts, at: number): [number, number] | null {
  let best: [number, number] | null = null;
  for (const p of points) {
    if (!(p[0] <= at) || !Number.isFinite(p[1]) || p[1] < 0) continue;
    if (!best || p[0] > best[0]) best = [p[0], p[1]];
  }
  return best;
}

/* ───────── CSV ───────── */
export const csvCell = (s: string): string => (s.includes(";") || s.includes('"') || s.includes("\n") || s.includes("\r") ? `"${s.split('"').join('""')}"` : s);
export const headerLine = (): string => REPORT_HEADER.join(";") + "\n";

type MeterDoc = { _id: string; s?: { n?: string; v?: number | null; t?: number | null }; bill?: Record<string, unknown> | null };
const str = (x: unknown): string => (x === null || x === undefined ? "" : String(x).trim());
const SERIES = /^(?:S|SN)?\d{4}_(\d{8})_\d{4}$/;
/** Numărul de serie al radiomodulului: NUM_RADIO din facturare, altfel seria de 8 cifre din numele dispozitivului („S2154_00070948_2022” → 00070948). Gol dacă nu se află. */
export function radioOf(d: MeterDoc): string {
  const r = str(d.bill?.NUM_RADIO);
  if (r) return r;
  const m = SERIES.exec(str(d.s?.n));
  return m ? m[1] : "";
}
/** O linie de raport: serie radiomodul; indicația în m³ cu 3 zecimale; data reală a citirii (ZZ/LL/AAAA HH:MM:SS, ora Moldovei). */
export const readingLine = (radio: string, t: number, v: number): string => `${csvCell(radio)};${v.toFixed(3)};${fmtDmy(t)}\n`;

/* ───────── generatorul pe loturi ───────── */
export type Names = { meters: string; readings: string; history: string };
export type Batch = { text: string; meters: number; rows: number; scanned: number };
export const BILLED_BIT = 128; // FLAG.BILLED din lib/meter-shared.ts (aici fără import, ca să rămână ușor de rulat din scripturi)

export const meterFilter = (onlyBilled: boolean) => (onlyBilled ? { "s.fl": { $bitsAllSet: BILLED_BIT } } : {});

/**
 * Parcurge contoarele în ordinea `_id`, în loturi, și întoarce pentru fiecare lot textul CSV (fără antet) și numărătorile: câte o linie pe contor, cu ultima citire
 * până la momentul ales. Un contor fără citire până atunci sau fără număr de radiomodul nu apare. `limit` = oprește după atâtea contoare (previzualizare).
 */
export async function* reportBatches(db: Db, p: ReportParams, names: Names, o: { batch?: number; limit?: number } = {}): AsyncGenerator<Batch> {
  const size = o.batch ?? 500;
  const cur = db.collection(names.meters).find(meterFilter(p.onlyBilled), { projection: { "s.n": 1, "s.v": 1, "s.t": 1, "bill.NUM_RADIO": 1 } }).sort({ _id: 1 }).batchSize(1000);
  let docs: MeterDoc[] = [];
  let scanned = 0;
  const run = async (): Promise<Batch> => {
    const ids = docs.map((d) => d._id);
    const [rd, hd] = await Promise.all([
      db.collection(names.readings).find({ _id: { $in: ids } as never }, { projection: { t: 1, v: 1 } }).toArray(),
      db.collection(names.history).find({ _id: { $in: ids } as never }, { projection: { x: 1 } }).toArray(),
    ]);
    const own = new Map<string, Pts>();
    for (const r of rd) {
      const t = (r.t as number[] | undefined) ?? [], v = (r.v as number[] | undefined) ?? [];
      const pts: Pts = [];
      for (let i = 0; i < t.length && i < v.length; i++) pts.push([t[i], v[i]]);
      own.set(String(r._id), pts);
    }
    const hist = new Map<string, Pts>();
    for (const h of hd) if (h.x) hist.set(String(h._id), unpack(h.x as never));
    let text = "", meters = 0, rows = 0;
    for (const d of docs) {
      const radio = radioOf(d);
      if (!radio) continue;
      // ultima citire din documentul contorului intră și ea (dacă istoricul propriu încă n-a ajuns la ea)
      const now: Pts = typeof d.s?.t === "number" && typeof d.s?.v === "number" ? [[d.s.t, d.s.v]] : [];
      const last = latestAt(mergePoints(own.get(d._id) ?? [], [...(hist.get(d._id) ?? []), ...now], 0, p.at + 1), p.at);
      if (!last) continue;
      meters++;
      text += readingLine(radio, last[0], last[1]);
      rows++;
    }
    return { text, meters, rows, scanned };
  };
  for await (const d of cur) {
    docs.push(d as unknown as MeterDoc);
    scanned++;
    if (docs.length >= size) { const b = await run(); docs = []; yield b; }
    if (o.limit && scanned >= o.limit) break;
  }
  if (docs.length) yield await run();
}
