import "server-only";
import type { Document } from "mongodb";
import { COLLECTIONS, col } from "../mongo";
import { NIGHTS_COLLECTION } from "../night-job";
import { DEFAULT_PARAMS, MARK_T, NIGHTS, SLOTS, countMatches, nightLength, nightRowFromProfile, type SuspectParams } from "../night-analysis";

/**
 * „Consum nemăsurat”, în memoria serverului: profilul pe ore (consum și temperatură, ultimele NIGHTS zile) al fiecărui contor, din colecția `meter_nights`
 * (scrisă de lib/night-job.ts), în vectori compacți: ~2 octeți / oră pentru consum și 1 octet / oră pentru temperatură. Intervalul de noapte, pragurile și
 * numărul de nopți se aleg la fiecare cerere, deci filtrul răspunde instant pentru orice interval. Se reîncarcă singur când se schimbă analiza (`_meta`).
 * Nu citește nimic din SCADA. Filtrul folosește aceleași funcții (`nightRowFromProfile`, `countMatches`) ca testele din `npm run check`.
 */
type Loaded = { stamp: number; days: number[]; ids: string[]; cons: Uint16Array; temp: Int8Array; tIdx: Int32Array; withTemp: number };
const g = globalThis as unknown as { __nightSet?: { at: number; p: Promise<Loaded> } };
const CHECK_MS = 5_000;
const PER = NIGHTS * SLOTS;

async function load(): Promise<Loaded> {
  const coll = await col<Document>(NIGHTS_COLLECTION);
  const meta = await coll.findOne({ _id: "_meta" as never });
  const notMeta = { _id: { $ne: "_meta" } as never };
  const n = await coll.countDocuments(notMeta);
  const nT = await coll.countDocuments({ ...notMeta, tp: { $exists: true } });
  // câteva documente pot apărea între numărare și citire: lăsăm loc de rezervă, iar ce depășește se ignoră
  const cap = n + 64, capT = nT + 64;
  const cons = new Uint16Array(cap * PER);
  const temp = new Int8Array(capT * PER).fill(MARK_T);
  const tIdx = new Int32Array(cap).fill(-1);
  const ids: string[] = [];
  let m = 0, t = 0;
  const u8c = new Uint8Array(cons.buffer), u8t = new Uint8Array(temp.buffer);
  for await (const d of coll.find(notMeta).batchSize(1000)) {
    if (m >= cap) break;
    const c: Uint8Array | undefined = d.c?.buffer;
    if (!c || c.length !== PER * 2) continue; // profil de altă lungime (după o schimbare de configurare): se ignoră până la următoarea analiză
    u8c.set(c, m * PER * 2);
    const tp: Uint8Array | undefined = d.tp?.buffer;
    if (tp && tp.length === PER && t < capT) {
      u8t.set(tp, t * PER);
      tIdx[m] = t++;
    }
    ids.push(String(d._id));
    m++;
  }
  return { stamp: meta?.u instanceof Date ? meta.u.getTime() : 0, days: (meta?.days as number[]) ?? [], ids, cons, temp, tIdx, withTemp: t };
}

async function current(): Promise<Loaded> {
  const now = Date.now();
  const c = g.__nightSet;
  if (c && now - c.at < CHECK_MS) return c.p;
  const coll = await col<Document>(NIGHTS_COLLECTION);
  const meta = await coll.findOne({ _id: "_meta" as never }, { projection: { u: 1 } });
  const stamp = meta?.u instanceof Date ? meta.u.getTime() : 0;
  const prev = c ? await c.p.catch(() => null) : null;
  if (prev && prev.stamp === stamp) {
    g.__nightSet = { at: now, p: Promise.resolve(prev) };
    return prev;
  }
  const p = load();
  g.__nightSet = { at: now, p };
  p.catch(() => {
    if (g.__nightSet?.p === p) g.__nightSet = undefined;
  });
  return p;
}

export type SuspectRow = { id: string; name: string; branch: string | null; city: string | null; matched: number; known: number; avgNight: number | null; avgDay: number | null; minTemp: number | null; lastReading: number; volume: number | null };
export type SuspectResult = { params: SuspectParams; days: [number, number] | null; meters: number; withTemp: number; matched: number; shown: number; rows: SuspectRow[]; analyzedAt: number };

