import type { Db } from "mongodb";
import { billingDocs, type SrcDoc } from "./source-schemas";
import { SOURCE_COLLECTION_DEFAULTS, type SourceId } from "./source-shared";

/**
 * Salvează rândurile BRUTE din getmgdb (facturarea), ca să existe pagina „Facturare” (doar datele din sursă):
 *   `src_billing` — rândurile din getmgdb, cu toate câmpurile lor.
 * Se scriu DOAR documentele schimbate (hash pe conținut), iar cele dispărute din sursă se șterg (cu plasă de siguranță).
 * Nu depinde de SCADA: pagina rămâne la zi chiar dacă SCADA nu răspunde. Scrie exclusiv în colecția de mai sus; getmgdb se citește doar cu GET.
 */
export const sourceCollection = (): string => process.env.SRC_BILLING_COLLECTION || SOURCE_COLLECTION_DEFAULTS.billing;

/** Colecția veche cu dispozitivele din lorawandb (pagina /lorawan a fost scoasă). Numele e fixat aici ca să nu poată șterge altceva. */
const LEGACY_LORAWAN = "src_lorawan";
/** Șterge colecția veche `src_lorawan`. Întoarce câte documente avea (0 = nu exista). Se cheamă doar explicit (sync:sources -- --drop-lorawan). */
export async function dropLegacyLorawan(db: Db): Promise<number> {
  const exists = (await db.listCollections({ name: LEGACY_LORAWAN }, { nameOnly: true }).toArray()).length > 0;
  if (!exists) return 0;
  const n = await db.collection(LEGACY_LORAWAN).estimatedDocumentCount();
  await db.collection(LEGACY_LORAWAN).drop();
  return n;
}

export type WriteStats = { source: SourceId; fresh: number; written: number; removed: number; total: number };

export async function writeSource<T extends object>(db: Db, source: SourceId, docs: SrcDoc<T>[], log: (m: string) => void = () => {}): Promise<WriteStats> {
  if (docs.length === 0) throw new Error(`${source}: sursa a întors 0 rânduri — opresc (nu șterg nimic).`);
  const coll = db.collection<{ _id: string; h: string; updatedAt: Date; d: T }>(sourceCollection());
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

/** Scrie facturarea brută. Întoarce erorile (gol = totul a mers). */
export async function writeSources(db: Db, billing: unknown[], log: (m: string) => void = () => {}): Promise<string[]> {
  try {
    await writeSource(db, "billing", billingDocs(billing), log);
    return [];
  } catch (e) {
    return [`billing: ${(e as Error).message}`];
  }
}
