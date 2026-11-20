import "server-only";
import { randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Document } from "mongodb";
import { COLLECTIONS, col } from "../mongo";
import {
  OTHER_TYPE,
  TYPE_SLOTS,
  emptyDict,
  type ColsWire,
  type DatasetWire,
  type DeltaFull,
  type DeltaWire,
  type Dict,
  type RowView,
  type UplinkSummary,
} from "../uplink-shared";

/**
 * STRATUL 1 de cache: lista mesajelor în memoria serverului, coloanar (vezi lib/uplink-shared.ts), construită INCREMENTAL.
 *
 * - La FIECARE cerere se verifică o „amprentă” ieftină din MongoDB (total estimat + cel mai mare `receivedAt`, ambele din metadate / index: ~ms).
 *   Amprenta identică ⇒ răspundem direct din memorie. Cererile simultane împart aceeași interogare (TTL 0,5 s) și aceeași construire (single-flight).
 * - Amprenta s-a schimbat ⇒ NU recitim colecția: aducem doar documentele cu `receivedAt` de la ultima amprentă (− 30 s de siguranță) și le adăugăm la
 *   coada listei. Mesajele sunt imutabile, deci „lista = jurnal doar-adăugare”: fiecare rând are o poziție (`base + index`) care nu se schimbă niciodată.
 *   De aici decurge și delta către browser: „dă-mi tot ce e după poziția X” (vezi buildDelta).
 * - Dicționarul (dispozitive, gateway-uri, aplicații, tipuri) doar crește în cadrul unei generații (`gen`). `gen` se schimbă doar la citire completă
 *   (pornirea procesului sau ștergeri din colecție) — atunci browserul își aruncă copia și descarcă lista din nou.
 * - Fereastra: doar ultimele UPLINK_WINDOW_DAYS zile și cel mult UPLINK_MAX_ROWS rânduri stau în memorie; restul rămâne doar în baza de date.
 * - ETag = `gen.head` (nu un hash al conținutului): răspunsul 304 nu costă nimic, iar gzip-ul se face leneș, doar când cineva cere lista întreagă.
 *
 * Gândit pentru UN proces Node de lungă durată (`next start`). Pe serverless fiecare instanță are propriul `gen`: totul rămâne corect, doar că
 * browserul reia mai des descărcarea completă în loc de delta.
 */

const WIN_MS = Math.max(1, Number(process.env.UPLINK_WINDOW_DAYS) || 30) * 86_400_000;
const MAX_ROWS = Math.max(1000, Number(process.env.UPLINK_MAX_ROWS) || 300_000);
const STAMP_TTL_MS = 500;
const OVERLAP_MS = 30_000; // mesajele salvate „în paralel” cu citirea precedentă nu se pierd
const EVICT_EVERY_MS = 10 * 60_000;
const gzipAsync = promisify(gzip);

type Stamp = { total: number; max: number };
type Cols = ColsWire & { /** receivedAt (ms) — doar pe server */ rc: number[] };
type Store = {
  gen: string;
  /** poziția (în jurnal) a primului rând păstrat */
  base: number;
  cols: Cols;
  ids: Set<string>;
  dict: Dict;
  devIdx: Map<string, number>;
  gwIdx: Map<string, number>;
  apIdx: Map<string, number>;
  tyIdx: Map<string, number>;
  stamp: Stamp;
  maxRc: number;
  evictedAt: number;
  gz: { head: number; p: Promise<Buffer> } | null;
};

const g = globalThis as unknown as {
  __ulStore?: Store;
  __ulBuild?: { p: Promise<Store> };
  __ulStamp?: { at: number; epoch: number; p: Promise<Stamp> };
  __ulEpoch?: number;
};

/** O scriere făcută de ACEST proces (ingest) invalidează imediat amprenta ținută minte 0,5 s. */
export function bumpUplinkEpoch(): void {
  g.__ulEpoch = (g.__ulEpoch ?? 0) + 1;
}

const head = (st: Store) => st.base + st.cols.id.length;
export const versionOf = (st: { gen: string; head: number }) => `"${st.gen}.${st.head}"`;

function newStore(stamp: Stamp): Store {
  return {
    gen: randomBytes(6).toString("hex"),
    base: 0,
    cols: { id: [], ts: [], dev: [], gw: [], rssi: [], snr: [], fr: [], dr: [], fl: [], fc: [], pt: [], tm: [], val: [], gn: [], rc: [] },
    ids: new Set(),
    dict: emptyDict(),
    devIdx: new Map(),
    gwIdx: new Map(),
    apIdx: new Map(),
    tyIdx: new Map(),
    stamp,
    maxRc: 0,
    evictedAt: Date.now(),
    gz: null,
  };
}

function intern(map: Map<string, number>, arr: string[], v: string): number {
  let i = map.get(v);
  if (i === undefined) {
    i = arr.length;
    arr.push(v);
    map.set(v, i);
  }
  return i;
}