const avg = (a: (number | null)[]): number | null => {
  let s = 0, n = 0;
  for (const x of a) if (x !== null) { s += x; n++; }
  return n ? Math.round((s / n) * 100) / 100 : null;
};

export function clampParams(q: Partial<Record<keyof SuspectParams, string | null | undefined>>): SuspectParams {
  const num = (v: string | null | undefined, d: number, lo: number, hi: number) => {
    const n = v === null || v === undefined || v === "" ? NaN : Number(String(v).replace(",", "."));
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
  };
  const tempRaw = q.minTemp;
  const minTemp = tempRaw === "" || tempRaw === "none" ? null : tempRaw === null || tempRaw === undefined ? DEFAULT_PARAMS.minTemp : num(tempRaw, DEFAULT_PARAMS.minTemp ?? 22, -50, 100);
  const nights = Math.round(num(q.nights, DEFAULT_PARAMS.nights, 1, NIGHTS));
  let startHour = Math.round(num(q.startHour, DEFAULT_PARAMS.startHour, 0, 23));
  let endHour = Math.round(num(q.endHour, DEFAULT_PARAMS.endHour, 1, 24));
  if (nightLength(startHour, endHour) === 0) { startHour = DEFAULT_PARAMS.startHour; endHour = DEFAULT_PARAMS.endHour; } // interval gol: revenim la 00–06
  return {
    startHour, endHour, nights,
    maxNight: num(q.maxNight, DEFAULT_PARAMS.maxNight, 0, 1000),
    minDay: num(q.minDay, DEFAULT_PARAMS.minDay, 0, 10_000),
    minTemp,
    tempMode: q.tempMode === "day" ? "day" : "night",
    minNights: Math.round(num(q.minNights, DEFAULT_PARAMS.minNights, 1, nights)),
  };
}

export async function suspects(p: SuspectParams, limit = 500): Promise<SuspectResult> {
  const set = await current();
  const nd = set.days.length;
  const hits: { i: number; matched: number; known: number; avgNight: number | null }[] = [];
  const rowsOf = new Map<number, ReturnType<typeof nightRowFromProfile>>();
  for (let i = 0; i < set.ids.length; i++) {
    const cons = set.cons.subarray(i * PER, (i + 1) * PER);
    const ti = set.tIdx[i];
    const temp = ti >= 0 ? set.temp.subarray(ti * PER, (ti + 1) * PER) : null;
    const row = nightRowFromProfile(cons, temp, nd, p.startHour, p.endHour, p.nights);
    const { matched, known } = countMatches(row, { ...p, nights: row.nc.length });
    if (matched >= p.minNights) {
      hits.push({ i, matched, known, avgNight: avg(row.nc) });
      rowsOf.set(i, row);
    }
  }
  hits.sort((a, b) => b.matched - a.matched || (a.avgNight ?? 0) - (b.avgNight ?? 0));
  const top = hits.slice(0, limit);

  const info = new Map<string, Document>();
  if (top.length) {
    const m = await col<Document>(COLLECTIONS.meters);
    for await (const d of m.find({ _id: { $in: top.map((h) => set.ids[h.i]) } as never }, { projection: { s: 1 } })) info.set(String(d._id), d.s);
  }
  const rows: SuspectRow[] = top.map((h) => {
    const id = set.ids[h.i], r = rowsOf.get(h.i)!, s = info.get(id);
    const temps = (p.tempMode === "night" ? r.nt : r.ta).filter((x): x is number => x !== null);
    return {
      id, name: s?.n ?? id, branch: s?.br ?? null, city: s?.ct ?? null, matched: h.matched, known: h.known,
      avgNight: h.avgNight, avgDay: avg(r.dc), minTemp: temps.length ? Math.min(...temps) : null,
      lastReading: Number(s?.t ?? 0), volume: typeof s?.v === "number" ? s.v : null,
    };
  });
  return {
    params: p, days: nd ? [set.days[0], set.days[nd - 1]] : null, meters: set.ids.length, withTemp: set.withTemp,
    matched: hits.length, shown: rows.length, rows, analyzedAt: set.stamp,
  };
}
