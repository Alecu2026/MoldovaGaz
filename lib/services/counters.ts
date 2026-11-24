import "server-only";
import type { Document } from "mongodb";
import { counterOf, lostOf, newStream, observe, summarize, type CStream, type PrevRun } from "../integration-counter";
import { col } from "../mongo";

/**
 * Verificarea continuității (vezi lib/integration-counter.ts): numerele de pe mesaje se înregistrează la PRIMIRE, după ce mesajele au fost salvate durabil și
 * înainte de răspunsul „primit”. Starea fluxurilor e în memorie și în colecția `integration_counters` (un document pe flux). Scrierile se fac într-o coadă, în ordine,
 * cu starea CEA MAI NOUĂ; dacă o scriere eșuează, memoria se reîncarcă din baza de date (deci nu rămâne o stare care nu e salvată) și cererea eșuează (⇒ se reîncearcă).
 */
export const COUNTERS = process.env.INTEGRATION_COUNTERS_COLLECTION || "integration_counters";
const g = globalThis as unknown as { __counters?: { map: Map<string, CStream> | null; loading: Promise<Map<string, CStream>> | null; chain: Promise<unknown> } };
const st = () => (g.__counters ??= { map: null, loading: null, chain: Promise.resolve() });

async function streams(): Promise<Map<string, CStream>> {
  const s = st();
  if (s.map) return s.map;
  s.loading ??= (async () => {
    const m = new Map<string, CStream>();
    for (const d of await (await col<Document>(COUNTERS)).find({}).toArray()) m.set(String(d._id), { ...(d as unknown as CStream), id: String(d._id) });
    s.map = m;
    return m;
  })().finally(() => { s.loading = null; });
  return s.loading;
}

/** Înregistrează numerele din mesajele tocmai salvate. Aruncă dacă starea nu se poate salva. */
export async function trackCounters(items: unknown[], now: number): Promise<void> {
  const found = items.map(counterOf).filter((x): x is NonNullable<ReturnType<typeof counterOf>> => x !== null);
  if (!found.length) return;
  const map = await streams();
  const touched = new Set<string>();
  for (const f of found) { // fără await aici: tot lotul se înregistrează într-o singură bucată, în ordinea sosirii
    const cur = map.get(f.stream);
    if (!cur) map.set(f.stream, newStream(f.stream, f.field, f.value, now));
    else if (observe(cur, f.value, now) === "restart") {
      // expeditorul și-a șters contorul și o ia de la capăt: seria veche rămâne ca rezumat, seria nouă începe de la acest număr
      const fresh = newStream(f.stream, f.field, f.value, now);
      fresh.prev = [...(cur.prev ?? []), summarize(cur)].slice(-5);
      map.set(f.stream, fresh);
    }
    touched.add(f.stream);
  }
  const s = st();
  const write = s.chain.then(async () => {
    const coll = await col<Document>(COUNTERS);
    await Promise.all([...touched].map((id) => {
      const cur = map.get(id);
      if (!cur) return null;
      const { id: _id, ...rest } = cur;
      return coll.replaceOne({ _id: _id as never }, rest as never, { upsert: true, writeConcern: { w: 1, j: true } });
    }));
  });
  s.chain = write.catch(() => undefined);
  try {
    await write;
  } catch (e) {
    s.map = null; // memoria se reia din baza de date
    throw e;
  }
}

export type CounterRow = {
  id: string; field: string; first: number; last: number; expected: number; received: number; lost: number; dup: number; late: number;
  gaps: { from: number; to: number; size: number; at: number }[]; hiddenGaps: number; firstAt: number; lastAt: number;
  /** seriile anterioare (repornite automat când numărul a scăzut) */
  prev: PrevRun[];
};

export async function counterReport(): Promise<{ streams: CounterRow[] }> {
  const map = await streams();
  const rows = [...map.values()].map((s): CounterRow => {
    const gaps = s.missing.slice(-100).reverse().map(([from, to, at]) => ({ from, to, size: to - from + 1, at }));
    return {
      id: s.id, field: s.field, first: s.first, last: s.max, expected: s.max - s.first + 1, received: s.received, lost: lostOf(s), dup: s.dup, late: s.late,
      gaps, hiddenGaps: Math.max(0, s.missing.length - gaps.length) + (s.dropped ? 1 : 0), firstAt: s.firstAt, lastAt: s.lastAt, prev: s.prev ?? [],
    };
  });
  rows.sort((a, b) => b.lastAt - a.lastAt);
  return { streams: rows };
}

/** „Test nou”: șterge un flux (sau toate). */
export async function resetCounters(id: string | "all"): Promise<void> {
  const s = st();
  const write = s.chain.then(async () => {
    const coll = await col<Document>(COUNTERS);
    if (id === "all") await coll.deleteMany({});
    else await coll.deleteOne({ _id: id as never });
  });
  s.chain = write.catch(() => undefined);
  await write;
  s.map = null;
}
