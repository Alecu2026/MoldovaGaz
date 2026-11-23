import type { Db } from "mongodb";
import type { MeterDoc } from "./meter-sync";

/**
 * Istoricul NOSTRU de citiri (colecția `meter_readings`): la fiecare sincronizare, pentru fiecare contor cu o citire NOUĂ (momentul citirii de la contor e mai nou
 * decât cel salvat) se adaugă un punct: momentul citirii, volumul total și temperatura din același mesaj. Nu cere nimic în plus de la SCADA: folosește valorile
 * pe care sincronizarea le citește oricum. Din el se calculează „Consum nemăsurat” (lib/night-analysis.ts).
 *
 * Un document pe contor: { _id, lt: ultimul moment, t: [moment…], v: [volum…], tp: [temperatură | null…] }; se păstrează ultimele MAX_READINGS puncte
 * (≈ 60–80 de zile la un mesaj la 4–6 ore). Scrie DOAR în această colecție.
 */
export const READINGS_COLLECTION = process.env.READINGS_COLLECTION || "meter_readings";
export const MAX_READINGS = 400;
/** temperatura se ia în seamă doar dacă e din același mesaj (la cel mult 6 ore de citirea de volum) */
const TEMP_MAX_AGE_MS = 6 * 3_600_000;

type ReadingDoc = { _id: string; lt: number; t: number[]; v: number[]; tp: (number | null)[] };
export type AppendStats = { candidates: number; created: number; appended: number; unchanged: number };

/** Punctul nou al unui contor (null dacă nu are volum cu moment sau volumul e invalid). */
export function readingOf(d: Pick<MeterDoc, "tel">): { t: number; v: number; tp: number | null } | null {
  const vol = d.tel.Volume_m3_Total;
  if (!vol || !(vol.t > 0)) return null;
  const v = Number(String(vol.v).replace(",", "."));
  if (!Number.isFinite(v) || v < 0) return null;
  const tm = d.tel.temp;
  const tpv = tm ? Number(String(tm.v).replace(",", ".")) : NaN;
  const tp = tm && Number.isFinite(tpv) && Math.abs(tm.t - vol.t) <= TEMP_MAX_AGE_MS ? tpv : null;
  return { t: vol.t, v, tp };
}

export async function appendReadings(db: Db, docs: Pick<MeterDoc, "_id" | "tel">[], log: (m: string) => void = () => {}): Promise<AppendStats> {
  const coll = db.collection<ReadingDoc>(READINGS_COLLECTION);
  const last = new Map<string, number>();
  for await (const x of coll.find({}, { projection: { lt: 1 } })) last.set(String(x._id), x.lt);

  type Op = { insertOne: { document: ReadingDoc } } | { updateOne: { filter: { _id: string; lt: { $lt: number } }; update: Record<string, unknown> } };
  const ops: Op[] = [];
  const st: AppendStats = { candidates: 0, created: 0, appended: 0, unchanged: 0 };
  for (const d of docs) {
    const r = readingOf(d);
    if (!r) continue;
    st.candidates++;
    const lt = last.get(d._id);
    if (lt === undefined) {
      ops.push({ insertOne: { document: { _id: d._id, lt: r.t, t: [r.t], v: [r.v], tp: [r.tp] } } });
      st.created++;
    } else if (r.t > lt) {
      ops.push({ updateOne: { filter: { _id: d._id, lt: { $lt: r.t } }, update: { $push: { t: { $each: [r.t], $slice: -MAX_READINGS }, v: { $each: [r.v], $slice: -MAX_READINGS }, tp: { $each: [r.tp], $slice: -MAX_READINGS } }, $set: { lt: r.t } } } });
      st.appended++;
    } else st.unchanged++;
  }
  for (let i = 0; i < ops.length; i += 1000) await coll.bulkWrite(ops.slice(i, i + 1000) as never, { ordered: false });
  log(`citiri: ${st.candidates} contoare cu citire · ${st.created} contoare noi în istoric, ${st.appended} citiri adăugate, ${st.unchanged} fără citire nouă`);
  return st;
}
