import "server-only";
import { allowsMeter, type Viewer } from "../access";
import { KEEP_DAYS, countOn, dayIdx, dayLabel, unpackCounts, type MsgState } from "../meter-msgs";
import { MSGS_COLLECTION, type MsgDoc } from "../meter-msgs-job";
import { col } from "../mongo";
import { getStore } from "./meter-dataset";

/**
 * Citirea mesajelor pe zi (colecția `meter_msgs`, vezi lib/meter-msgs-job.ts): tot tabelul stă în memorie (≈100 de octeți pe contor), reîmprospătat în fundal la 5 minute
 * (se schimbă doar la sincronizarea orară). Rezultatele respectă zona utilizatorului.
 */
const g = globalThis as unknown as { __msgTab?: { at: number; map: Map<string, MsgState>; since: number }; __msgBusy?: Promise<void> | null };
const TTL = 5 * 60_000;

async function load(): Promise<void> {
  const docs = await (await col<MsgDoc>(MSGS_COLLECTION)).find({}).toArray();
  const map = new Map<string, MsgState>();
  let since = Infinity;
  for (const d of docs) { map.set(String(d._id), { f: d.f, t: d.t, d0: d.d0, c: unpackCounts(d.c as never), b: d.b ?? d.d0 }); since = Math.min(since, d.b ?? d.d0); }
  g.__msgTab = { at: Date.now(), map, since: Number.isFinite(since) ? since : dayIdx(Date.now()) };
}
async function table() {
  const cur = g.__msgTab;
  if (cur && Date.now() - cur.at < TTL) return cur;
  if (!g.__msgBusy) { const p = load(); g.__msgBusy = p; void p.then(() => undefined, () => undefined).then(() => { g.__msgBusy = null; }); }
  if (!cur) await g.__msgBusy;
  return (g.__msgTab ?? cur) as NonNullable<typeof g.__msgTab>;
}

/** Contorul (rândul `i` din listă) e în zona utilizatorului? Verdictul se ține pe (filială, oraș). */
function zoneCheck(st: Awaited<ReturnType<typeof getStore>>, v: Viewer) {
  if (v.admin || v.access.allZones) return () => true;
  const verdict = new Map<number, boolean>();
  return (i: number): boolean => {
    const b = st.cols.br[i], t = st.cols.ct[i], k = b * 100_003 + t;
    let ok = verdict.get(k);
    if (ok === undefined) { ok = allowsMeter(v, b >= 0 ? st.dict.br[b] : "", t >= 0 ? st.dict.ct[t] : ""); verdict.set(k, ok); }
    return ok;
  };
}

/** Mesajele în ziua `day` pentru contoarele date (null = nu e urmărit / ziua nu e păstrată / contor din afara zonei). */
export async function msgsForIds(v: Viewer, ids: string[], day: number): Promise<Record<string, number | null>> {
  const [tab, st] = await Promise.all([table(), getStore()]);
  const ok = zoneCheck(st, v);
  const out: Record<string, number | null> = {};
  for (const id of ids) {
    const i = st.idx.get(id);
    out[id] = i === undefined || !ok(i) ? null : countOn(tab.map.get(id), day);
  }
  return out;
}

export type MsgRow = { id: string; name: string; branch: string; city: string; n: number; battery: number | null; rssi: number | null; last: number; /** mesaje pe zi, în ordinea `days` (null = nemăsurat) */ s: (number | null)[] };
export type MsgRanking = {
  /** ziua cerută (AAAA-LL-ZZ) și zilele păstrate (cele mai vechi primele) */
  day: string; days: string[];
  /** contoare urmărite (cu cel puțin o observare) în zona ta, și câte au o valoare pentru ziua cerută */
  tracked: number; measured: number; total: number;
  /** mesaje în total în ziua cerută, și câte contoare au cel puțin N mesaje (praguri) */
  sum: number; above: { min: number; n: number }[];
  /** contoarele cele mai active, în ordine descrescătoare (cel mult `limit`) */
  rows: MsgRow[];
  /** de când se numără (prima zi cu date) */
  since: string;
};
export const THRESHOLDS = [10, 24, 48, 96, 144];

export async function msgsRanking(v: Viewer, day: number, opt: { min: number; limit: number; q: string }): Promise<MsgRanking> {
  const [tab, st] = await Promise.all([table(), getStore()]);
  const ok = zoneCheck(st, v);
  const today = dayIdx(Date.now());
  const days = Array.from({ length: KEEP_DAYS }, (_, k) => today - KEEP_DAYS + 1 + k);
  const needle = opt.q.trim().toLowerCase();
  type C = { id: string; i: number; n: number };
  const cand: C[] = [];
  let tracked = 0, measured = 0, sum = 0;
  const above = THRESHOLDS.map((min) => ({ min, n: 0 }));
  for (const [id, s] of tab.map) {
    const i = st.idx.get(id);
    if (i === undefined || !ok(i)) continue;
    tracked++;
    const n = countOn(s, day);
    if (n === null) continue;
    measured++; sum += n;
    for (const a of above) if (n >= a.min) a.n++;
    if (n < opt.min) continue;
    if (needle && !`${st.cols.nm[i]} ${st.cols.q[i]}`.toLowerCase().includes(needle)) continue;
    cand.push({ id, i, n });
  }
  cand.sort((a, b) => b.n - a.n || a.id.localeCompare(b.id));
  const rows: MsgRow[] = cand.slice(0, opt.limit).map(({ id, i, n }) => {
    const s = tab.map.get(id);
    const b = st.cols.br[i], t = st.cols.ct[i], bat = st.cols.bat[i], rs = st.cols.rssi[i];
    return { id, name: st.cols.nm[i], branch: b >= 0 ? st.dict.br[b] : "", city: t >= 0 ? st.dict.ct[t] : "", n, battery: bat ?? null, rssi: rs ?? null, last: st.cols.ts[i], s: days.map((d) => countOn(s, d)) };
  });
  return { day: dayLabel(day), days: days.map(dayLabel), tracked, measured, total: cand.length, sum, above, rows, since: dayLabel(tab.since) };
}
