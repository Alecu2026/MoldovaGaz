import type { Db } from "mongodb";
import { unpack, type Pts } from "./meter-history";
import { localMidnight, offsetAt } from "./night-analysis";

/**
 * Raportul de citiri către facturare (Oracle): pentru fiecare contor, citirile dintr-o perioadă — indicația (volumul total, m³) și momentul citirii.
 *
 * Surse (doar din baza NOASTRĂ, nimic din SCADA): citirile proprii (`meter_readings`, de la punerea în funcțiune a istoricului) și arhiva veche de volum
 * (`meter_history`, seria `x` = Volume_m3_Total la fiecare transmisie). Se combină, se scot dublurile (aceeași secundă) și se taie la perioadă.
 * Perioada = [from, to) în ms; lunile se calculează în ora locală a Moldovei (Europe/Chisinau).
 * Logică pură + un generator pe loturi de contoare (nu ține tot raportul în memorie: o lună poate avea milioane de rânduri).
 */
export type ReportMode = "all" | "daily" | "last";
export type ReportParams = { from: number; to: number; mode: ReportMode; onlyBilled: boolean };

export const REPORT_HEADER = ["num_radio", "cont", "sp_id", "serie_contor", "contor", "deveui", "filiala", "data_citire", "data_citire_utc", "volum_m3"] as const;
export const MODE_LABEL: Record<ReportMode, string> = { all: "toate citirile", daily: "una pe zi (ultima din zi)", last: "doar ultima din perioadă" };

export type ReportStatus = "running" | "done" | "error";
/** Un raport generat, așa cum îl arată pagina. */
export type ReportRow = {
  id: string; kind: "manual" | "scheduled"; by: string; createdAt: number; finishedAt: number | null;
  from: number; to: number; mode: ReportMode; onlyBilled: boolean; status: ReportStatus;
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
/** „AAAA-LL-ZZ HH:MM:SS” în UTC */
export const fmtUtc = (t: number): string => new Date(t).toISOString().slice(0, 19).replace("T", " ");
export const localDate = (t: number): string => fmtLocal(t).slice(0, 10);

/** Luna (1–12) în ora locală: [de la miezul nopții zilei 1, până la miezul nopții zilei 1 a lunii următoare). */
export function monthRange(y: number, m: number): { from: number; to: number } {
  return { from: localMidnight(y, m, 1), to: m === 12 ? localMidnight(y + 1, 1, 1) : localMidnight(y, m + 1, 1) };
}
const localYm = (now: number): { y: number; m: number } => {
  const d = new Date(now + offAt(now));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1 };
};
/** Luna care tocmai s-a încheiat (cea la care se referă raportul de pe 1 ale lunii). */
export function previousMonth(now: number): { from: number; to: number } {
  const { y, m } = localYm(now);
  return m === 1 ? monthRange(y - 1, 12) : monthRange(y, m - 1);
}
/** Luna curentă, de la început până acum (nu mai departe). */
export function thisMonthSoFar(now: number): { from: number; to: number } {
  const { y, m } = localYm(now);
  const r = monthRange(y, m);
  return { from: r.from, to: Math.min(r.to, now + 1) };
}
/** „AAAA-LL-ZZ_AAAA-LL-ZZ” (prima și ultima zi a perioadei, în ora locală) */
export const periodName = (from: number, to: number): string => `${localDate(from)}_${localDate(Math.max(from, to - 1))}`;

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

/** Ce rămâne din citirile ordonate: toate, ultima din fiecare zi locală, sau doar ultima din perioadă. */
export function collapse(points: Pts, mode: ReportMode): Pts {
  if (mode === "all" || points.length === 0) return points;
  if (mode === "last") return [points[points.length - 1]];
  const out: Pts = [];
  let day = "";
  for (const p of points) {
    const d = localDate(p[0]);
    if (d === day) out[out.length - 1] = p; else { out.push(p); day = d; }
  }
  return out;
}

/* ───────── CSV ───────── */
export const csvCell = (s: string): string => (s.includes(";") || s.includes('"') || s.includes("\n") || s.includes("\r") ? `"${s.split('"').join('""')}"` : s);
export const headerLine = (): string => REPORT_HEADER.join(";") + "\n";

type MeterDoc = { _id: string; s?: { n?: string; e?: string }; bill?: Record<string, unknown> | null; attrs?: Record<string, unknown> };
const str = (x: unknown): string => (x === null || x === undefined ? "" : String(x).trim());
/** Cheile contorului în sistemul de facturare, aceleași pentru toate liniile lui. */
export function meterKeys(d: MeterDoc): string[] {
  const b = d.bill ?? {};
  const a = d.attrs ?? {};
  return [str(b.NUM_RADIO), str(b.ACCT_ID) || str(a.ContPersonal), str(b.SP_ID), str(a.ContorNr) || str(b.CONTOR_SN), str(d.s?.n), str(d.s?.e), str(b.FIL ?? a.FIL)].map(csvCell);
}
/** O linie de raport: cheile contorului + momentul citirii (ora locală și UTC) + indicația în m³ cu 3 zecimale. */
export const readingLine = (keys: string[], t: number, v: number): string => `${keys.join(";")};${fmtLocal(t)};${fmtUtc(t)};${v.toFixed(3)}\n`;

/* ───────── generatorul pe loturi ───────── */
export type Names = { meters: string; readings: string; history: string };
export type Batch = { text: string; meters: number; rows: number; scanned: number };
export const BILLED_BIT = 128; // FLAG.BILLED din lib/meter-shared.ts (aici fără import, ca să rămână ușor de rulat din scripturi)

export const meterFilter = (onlyBilled: boolean) => (onlyBilled ? { "s.fl": { $bitsAllSet: BILLED_BIT } } : {});

/**
 * Parcurge contoarele în ordinea `_id`, în loturi, și întoarce pentru fiecare lot textul CSV (fără antet) și numărătorile. `limit` = oprește după atâtea contoare (previzualizare).
 */
export async function* reportBatches(db: Db, p: ReportParams, names: Names, o: { batch?: number; limit?: number } = {}): AsyncGenerator<Batch> {
  const size = o.batch ?? 500;
  const cur = db.collection(names.meters).find(meterFilter(p.onlyBilled), { projection: { "s.n": 1, "s.e": 1, bill: 1, "attrs.ContorNr": 1, "attrs.ContPersonal": 1, "attrs.FIL": 1 } }).sort({ _id: 1 }).batchSize(1000);
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
      const pts = collapse(mergePoints(own.get(d._id) ?? [], hist.get(d._id) ?? [], p.from, p.to), p.mode);
      if (pts.length === 0) continue;
      meters++;
      const keys = meterKeys(d);
      for (const [t, v] of pts) { text += readingLine(keys, t, v); rows++; }
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
