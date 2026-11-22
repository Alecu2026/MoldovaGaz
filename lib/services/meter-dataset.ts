import "server-only";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Document } from "mongodb";
import { COLLECTIONS, col } from "../mongo";
import { OTHER_TYPE, TYPE_SLOTS, emptyDict, type ColsWire, type DatasetWire, type DeltaFull, type DeltaWire, type Dict, type MeterSummary, type RowView } from "../meter-shared";

/**
 * STRATUL 1 de cache: lista contoarelor în memoria serverului, coloanar (vezi lib/meter-shared.ts), construită INCREMENTAL.
 *
 * - Colecția `meters` o scrie scriptul de sincronizare (scripts/sync-meters.ts, din pm2, la câteva minute) și doar pentru contoarele ale căror date s-au
 *   schimbat (`updatedAt` nou). La FIECARE cerere se verifică o „amprentă” ieftină (total estimat + cel mai mare `updatedAt`, din metadate / index: ~ms).
 *   Amprenta identică ⇒ răspundem din memorie. Cererile simultane împart aceeași interogare (TTL 0,5 s) și aceeași construire (single-flight).
 * - Amprenta s-a schimbat (sau a trecut un minut) ⇒ NU recitim colecția: aducem doar documentele cu `updatedAt` recent și suprascriem rândurile din memorie.
 *   Fiecare rând modificat primește un `seq` global crescător; delta către browser = „rândurile cu seq mai mare decât cel pe care îl ai”.
 * - Dicționarele (aplicații, concentratoare, tipuri, filiale, orașe, profile) doar cresc în cadrul unei generații (`gen`). `gen` se schimbă doar la citire
 *   completă (pornirea procesului sau contoare dispărute din sursă) — atunci browserul își aruncă copia și descarcă lista din nou.
 * - ETag = `gen.seq`: răspunsul 304 nu costă nimic, iar gzip-ul se face leneș, doar când cineva cere lista întreagă.
 *
 * Gândit pentru UN proces Node de lungă durată (`next start`). Pe serverless fiecare instanță are propriul `gen`: totul rămâne corect, doar că
 * browserul reia mai des descărcarea completă în loc de delta.
 */
const STAMP_TTL_MS = 500;
const OVERLAP_MS = 120_000; // documentele scrise „în paralel” cu citirea precedentă nu se pierd (la hash egal, rândul rămâne neschimbat)
const MERGE_EVERY_MS = 60_000; // plasă de siguranță: o interogare de delta pe minut chiar dacă amprenta nu s-a mișcat
const gzipAsync = promisify(gzip);

type Stamp = { total: number; max: number };
type Cols = ColsWire & { /** seq-ul ultimei modificări a rândului */ sq: number[]; /** hash-ul documentului */ h: string[] };
type Store = {
  gen: string;
  seq: number;
  cols: Cols;
  idx: Map<string, number>;
  dict: Dict;
  maps: { ap: Map<string, number>; gw: Map<string, number>; ty: Map<string, number>; br: Map<string, number>; ct: Map<string, number>; pf: Map<string, number> };
  stamp: Stamp;
  maxUpd: number;
  mergedAt: number;
  gz: { seq: number; p: Promise<Buffer> } | null;
};

const g = globalThis as unknown as { __mtStore?: Store; __mtBuild?: { p: Promise<Store> }; __mtStamp?: { at: number; epoch: number; p: Promise<Stamp> }; __mtEpoch?: number };

/** O scriere făcută de ACEST proces invalidează imediat amprenta ținută minte 0,5 s. */
export function bumpMeterEpoch(): void {
  g.__mtEpoch = (g.__mtEpoch ?? 0) + 1;
}

export const versionOf = (st: { gen: string; head: number }) => `"${st.gen}.${st.head}"`;

function newStore(stamp: Stamp): Store {
  return {
    gen: randomBytes(6).toString("hex"),
    seq: 0,
    cols: { id: [], ts: [], nm: [], eu: [], q: [], ap: [], gw: [], br: [], ct: [], pf: [], rssi: [], snr: [], fr: [], fl: [], fc: [], pt: [], tm: [], val: [], bat: [], dc: [], mc: [], sq: [], h: [] },
    idx: new Map(),
    dict: emptyDict(),
    maps: { ap: new Map(), gw: new Map(), ty: new Map(), br: new Map(), ct: new Map(), pf: new Map() },
    stamp,
    maxUpd: 0,
    mergedAt: Date.now(),
    gz: null,
  };
}

function intern(map: Map<string, number>, arr: string[], v: string | null | undefined): number {
  if (!v) return -1;
  let i = map.get(v);
  if (i === undefined) {
    i = arr.length;
    arr.push(v);
    map.set(v, i);
  }
  return i;
}

