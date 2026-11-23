import "server-only";
import type { Document } from "mongodb";
import { COLLECTIONS, col } from "../mongo";
import { NIGHTS_COLLECTION } from "../night-job";
import { DEFAULT_PARAMS, NIGHTS, countMatches, type NightRow, type SuspectParams } from "../night-analysis";

/**
 * „Consum nemăsurat”, în memoria serverului: nopțile calculate (colecția `meter_nights`, scrisă de lib/night-job.ts) pentru toate contoarele, ca să se poată
 * filtra INSTANT cu parametri editabili. Se reîncarcă singur când se schimbă analiza (momentul din documentul `_meta`).
 * Nu citește nimic din SCADA. Filtrul folosește aceeași funcție (`countMatches`) ca testele din `npm run check`.
 */
type Loaded = { stamp: number; days: number[]; ids: string[]; rows: NightRow[]; withTemp: number };
const g = globalThis as unknown as { __nightSet?: { at: number; p: Promise<Loaded> } };
const CHECK_MS = 5_000;

async function load(): Promise<Loaded> {
  const coll = await col<Document>(NIGHTS_COLLECTION);
  const meta = await coll.findOne({ _id: "_meta" as never });
  const ids: string[] = [], rows: NightRow[] = [];
  let withTemp = 0;
  for await (const d of coll.find({ _id: { $ne: "_meta" } as never }, { projection: { u: 0 } }).batchSize(2000)) {
    ids.push(String(d._id));
    const r: NightRow = { nc: d.nc, dc: d.dc, nt: d.nt, ta: d.ta };
    rows.push(r);
    if (r.nt.some((x) => x !== null)) withTemp++;
  }
  return { stamp: meta?.u instanceof Date ? meta.u.getTime() : 0, days: (meta?.days as number[]) ?? [], ids, rows, withTemp };
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

const avg = (a: (number | null)[], from: number): number | null => {
  let s = 0, n = 0;
  for (let i = from; i < a.length; i++) {
    const x = a[i];
    if (x !== null) { s += x; n++; }
  }
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
  return {
    nights,
    maxNight: num(q.maxNight, DEFAULT_PARAMS.maxNight, 0, 1000),
    minDay: num(q.minDay, DEFAULT_PARAMS.minDay, 0, 10_000),
    minTemp,
    tempMode: q.tempMode === "day" ? "day" : "night",
    minNights: Math.round(num(q.minNights, DEFAULT_PARAMS.minNights, 1, nights)),
  };
}

export async function suspects(p: SuspectParams, limit = 500): Promise<SuspectResult> {
  const set = await current();
  const hits: { i: number; matched: number; known: number }[] = [];
  for (let i = 0; i < set.rows.length; i++) {
    const { matched, known } = countMatches(set.rows[i], p);
    if (matched >= p.minNights) hits.push({ i, matched, known });
  }
  const night = (i: number) => avg(set.rows[i].nc, 0);
  hits.sort((a, b) => b.matched - a.matched || (night(a.i) ?? 0) - (night(b.i) ?? 0));
  const top = hits.slice(0, limit);

  const info = new Map<string, Document>();
  if (top.length) {
    const m = await col<Document>(COLLECTIONS.meters);
    for await (const d of m.find({ _id: { $in: top.map((h) => set.ids[h.i]) } as never }, { projection: { s: 1 } })) info.set(String(d._id), d.s);
  }
  const rows: SuspectRow[] = top.map((h) => {
    const id = set.ids[h.i], r = set.rows[h.i], s = info.get(id);
    const from = Math.max(0, r.nc.length - p.nights);
    const temps = (p.tempMode === "night" ? r.nt : r.ta).slice(from).filter((x): x is number => x !== null);
    return {
      id, name: s?.n ?? id, branch: s?.br ?? null, city: s?.ct ?? null, matched: h.matched, known: h.known,
      avgNight: avg(r.nc, from), avgDay: avg(r.dc, from), minTemp: temps.length ? Math.min(...temps) : null,
      lastReading: Number(s?.t ?? 0), volume: typeof s?.v === "number" ? s.v : null,
    };
  });
  return {
    params: p, days: set.days.length ? [set.days[0], set.days[set.days.length - 1]] : null, meters: set.ids.length, withTemp: set.withTemp,
    matched: hits.length, shown: rows.length, rows, analyzedAt: set.stamp,
  };
}
