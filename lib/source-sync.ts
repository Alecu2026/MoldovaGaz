import type { Db } from "mongodb";
import { billingDocs, lorawanDocs, type SrcDoc } from "./source-schemas";
import { SOURCE_COLLECTION_DEFAULTS, type SourceId } from "./source-shared";

/**
 * Salvează rândurile BRUTE ale celor două surse, ca să existe paginile pe sursă (lorawandb = primul IP, getmgdb = al doilea IP):
 *   `src_lorawan`  — dispozitivele din lorawandb (doar câmpurile de identificare; fără `deviceData` și fără chei LoRaWAN);
 *   `src_billing`  — rândurile din getmgdb, cu toate câmpurile lor.
 * Se scriu DOAR documentele schimbate (hash pe conținut), iar cele dispărute din sursă se șterg (cu plasă de siguranță).
 * Nu depinde de ThingsBoard: paginile pe sursă rămân la zi chiar dacă ThingsBoard nu răspunde.
 * Scrie exclusiv în aceste două colecții; sursele (lorawandb / getmgdb) se citesc doar cu GET.
 */
export const sourceCollection = (s: SourceId): string =>
  (s === "lorawan" ? process.env.SRC_LORAWAN_COLLECTION : process.env.SRC_BILLING_COLLECTION) || SOURCE_COLLECTION_DEFAULTS[s];

export type WriteStats = { source: SourceId; fresh: number; written: number; removed: number; total: number };

export async function writeSource<T extends object>(db: Db, source: SourceId, docs: SrcDoc<T>[], log: (m: string) => void = () => {}): Promise<WriteStats> {
  if (docs.length === 0) throw new Error(`${source}: sursa a întors 0 rânduri — opresc (nu șterg nimic).`);
  const coll = db.collection<{ _id: string; h: string; updatedAt: Date; d: T }>(sourceCollection(source));
  await coll.createIndex({ updatedAt: -1 });
  const existing = new Map<string, string>();
  for await (const x of coll.find({}, { projection: { h: 1 } })) existing.set(String(x._id), x.h);

  const now = new Date();
  const changed = docs.filter((d) => existing.get(d._id) !== d.h);
  for (let i = 0; i < changed.length; i += 1000) {
    await coll.bulkWrite(
      changed.slice(i, i + 1000).map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: { _id: d._id, h: d.h, updatedAt: now, d: d.d }, upsert: true } })),
      { ordered: false },
    );
  }

  let removed = 0;
  const live = new Set(docs.map((d) => d._id));
  const gone = [...existing.keys()].filter((id) => !live.has(id));
  // plasă de siguranță: nu ștergem masiv dacă sursa pare incompletă
  if (gone.length > 0 && gone.length < Math.max(50, existing.size * 0.2)) {
    for (let i = 0; i < gone.length; i += 1000) removed += (await coll.deleteMany({ _id: { $in: gone.slice(i, i + 1000) } })).deletedCount;
  } else if (gone.length) log(`ATENȚIE (${source}): ${gone.length} rânduri lipsesc din sursă — NU le șterg (prea multe, sursa pare incompletă)`);

  const total = await coll.estimatedDocumentCount();
  log(`${source}: ${docs.length} rânduri în sursă, ${changed.length} scrise (${docs.length - changed.length} neschimbate), ${removed} șterse, total acum ${total}`);
  return { source, fresh: docs.length, written: changed.length, removed, total };
}

/** Scrie ambele surse. Eșecul uneia nu o oprește pe cealaltă; întoarce erorile (gol = totul a mers). */
export async function writeSources(db: Db, devices: unknown[], billing: unknown[], log: (m: string) => void = () => {}): Promise<string[]> {
  const errors: string[] = [];
  const run = async (name: string, f: () => Promise<unknown>) => {
    try {
      await f();
    } catch (e) {
      errors.push(`${name}: ${(e as Error).message}`);
    }
  };
  await run("lorawan", () => writeSource(db, "lorawan", lorawanDocs(devices), log));
  await run("billing", () => writeSource(db, "billing", billingDocs(billing), log));
  return errors;
}