function typeBit(st: Store, name: string | null): number {
  if (!name) return 0;
  let i = st.maps.ty.get(name);
  if (i === undefined) {
    if (st.dict.ty.length < TYPE_SLOTS) {
      i = st.dict.ty.length;
      st.dict.ty.push(name);
    } else {
      if (st.dict.ty.length === TYPE_SLOTS) st.dict.ty.push(OTHER_TYPE); // ultimul slot strânge tot ce depășește
      i = TYPE_SLOTS;
    }
    st.maps.ty.set(name, i);
  }
  return 1 << i;
}

type Row = { _id: unknown; updatedAt?: Date; h?: string; s?: MeterSummary };

/** Adaugă sau suprascrie un rând. Întoarce true dacă s-a schimbat ceva (hash diferit sau rând nou). */
function upsertDoc(st: Store, d: Row): boolean {
  const s = d.s;
  if (!s) return false;
  const id = String(d._id);
  const c = st.cols;
  const known = st.idx.get(id);
  const h = d.h ?? "";
  if (d.updatedAt instanceof Date) st.maxUpd = Math.max(st.maxUpd, d.updatedAt.getTime());
  if (known !== undefined && h && c.h[known] === h) return false;
  const i = known ?? c.id.length;
  if (known === undefined) st.idx.set(id, i);
  const mi = st.dict;
  c.id[i] = id; c.ts[i] = s.t; c.nm[i] = s.n; c.eu[i] = s.e; c.q[i] = s.q;
  c.ap[i] = intern(st.maps.ap, mi.ap, s.a); c.gw[i] = intern(st.maps.gw, mi.gw, s.g); c.br[i] = intern(st.maps.br, mi.br, s.br);
  c.ct[i] = intern(st.maps.ct, mi.ct, s.ct); c.pf[i] = intern(st.maps.pf, mi.pf, s.pf);
  c.rssi[i] = s.r; c.snr[i] = s.sn; c.fr[i] = s.f; c.fl[i] = s.fl; c.fc[i] = s.fc; c.pt[i] = s.pt; c.tm[i] = typeBit(st, s.ty);
  c.val[i] = s.v; c.bat[i] = s.b; c.dc[i] = s.dc; c.mc[i] = s.mc;
  c.sq[i] = ++st.seq;
  c.h[i] = h;
  st.gz = null;
  return true;
}

const PROJECTION = { updatedAt: 1, h: 1, s: 1 } as const;

async function getStamp(): Promise<Stamp> {
  const epoch = g.__mtEpoch ?? 0;
  const now = Date.now();
  const c = g.__mtStamp;
  if (c && c.epoch === epoch && now - c.at < STAMP_TTL_MS) return c.p;
  const p = (async (): Promise<Stamp> => {
    const coll = await col<Document>(COLLECTIONS.meters);
    const [total, last] = await Promise.all([coll.estimatedDocumentCount(), coll.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next()]);
    return { total, max: last?.updatedAt instanceof Date ? last.updatedAt.getTime() : 0 };
  })();
  g.__mtStamp = { at: now, epoch, p };
  p.catch(() => {
    if (g.__mtStamp?.p === p) g.__mtStamp = undefined;
  });
  return p;
}

async function fullBuild(stamp: Stamp): Promise<Store> {
  const coll = await col<Row>(COLLECTIONS.meters);
  const st = newStore(stamp);
  for await (const d of coll.find({}, { projection: PROJECTION }).sort({ _id: 1 }).batchSize(5000)) upsertDoc(st, d);
  g.__mtStore = st;
  return st;
}

async function deltaMerge(st: Store, stamp: Stamp): Promise<boolean> {
  const coll = await col<Row>(COLLECTIONS.meters);
  for await (const d of coll.find({ updatedAt: { $gte: new Date(Math.max(0, st.maxUpd - OVERLAP_MS)) } }, { projection: PROJECTION }).batchSize(5000)) upsertDoc(st, d);
  st.stamp = stamp; // amprenta luată ÎNAINTE de citire: ce s-a scris între timp se vede la verificarea următoare
  st.mergedAt = Date.now();
  if (st.cols.id.length === stamp.total) return true;
  // Numărătoarea estimată (metadate) poate fi ușor depășită (ex. după o oprire bruscă): înainte să reconstruim tot, o verificăm exact.
  // Dacă diferă și exact, au dispărut contoare ⇒ reconstruim; altfel lista din memorie e corectă și nu pierdem timp refăcând-o.
  return (await coll.countDocuments({})) === st.cols.id.length;
}

