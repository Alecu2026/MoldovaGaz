import "server-only";
import { allowsMeter, type Viewer } from "../access";
import { KEEP_DAYS, countOn, dayIdx, dayLabel, sumOver, unpackCounts, type MsgState, type Period } from "../meter-msgs";
import { MSGS_COLLECTION, type MsgDoc } from "../meter-msgs-job";
import { col } from "../mongo";
import { clientOrder, getStore } from "./meter-dataset";

/**
 * Citirea mesajelor pe zi (colecția `meter_msgs`, vezi lib/meter-msgs-job.ts): tot tabelul stă în memorie (≈100 de octeți pe contor), reîmprospătat în fundal la 5 minute.
 * Rezultatele respectă zona utilizatorului. «Mesaje» = de câte ori a trimis contorul date (din contorul de cadre fCnt); pe o perioadă de mai multe zile se arată media pe zi.
 * Totalul de mesaje primite prin integrare (evidența din pagina Integrare) NU e aici: e o coloană a listei de contoare (`mg`, vezi lib/services/meter-dataset.ts).
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

/** [total, zile numărate] pe perioadă, sau null (nenumărat / contor din afara zonei). Pentru coloana din tabel: doar contoarele cerute. */
export async function msgsForIds(v: Viewer, ids: string[], p: Period): Promise<{ counts: Record<string, [number, number] | null> }> {
  const [tab, st] = await Promise.all([table(), getStore()]);
  const ok = zoneCheck(st, v), today = dayIdx(Date.now());
  const counts: Record<string, [number, number] | null> = {};
  for (const id of ids) {
    const i = st.idx.get(id);
    const r = i !== undefined && ok(i) ? sumOver(tab.map.get(id), p, today) : null;
    counts[id] = r ? [r.total, r.days] : null;
  }
  return { counts };
}

export type MsgRow = { id: string; name: string; branch: string; city: string; /** mesaje pe zi (media pe perioadă) */ n: number; total: number; days: number; /** total primit prin integrare (de la început) */ life: number | null; battery: number | null; rssi: number | null; last: number; /** mesaje pe zi, în ordinea `days` (null = nemăsurat) */ s: (number | null)[] };
export type MsgRanking = {
  /** perioada ceruta (AAAA-LL-ZZ … AAAA-LL-ZZ) și zilele din grafice (cele mai vechi primele) */
  from: string; to: string; days: string[];
  tracked: number; measured: number; total: number;
  /** mesaje în total în perioadă, și câte contoare au în medie cel puțin N mesaje pe zi (praguri) */
  sum: number; above: { min: number; n: number }[];
  rows: MsgRow[];
  /** de când se numără (prima zi cu date) */
  since: string;
};
export const THRESHOLDS = [10, 24, 48, 96, 144];
const SPARK_DAYS = 14;
const r1 = (x: number) => Math.round(x * 10) / 10;

export async function msgsRanking(v: Viewer, p: Period, opt: { min: number; limit: number; q: string }): Promise<MsgRanking> {
  const [tab, st] = await Promise.all([table(), getStore()]);
  const ok = zoneCheck(st, v);
  const today = dayIdx(Date.now());
  const days = Array.from({ length: SPARK_DAYS }, (_, k) => today - SPARK_DAYS + 1 + k);
  const needle = opt.q.trim().toLowerCase();
  type C = { id: string; i: number; avg: number; total: number; days: number };
  const cand: C[] = [];
  let tracked = 0, measured = 0, sum = 0;
  const above = THRESHOLDS.map((min) => ({ min, n: 0 }));
  for (const [id, s] of tab.map) {
    const i = st.idx.get(id);
    if (i === undefined || !ok(i)) continue;
    tracked++;
    const r = sumOver(s, p, today);
    if (!r) continue;
    const avg = r.total / r.days;
    measured++; sum += r.total;
    for (const a of above) if (avg >= a.min) a.n++;
    if (avg < opt.min) continue;
    if (needle && !`${st.cols.nm[i]} ${st.cols.q[i]}`.toLowerCase().includes(needle)) continue;
    cand.push({ id, i, avg, total: r.total, days: r.days });
  }
  cand.sort((a, b) => b.avg - a.avg || a.id.localeCompare(b.id));
  const rows: MsgRow[] = cand.slice(0, opt.limit).map(({ id, i, avg, total, days: nd }) => {
    const s = tab.map.get(id);
    const b = st.cols.br[i], t = st.cols.ct[i], bat = st.cols.bat[i], rs = st.cols.rssi[i];
    return { id, name: st.cols.nm[i], branch: b >= 0 ? st.dict.br[b] : "", city: t >= 0 ? st.dict.ct[t] : "", n: r1(avg), total, days: nd, life: st.cols.mg[i] ?? null, battery: bat ?? null, rssi: rs ?? null, last: st.cols.ts[i], s: days.map((d) => countOn(s, d, today)) };
  });
  return { from: dayLabel(p.from), to: dayLabel(p.to), days: days.map(dayLabel), tracked, measured, total: cand.length, sum, above, rows, since: dayLabel(tab.since) };
}

/**
 * Valorile pentru TOATE contoarele, pe poziție în lista utilizatorului (pentru sortarea tabelului după mesaje): totalul pe perioadă (16 biți) și zilele numărate (8 biți),
 * ca șiruri base64. `probes` = câteva (poziție, id) ca browserul să verifice că lista lui are aceeași ordine înainte să folosească valorile; `gen` = generația listei.
 */
export type MsgAll = { gen: string; n: number; probes: [number, string][]; t: string; d: string };
export async function msgsAll(v: Viewer, p: Period): Promise<MsgAll> {
  const [tab, order] = await Promise.all([table(), clientOrder(v)]);
  const today = dayIdx(Date.now()), n = order.ids.length;
  const t = Buffer.alloc(n * 2), d = Buffer.alloc(n);
  for (let i = 0; i < n; i++) {
    const r = sumOver(tab.map.get(order.ids[i]), p, today);
    if (r) { t.writeUInt16LE(Math.min(65_535, r.total), i * 2); d[i] = Math.min(255, r.days); }
  }
  const probes: [number, string][] = [];
  for (let k = 0; k < 8 && n > 0; k++) { const pos = Math.min(n - 1, Math.floor((k * n) / 8)); probes.push([pos, order.ids[pos]]); }
  if (n > 0) probes.push([n - 1, order.ids[n - 1]]);
  return { gen: order.gen, n, probes, t: t.toString("base64"), d: d.toString("base64") };
}
export { KEEP_DAYS };
