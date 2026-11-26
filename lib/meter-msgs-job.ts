import type { Db } from "mongodb";
import { packCounts, step, unpackCounts, type MsgState } from "./meter-msgs";

/**
 * Mesajele pe zi ale fiecărui contor (colecția `meter_msgs`, un document mic pe contor: ultimul fCnt, momentul lui și KEEP_DAYS zile ca vector de 16 biți).
 * Se rulează după fiecare sincronizare: citește starea curentă a contoarelor (fCnt + momentul lui, din `meters`) și o compară cu cea reținută; scrie DOAR contoarele
 * al căror fCnt a crescut. Logica de numărare e în lib/meter-msgs.ts. Nu cere nimic în plus de la SCADA și nu atinge alte colecții.
 */
export const MSGS_COLLECTION = process.env.METER_MSGS_COLLECTION || "meter_msgs";
export type MsgDoc = { _id: string; f: number; t: number; d0: number; c: unknown; b?: number };
export type MsgStats = { meters: number; created: number; updated: number; unchanged: number };

export async function appendMsgCounts(db: Db, log: (m: string) => void = () => {}, now = Date.now()): Promise<MsgStats> {
  const meters = db.collection<{ _id: string; s?: { fc?: number; t?: number }; tel?: { fCnt?: { t?: number } } }>(process.env.METERS_COLLECTION || "meters");
  const coll = db.collection<MsgDoc>(MSGS_COLLECTION);
  const prev = new Map<string, MsgState>();
  for await (const d of coll.find({})) prev.set(String(d._id), { f: d.f, t: d.t, d0: d.d0, c: unpackCounts(d.c as never), b: d.b ?? d.d0 });
  const st: MsgStats = { meters: 0, created: 0, updated: 0, unchanged: 0 };
  const ops: Record<string, unknown>[] = [];
  for await (const m of meters.find({}, { projection: { "s.fc": 1, "s.t": 1, "tel.fCnt.t": 1 } })) {
    st.meters++;
    const id = String(m._id), p = prev.get(id) ?? null;
    const n = step(p, Number(m.s?.fc), Number(m.tel?.fCnt?.t) || Number(m.s?.t) || 0, now);
    if (!n || n === p) { st.unchanged++; continue; }
    ops.push({ replaceOne: { filter: { _id: id }, replacement: { _id: id, f: n.f, t: n.t, d0: n.d0, c: packCounts(n.c), b: n.b }, upsert: true } });
    if (p) st.updated++; else st.created++;
  }
  for (let i = 0; i < ops.length; i += 1000) await coll.bulkWrite(ops.slice(i, i + 1000) as never, { ordered: false });
  log(`mesaje pe zi: ${st.meters} contoare · ${st.created} urmărite acum, ${st.updated} cu mesaje noi, ${st.unchanged} fără schimbare`);
  return st;
}
