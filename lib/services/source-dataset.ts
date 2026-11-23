import "server-only";
import { promisify } from "node:util";
import { gzip } from "node:zlib";
import type { Document } from "mongodb";
import { COLLECTIONS, col } from "../mongo";
import { columnarize, sourceTable } from "../source-schemas";
import type { SourceId, SourceWire } from "../source-shared";

/**
 * Cache-ul serverului pentru paginile pe sursă (lorawandb / getmgdb): lista întreagă, coloanar, gzip, în memoria procesului.
 *
 * Rândurile brute le scrie scripts/sync-sources.ts (din sincronizarea de la 10 minute) în colecțiile `src_lorawan` / `src_billing`.
 * La fiecare cerere se verifică o „amprentă” ieftină (total estimat + cel mai mare `updatedAt`, din metadate / index). Aceeași amprentă ⇒ răspundem
 * din memorie; amprenta nouă ⇒ lista se reconstruiește O DATĂ (single-flight), apoi gzip-ul se face o dată și se memorează.
 * ETag = amprenta (nu o valoare generată la pornire): după o repornire a serverului browserul primește tot 304.
 * Sursele se schimbă rar (nu au citiri la minut ca ThingsBoard), deci nu avem nevoie de delta: o descărcare completă (câțiva MB gzip) la schimbare.
 */
const STAMP_TTL_MS = 1000;
const SCHEMA = 1; // se mărește când se schimbă coloanele: browserele cu o listă veche o aruncă
const gzipAsync = promisify(gzip);

type Stamp = { total: number; max: number };
type Built = { stamp: Stamp; etag: string; gz: Promise<Buffer>; total: number };
type Slot = { built?: Built; build?: Promise<Built>; stamp?: { at: number; p: Promise<Stamp> } };

const g = globalThis as unknown as { __srcSlots?: Partial<Record<SourceId, Slot>> };
const slot = (s: SourceId): Slot => ((g.__srcSlots ??= {})[s] ??= {});
const collectionOf = (s: SourceId) => (s === "lorawan" ? COLLECTIONS.srcLorawan : COLLECTIONS.srcBilling);

async function getStamp(source: SourceId): Promise<Stamp> {
  const sl = slot(source);
  const now = Date.now();
  if (sl.stamp && now - sl.stamp.at < STAMP_TTL_MS) return sl.stamp.p;
  const p = (async (): Promise<Stamp> => {
    const coll = await col<Document>(collectionOf(source));
    const [total, last] = await Promise.all([coll.estimatedDocumentCount(), coll.find({}, { projection: { updatedAt: 1 } }).sort({ updatedAt: -1 }).limit(1).next()]);
    return { total, max: last?.updatedAt instanceof Date ? last.updatedAt.getTime() : 0 };
  })();
  sl.stamp = { at: now, p };
  p.catch(() => {
    if (sl.stamp?.p === p) sl.stamp = undefined;
  });
  return p;
}

async function build(source: SourceId, stamp: Stamp): Promise<Built> {
  const coll = await col<{ _id: unknown; d: Record<string, unknown> }>(collectionOf(source));
  const docs: { _id: string; d: Record<string, unknown> }[] = [];
  for await (const x of coll.find({}, { projection: { d: 1 } }).sort({ _id: 1 }).batchSize(5000)) if (x.d) docs.push({ _id: String(x._id), d: x.d });
  const etag = `"s${SCHEMA}.${source}.${docs.length}.${stamp.max}"`;
  const { cols, rows } = sourceTable(source, docs);
  const wire: SourceWire = columnarize(source, cols, rows, etag, Date.now());
  const gz = gzipAsync(JSON.stringify(wire), { level: 5 });
  gz.catch(() => {});
  return { stamp, etag, gz, total: docs.length };
}

/** Lista sursei, la zi față de baza de date (vezi comentariul de sus). */
export async function getSource(source: SourceId): Promise<Built> {
  const sl = slot(source);
  for (let attempt = 0; ; attempt++) {
    const stamp = await getStamp(source);
    const cur = sl.built;
    if (cur && cur.stamp.total === stamp.total && cur.stamp.max === stamp.max) return cur;
    if (sl.build && attempt < 4) {
      await sl.build.catch(() => {});
      continue;
    }
    const p = build(source, stamp)
      .then((b) => {
        sl.built = b;
        return b;
      })
      .finally(() => {
        if (sl.build === p) sl.build = undefined;
      });
    sl.build = p;
    return p;
  }
}