/** Starea curentă a listei, sincronizată cu baza de date (vezi comentariul de sus). */
export async function getStore(): Promise<Store> {
  for (let attempt = 0; ; attempt++) {
    const stamp = await getStamp();
    const cur = g.__mtStore;
    if (cur && cur.stamp.total === stamp.total && cur.stamp.max === stamp.max && Date.now() - cur.mergedAt < MERGE_EVERY_MS) return cur;
    const running = g.__mtBuild;
    if (running && attempt < 6) {
      await running.p.catch(() => {});
      continue;
    }
    const p: Promise<Store> = (async () => {
      if (cur) {
        if (await deltaMerge(cur, stamp)) return cur;
      }
      return fullBuild(stamp);
    })().finally(() => {
      if (g.__mtBuild?.p === p) g.__mtBuild = undefined;
    });
    g.__mtBuild = { p };
    return p;
  }
}

/** Versiunea listei, DOAR dacă lista e deja în memorie (altfel pornește construirea în fundal și întoarce null — pagina nu așteaptă după ea). */
export async function warmVersion(): Promise<{ gen: string; head: number } | null> {
  if (!g.__mtStore) {
    void getStore().catch((e) => console.error("[meters] construirea listei:", e));
    return null;
  }
  const st = await getStore();
  return { gen: st.gen, head: st.seq };
}

const COLS: (keyof ColsWire)[] = ["id", "ts", "nm", "eu", "q", "ap", "gw", "br", "ct", "pf", "rssi", "snr", "fr", "fl", "fc", "pt", "tm", "val", "bat", "dc", "mc"];

/** Rândurile cu seq > `after` (0 = toate), în ordinea indexului. */
function wire(st: Store, after: number): ColsWire {
  const c = st.cols;
  const out = Object.fromEntries(COLS.map((k) => [k, [] as unknown[]])) as unknown as Record<keyof ColsWire, unknown[]>;
  for (let i = 0; i < c.id.length; i++) {
    if (c.sq[i] <= after) continue;
    for (const k of COLS) out[k].push(c[k][i]);
  }
  return out as unknown as ColsWire;
}

/** Ce s-a schimbat după `after` (+ intrările de dicționar peste lungimile pe care le are deja browserul). `full` = nu se poate sprijini pe delta. */
export function buildDelta(st: Store, after: number, lens: Record<keyof Dict, number>): DeltaWire | DeltaFull {
  if (after > st.seq) return { v: 3, full: true };
  return {
    v: 3, gen: st.gen, head: st.seq, total: st.stamp.total,
    dict: { ap: st.dict.ap.slice(lens.ap), gw: st.dict.gw.slice(lens.gw), ty: st.dict.ty.slice(lens.ty), br: st.dict.br.slice(lens.br), ct: st.dict.ct.slice(lens.ct), pf: st.dict.pf.slice(lens.pf) },
    cols: wire(st, after),
  };
}

/** Lista întreagă, JSON gzip, memorată pe versiune: cât timp nu apar modificări nu se mai recomprimă. */
export function encodedDataset(st: Store): { etag: string; gz: Promise<Buffer> } {
  if (!st.gz || st.gz.seq !== st.seq) {
    const payload: DatasetWire = { v: 3, gen: st.gen, head: st.seq, total: st.stamp.total, dict: st.dict, cols: wire(st, 0) };
    const p = gzipAsync(JSON.stringify(payload), { level: 5 });
    const memo = { seq: st.seq, p };
    st.gz = memo;
    p.catch(() => {
      if (st.gz === memo) st.gz = null;
    });
  }
  return { etag: versionOf({ gen: st.gen, head: st.seq }), gz: st.gz.p };
}

const rowOf = (id: string, s: MeterSummary): RowView => ({
  id, ts: s.t, name: s.n, eui: s.e, app: s.a, gw: s.g, rssi: s.r, snr: s.sn, freqKhz: s.f, fl: s.fl, fc: s.fc, pt: s.pt, types: s.ty ? [s.ty] : [],
  val: s.v, bat: s.b, dc: s.dc, mc: s.mc, branch: s.br, city: s.ct, profile: s.pf,
});

/** Cele mai recente `n` contoare + totalul, direct din baza de date (indexat): prima pictare a paginii nu așteaptă lista completă. */
export async function getHeadRows(n: number): Promise<{ rows: RowView[]; total: number }> {
  const coll = await col<Row>(COLLECTIONS.meters);
  const [docs, stamp] = await Promise.all([coll.find({}, { projection: { s: 1 } }).sort({ "s.t": -1 }).limit(n).toArray(), getStamp()]);
  return { rows: docs.filter((d) => d.s).map((d) => rowOf(String(d._id), d.s as MeterSummary)), total: stamp.total };
}

/** Documentul întreg al unui contor (facturare, atribute, ultima telemetrie) — pentru panoul de detalii. */
export async function getMeterDoc(id: string): Promise<Document | null> {
  const coll = await col<Document>(COLLECTIONS.meters);
  return coll.findOne({ _id: id as never }, { projection: { h: 0 } });
}