function internType(st: Store, name: string): number {
  let i = st.tyIdx.get(name);
  if (i !== undefined) return i;
  if (st.dict.ty.length < TYPE_SLOTS) {
    i = st.dict.ty.length;
    st.dict.ty.push(name);
  } else {
    if (st.dict.ty.length === TYPE_SLOTS) st.dict.ty.push(OTHER_TYPE); // ultimul slot strânge tot ce depășește
    i = TYPE_SLOTS;
  }
  st.tyIdx.set(name, i);
  return i;
}

type Row = { _id: unknown; receivedAt?: Date; s?: UplinkSummary };

function addDoc(st: Store, d: Row): void {
  const s = d.s;
  if (!s) return;
  const id = String(d._id);
  if (st.ids.has(id)) return;
  const rc = d.receivedAt instanceof Date ? d.receivedAt.getTime() : s.t;

  const app = intern(st.apIdx, st.dict.ap, s.a);
  const dk = `${s.e}\u0000${s.d}`;
  let dev = st.devIdx.get(dk);
  if (dev === undefined) {
    dev = st.dict.dev.length;
    st.dict.dev.push([s.d, s.e, app]);
    st.devIdx.set(dk, dev);
  }
  let tm = 0;
  for (const t of s.ty) tm |= 1 << internType(st, t);

  const c = st.cols;
  c.id.push(id);
  c.ts.push(s.t);
  c.dev.push(dev);
  c.gw.push(s.g ? intern(st.gwIdx, st.dict.gw, s.g) : -1);
  c.rssi.push(s.r);
  c.snr.push(s.n);
  c.fr.push(s.f);
  c.dr.push(s.dr);
  c.fl.push(s.fl);
  c.fc.push(s.fc);
  c.pt.push(s.pt);
  c.tm.push(tm);
  c.val.push(s.v);
  c.gn.push(s.gn);
  c.rc.push(rc);
  st.ids.add(id);
  if (rc > st.maxRc) st.maxRc = rc;
}

const PROJECTION = { receivedAt: 1, s: 1 } as const;

async function getStamp(): Promise<Stamp> {
  const epoch = g.__ulEpoch ?? 0;
  const now = Date.now();
  const c = g.__ulStamp;
  if (c && c.epoch === epoch && now - c.at < STAMP_TTL_MS) return c.p;
  const p = (async (): Promise<Stamp> => {
    const coll = await col<Document>(COLLECTIONS.uplinks);
    const [total, last] = await Promise.all([
      coll.estimatedDocumentCount(),
      coll.find({}, { projection: { receivedAt: 1 } }).sort({ receivedAt: -1 }).limit(1).next(),
    ]);
    return { total, max: last?.receivedAt instanceof Date ? last.receivedAt.getTime() : 0 };
  })();
  g.__ulStamp = { at: now, epoch, p };
  p.catch(() => {
    if (g.__ulStamp?.p === p) g.__ulStamp = undefined;
  });
  return p;
}

async function fullBuild(stamp: Stamp): Promise<Store> {
  const coll = await col<Row>(COLLECTIONS.uplinks);
  const docs = await coll
    .find({ receivedAt: { $gte: new Date(Date.now() - WIN_MS) } }, { projection: PROJECTION })
    .sort({ receivedAt: -1 })
    .limit(MAX_ROWS)
    .toArray();
  const st = newStore(stamp);
  for (let i = docs.length - 1; i >= 0; i--) addDoc(st, docs[i]); // în ordinea sosirii
  g.__ulStore = st;
  return st;
}

async function deltaMerge(st: Store, stamp: Stamp): Promise<void> {
  const coll = await col<Row>(COLLECTIONS.uplinks);
  const cursor = coll
    .find({ receivedAt: { $gte: new Date(Math.max(0, st.maxRc - OVERLAP_MS)) } }, { projection: PROJECTION })
    .sort({ receivedAt: 1 })
    .batchSize(5000);
  for await (const d of cursor) addDoc(st, d);
  st.stamp = stamp; // amprenta luată ÎNAINTE de citire: ce s-a scris între timp se vede la verificarea următoare
  evictOld(st);
}

/** Scoate de la începutul jurnalului rândurile ieșite din fereastră (rar și în bloc: `splice` e O(n)). */
function evictOld(st: Store): void {
  const now = Date.now();
  const n = st.cols.id.length;
  if (now - st.evictedAt < EVICT_EVERY_MS && n <= MAX_ROWS * 1.2) return;
  st.evictedAt = now;
  const cutoff = now - WIN_MS;
  const rc = st.cols.rc;
  let k = 0;
  while (k < n && (rc[k] < cutoff || n - k > MAX_ROWS)) k++;
  if (k === 0) return;
  for (let i = 0; i < k; i++) st.ids.delete(st.cols.id[i]);
  for (const key of Object.keys(st.cols) as (keyof Cols)[]) (st.cols[key] as unknown[]).splice(0, k);
  st.base += k;
  st.gz = null;
}

