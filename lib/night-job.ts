import { Binary, type Db } from "mongodb";
import { unpack } from "./meter-history";
import { READINGS_COLLECTION } from "./meter-readings";
import { H, NIGHTS, hourlyProfile, lastDays, type Pt } from "./night-analysis";

/**
 * Calculează PROFILUL PE ORE (lib/night-analysis.ts: consum și temperatură pe fiecare oră, ultimele NIGHTS zile) al fiecărui contor și îl salvează în colecția `meter_nights`
 * (un document pe contor, doi vectori binari compacți). Din profil se calculează la cerere orice interval de noapte ales în pagină („de la ora X până la ora Y”).
 * Surse (doar din baza NOASTRĂ, nimic din SCADA): `meter_readings` (citirile noastre, cu temperatură) și arhiva veche de volum `meter_history`
 * (volum pe oră, fără temperatură; contează cât timp acoperă zilele analizate). Parcurge cele două colecții în ordinea `_id`, ca într-o îmbinare, deci memoria
 * rămâne mică indiferent câte contoare sunt. Rulează cel mult o dată la 20 de ore (din sincronizare), sau la cerere: npm run analyze:nights.
 * Scrie DOAR în colecția `meter_nights`.
 */
export const NIGHTS_COLLECTION = process.env.NIGHTS_COLLECTION || "meter_nights";
const HISTORY_COLLECTION = process.env.HISTORY_COLLECTION || "meter_history";
const META_ID = "_meta";
const EVERY_MS = 20 * H;

/** c = consum pe oră (Uint16, 0,001 m³; zile × 24); tp = temperatură minimă pe oră (Int8, 0,5 °C), doar dacă contorul are temperatură */
export type NightDoc = { _id: string; u: Date; c: Binary; tp?: Binary };
type Meta = { _id: string; u: Date; days: number[] };
export type AnalyzeStats = { meters: number; withNights: number; removed: number; ms: number };

type ReadingsRow = { _id: string; t: number[]; v: number[]; tp: (number | null)[] };
type ArchiveRow = { _id: string; to: number; h?: { n: number; t: unknown; v: unknown }; x?: { n: number; t: unknown; v: unknown } };

export async function lastAnalysis(db: Db): Promise<Date | null> {
  const m = await db.collection<Meta>(NIGHTS_COLLECTION).findOne({ _id: META_ID });
  return m?.u ?? null;
}

export async function analyzeAll(db: Db, log: (m: string) => void = () => {}, now: number = Date.now()): Promise<AnalyzeStats> {
  const t0 = Date.now();
  const days = lastDays(now, NIGHTS);
  const cutoff = days[0] - 12 * H;
  const out = db.collection<NightDoc>(NIGHTS_COLLECTION);
  const run = new Date(now);

  const arch = db.collection<ArchiveRow>(HISTORY_COLLECTION).find({ to: { $gte: days[0] } }, { projection: { to: 1, h: 1 } }).sort({ _id: 1 }).batchSize(300)[Symbol.asyncIterator]();
  const read = db.collection<ReadingsRow>(READINGS_COLLECTION).find({}, { projection: { t: 1, v: 1, tp: 1 } }).sort({ _id: 1 }).batchSize(1000)[Symbol.asyncIterator]();
  let na = await arch.next(), nr = await read.next();

  let ops: { replaceOne: { filter: { _id: string }; replacement: NightDoc; upsert: true } }[] = [];
  const flush = async () => {
    if (ops.length) await out.bulkWrite(ops as never, { ordered: false });
    ops = [];
  };
  let meters = 0, withNights = 0;
  while (!na.done || !nr.done) {
    const ida = na.done ? null : String(na.value._id), idr = nr.done ? null : String(nr.value._id);
    const id = ida !== null && (idr === null || ida <= idr) ? ida : (idr as string);
    const pts: Pt[] = [];
    if (ida === id) {
      const a = na.value as ArchiveRow;
      // doar volumul pe oră (Volume_m3_Total_ts = ora la care contorul a CITIT): volumul din mesaje (`x`) are ora SOSIRII în SCADA, deci ar muta consumul în altă oră a nopții
      const hp = a.h && a.h.n > 0 ? unpack(a.h as never) : [];
      for (const [t, v] of hp) if (t >= cutoff && Number.isFinite(v)) pts.push({ t, v, tp: null });
      na = await arch.next();
    }
    if (idr === id) {
      const r = nr.value as ReadingsRow;
      for (let i = 0; i < r.t.length; i++) if (r.t[i] >= cutoff && Number.isFinite(r.v[i])) pts.push({ t: r.t[i], v: r.v[i], tp: r.tp[i] ?? null });
      nr = await read.next();
    }
    meters++;
    if (pts.length < 2) continue;
    pts.sort((p, q) => p.t - q.t || (q.tp !== null ? 1 : 0) - (p.tp !== null ? 1 : 0)); // la același moment, citirea cu temperatură prima
    const dedup: Pt[] = [];
    for (const p of pts) if (!dedup.length || dedup[dedup.length - 1].t !== p.t) dedup.push(p);
    const pr = hourlyProfile(dedup, days);
    if (!pr.hasCons) continue;
    withNights++;
    const bin = (a: Uint16Array | Int8Array) => new Binary(Buffer.from(a.buffer, a.byteOffset, a.byteLength));
    ops.push({ replaceOne: { filter: { _id: id }, replacement: { _id: id, u: run, c: bin(pr.cons), ...(pr.hasTemp ? { tp: bin(pr.temp) } : {}) }, upsert: true } });
    if (ops.length >= 500) await flush();
  }
  await flush();
  const removed = (await out.deleteMany({ _id: { $ne: META_ID } as never, u: { $lt: run } })).deletedCount;
  await out.replaceOne({ _id: META_ID } as never, { _id: META_ID, u: run, days } as never, { upsert: true });
  const st = { meters, withNights, removed, ms: Date.now() - t0 };
  log(`profil pe ore: ${meters} contoare parcurse, ${withNights} cu profil calculat (ultimele ${days.length} zile), ${removed} documente vechi șterse (${Math.round(st.ms / 1000)} s)`);
  return st;
}

/** Rulează analiza doar dacă a trecut cel puțin o zi de la ultima (sau n-a rulat niciodată). */
export async function maybeAnalyze(db: Db, log: (m: string) => void = () => {}, now: number = Date.now()): Promise<AnalyzeStats | null> {
  const last = await lastAnalysis(db);
  if (last && now - last.getTime() < EVERY_MS) {
    log(`nopți: ultima analiză a fost acum ${Math.round((now - last.getTime()) / H)} h — o sar`);
    return null;
  }
  return analyzeAll(db, log, now);
}
