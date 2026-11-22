/**
 * Sincronizează contoarele reale în colecția `meters` (lorawandb + getmgdb + valorile curente din ThingsBoard).
 *   npm run sync:meters                       → sincronizare completă (scrie doar documentele MODIFICATE; șterge contoarele dispărute din sursă)
 *   npm run sync:meters -- --dry              → doar citește și combină, afișează statistici (nu scrie nimic)
 *   npm run sync:meters -- --dry --out f.json → la fel + salvează documentele în fișier
 *   npm run sync:meters -- --limit 2000       → doar primele N dispozitive (pentru teste; fără ștergeri)
 *   npm run sync:meters -- --load f.json      → scrie documentele dintr-un fișier produs cu --out (fără rețea; fără ștergeri) — pentru încărcarea inițială
 *                                               când serverul nu ajunge la ThingsBoard
 * Rulează periodic din pm2 (`<nume>-sync`, vezi ecosystem.config.js). Mediu: TB_USER, TB_PASS, DATABASE_URL (+ opțional TB_URL, MG_DB_URL, LORAWAN_DB_URL, METERS_COLLECTION).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connectMongo } from "../lib/mongo-core";
import { buildDocs, fetchLatest, fetchSources, type MeterDoc } from "../lib/meter-sync";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* fără fișier: variabilele vin din mediu */ }
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  let limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) || 0 : 0;
  const loadFile = args.includes("--load") ? args[args.indexOf("--load") + 1] : null;
  const t0 = Date.now();

  let fresh: MeterDoc[];
  let devices: { id: { id: string } }[] = [];
  if (loadFile) {
    fresh = (JSON.parse(readFileSync(loadFile, "utf8")) as (Omit<MeterDoc, "updatedAt"> & { updatedAt: string })[]).map((d) => ({ ...d, updatedAt: new Date(d.updatedAt) }));
    if (fresh.length === 0) throw new Error("fișier fără documente");
    limit = fresh.length; // fără ștergeri
    devices = fresh.map((d) => ({ id: { id: d._id } }));
    log(`încarc ${fresh.length} documente din ${loadFile}`);
  } else {
    log("citesc lorawandb + getmgdb…");
    const src = await fetchSources();
    if (src.devices.length === 0) throw new Error("lorawandb a întors 0 dispozitive: opresc (nu șterg nimic).");
    devices = limit ? src.devices.slice(0, limit) : src.devices;
    log(`  ${src.devices.length} dispozitive, ${src.billing.length} rânduri de facturare`);

    log("citesc valorile curente din ThingsBoard…");
    const { byId, failed } = await fetchLatest(src.devices.slice(0, devices.length), 500, log);
    if (failed.size > devices.length * 0.2) throw new Error(`prea multe loturi eșuate (${failed.size} dispozitive): opresc.`);

    const { docs, stats } = buildDocs(src.devices.slice(0, devices.length), src.billing, byId, new Date());
    const { custFil, ...s } = stats;
    log(`combinat: ${JSON.stringify(s)}`);
    log(`filială pe client: ${JSON.stringify(custFil)}`);
    if (failed.size) log(`ATENȚIE: ${failed.size} dispozitive fără valori noi (lot eșuat) — rămân cum erau`);
    fresh = docs.filter((d) => !failed.has(d._id));
  }

  if (out) {
    writeFileSync(out, JSON.stringify(fresh));
    log(`documente salvate în ${out}`);
  }
  if (dry) {
    log(`DRY: ${fresh.length} documente, nimic scris (${Math.round((Date.now() - t0) / 1000)} s)`);
    return;
  }

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const client = await connectMongo(url);
  try {
    const coll = client.db().collection<{ _id: string; h: string }>(process.env.METERS_COLLECTION || "meters");
    await Promise.all([coll.createIndex({ updatedAt: -1 }), coll.createIndex({ "s.t": -1 })]);
    const existing = new Map<string, string>();
    for await (const d of coll.find({}, { projection: { h: 1 } })) existing.set(d._id, d.h);

    const changed = fresh.filter((d) => existing.get(d._id) !== d.h);
    for (let i = 0; i < changed.length; i += 1000) {
      await coll.bulkWrite(changed.slice(i, i + 1000).map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d as never, upsert: true } })), { ordered: false });
    }
    let removed = 0;
    if (!limit) {
      const live = new Set(devices.map((d) => d.id.id));
      const gone = [...existing.keys()].filter((id) => !live.has(id));
      // plasă de siguranță: nu ștergem masiv dacă sursa pare incompletă
      if (gone.length > 0 && gone.length < Math.max(50, existing.size * 0.2)) removed = (await coll.deleteMany({ _id: { $in: gone } })).deletedCount;
      else if (gone.length) log(`ATENȚIE: ${gone.length} contoare lipsesc din sursă — NU le șterg (prea multe, sursa pare incompletă)`);
    }
    log(`gata: ${changed.length} documente scrise (${fresh.length - changed.length} neschimbate), ${removed} șterse, total acum ${await coll.estimatedDocumentCount()} (${Math.round((Date.now() - t0) / 1000)} s)`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] EROARE: ${(e as Error).message}`);
  process.exit(1);
});