/** Starea curentă a listei, sincronizată cu baza de date (vezi comentariul de sus). */
export async function getStore(): Promise<Store> {
  for (let attempt = 0; ; attempt++) {
    const stamp = await getStamp();
    const cur = g.__ulStore;
    if (cur && cur.stamp.total === stamp.total && cur.stamp.max === stamp.max) return cur;
    const running = g.__ulBuild;
    if (running && attempt < 6) {
      // o construire e în curs: așteptăm s-o termine, apoi reverificăm (poate a pornit pe o amprentă mai veche decât cea citită acum)
      await running.p.catch(() => {});
      continue;
    }
    const p: Promise<Store> = (cur && stamp.total >= cur.stamp.total ? deltaMerge(cur, stamp).then(() => cur) : fullBuild(stamp)).finally(() => {
      if (g.__ulBuild?.p === p) g.__ulBuild = undefined;
    });
    g.__ulBuild = { p };
    return p;
  }
}

/** Versiunea listei, DOAR dacă lista e deja în memorie (altfel pornește construirea în fundal și întoarce null — pagina nu așteaptă după ea). */
export async function warmVersion(): Promise<{ gen: string; head: number } | null> {
  if (!g.__ulStore) {
    void getStore().catch((e) => console.error("[uplinks] construirea listei:", e));
    return null;
  }
  const st = await getStore();
  return { gen: st.gen, head: head(st) };
}

function wire(st: Store, from: number): ColsWire {
  const c = st.cols;
  return {
    id: c.id.slice(from),
    ts: c.ts.slice(from),
    dev: c.dev.slice(from),
    gw: c.gw.slice(from),
    rssi: c.rssi.slice(from),
    snr: c.snr.slice(from),
    fr: c.fr.slice(from),
    dr: c.dr.slice(from),
    fl: c.fl.slice(from),
    fc: c.fc.slice(from),
    pt: c.pt.slice(from),
    tm: c.tm.slice(from),
    val: c.val.slice(from),
    gn: c.gn.slice(from),
  };
}

/** Ce e nou după poziția `after` (+ intrările de dicționar peste lungimile pe care le are deja browserul). `full` = nu se poate sprijini pe delta. */
export function buildDelta(st: Store, after: number, lens: { dev: number; gw: number; ap: number; ty: number }): DeltaWire | DeltaFull {
  const hd = head(st);
  if (after < st.base || after > hd) return { v: 2, full: true };
  return {
    v: 2,
    gen: st.gen,
    head: hd,
    total: st.stamp.total,
    dict: { dev: st.dict.dev.slice(lens.dev), gw: st.dict.gw.slice(lens.gw), ap: st.dict.ap.slice(lens.ap), ty: st.dict.ty.slice(lens.ty) },
    cols: wire(st, after - st.base),
  };
}

/** Lista întreagă, JSON gzip, memorată pe versiune: cât timp nu apar rânduri noi nu se mai recomprimă. */
export function encodedDataset(st: Store): { head: number; etag: string; gz: Promise<Buffer> } {
  const hd = head(st);
  if (!st.gz || st.gz.head !== hd) {
    const payload: DatasetWire = { v: 2, gen: st.gen, head: hd, total: st.stamp.total, dict: st.dict, cols: wire(st, 0) };
    const p = gzipAsync(JSON.stringify(payload), { level: 5 });
    const memo = { head: hd, p };
    st.gz = memo;
    p.catch(() => {
      if (st.gz === memo) st.gz = null;
    });
  }
  return { head: hd, etag: versionOf({ gen: st.gen, head: hd }), gz: st.gz.p };
}

export const storeVersion = (st: Store) => ({ gen: st.gen, head: head(st) });

const rowOf = (id: string, s: UplinkSummary): RowView => ({
  id,
  ts: s.t,
  dev: s.d,
  eui: s.e,
  app: s.a,
  gw: s.g,
  gn: s.gn,
  rssi: s.r,
  snr: s.n,
  freqKhz: s.f,
  dr: s.dr,
  fl: s.fl,
  fc: s.fc,
  pt: s.pt,
  types: s.ty,
  val: s.v,
});

/** Cele mai noi `n` rânduri + totalul, direct din baza de date (indexat): prima pictare a paginii nu așteaptă lista completă. */
export async function getHeadRows(n: number): Promise<{ rows: RowView[]; total: number }> {
  const coll = await col<Row>(COLLECTIONS.uplinks);
  const [docs, stamp] = await Promise.all([
    coll.find({}, { projection: { s: 1 } }).sort({ ts: -1 }).limit(n).toArray(),
    getStamp(),
  ]);
  return { rows: docs.filter((d) => d.s).map((d) => rowOf(String(d._id), d.s as UplinkSummary)), total: stamp.total };
}

/** Documentul întreg (payload-ul original) al unui mesaj — pentru panoul de detalii. */
export async function getUplinkPayload(id: string): Promise<{ payload: unknown; receivedAt: Date; ts: Date } | null> {
  const coll = await col<Document>(COLLECTIONS.uplinks);
  const d = await coll.findOne({ _id: id as never }, { projection: { payload: 1, receivedAt: 1, ts: 1 } });
  return d ? { payload: d.payload, receivedAt: d.receivedAt, ts: d.ts } : null;
}
