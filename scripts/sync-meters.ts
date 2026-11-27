/**
 * Sincronizează contoarele de gaz în colecția `meters`: lista și valorile curente din SCADA (iiot.scada.md) + facturarea din getmgdb.
 *   npm run sync:meters                       → sincronizare completă (scrie doar documentele MODIFICATE; șterge contoarele dispărute din sursă)
 *   npm run sync:meters -- --dry              → doar citește și combină, afișează statistici (nu scrie nimic)
 *   npm run sync:meters -- --dry --out f.json → la fel + salvează documentele în fișier
 *   npm run sync:meters -- --limit 2000       → doar primele N dispozitive (pentru teste; fără ștergeri)
 *   npm run sync:meters -- --patch-geo        → completează coordonatele (s.la / s.lo) pe documentele existente, din atributele lor (fără rețea)
 *   npm run sync:meters -- --load f.json      → scrie documentele dintr-un fișier produs cu --out (fără rețea; fără ștergeri)
 * Rulează periodic din pm2 (`<nume>-sync`, vezi ecosystem.config.js).
 * Mediu: TB_USER, TB_PASS, DATABASE_URL (+ opțional TB_URL, TB_PAUSE_MS = pauza dintre cereri în ms (implicit 150), MG_DB_URL, METERS_COLLECTION).
 * Doar CITIRE din SCADA și din getmgdb (clientul refuză orice altceva); scrie numai în colecțiile noastre.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { connectMongo } from "../lib/mongo-core";
import { buildDocs, fetchBilling, fetchDevices, fetchLatest, fetchLorawan, type Dev, type MeterDoc } from "../lib/meter-sync";
import { validCoords } from "../lib/meter-shared";
import { writeSources } from "../lib/source-sync";
import { appendReadings } from "../lib/meter-readings";
import { ingestIsNewer } from "../lib/integration";
import { maybeAnalyze } from "../lib/night-job";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

/**
 * --patch-geo: pune `s.la` / `s.lo` (latitudine / longitudine) pe documentele existente, din `attrs.latitude` / `attrs.longitude`. Nu citește nimic din rețea.
 * Atinge doar documentele care n-au încă aceste câmpuri; următoarea sincronizare completă le rescrie oricum.
 */
async function patchGeo() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const client = await connectMongo(url);
  try {
    const coll = client.db().collection<{ _id: string; attrs?: Record<string, unknown> }>(process.env.METERS_COLLECTION || "meters");
    const now = new Date();
    let scanned = 0, withGeo = 0;
    let ops: { updateOne: { filter: { _id: string }; update: { $set: Record<string, unknown> } } }[] = [];
    const flush = async () => {
      if (ops.length) await coll.bulkWrite(ops, { ordered: false });
      ops = [];
    };
    for await (const d of coll.find({ "s.la": { $exists: false } }, { projection: { attrs: 1 } })) {
      scanned++;
      const c = validCoords(d.attrs?.latitude, d.attrs?.longitude);
      if (c) withGeo++;
      ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { "s.la": c ? c[0] : null, "s.lo": c ? c[1] : null, updatedAt: now, h: "patch-geo" } } } });
      if (ops.length >= 1000) await flush();
    }
    await flush();
    log(`coordonate: ${scanned} documente actualizate, din care ${withGeo} cu coordonate valide`);
  } finally {
    await client.close();
  }
}

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* fără fișier: variabilele vin din mediu */ }
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const out = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
  let limit = args.includes("--limit") ? Number(args[args.indexOf("--limit") + 1]) || 0 : 0;
  const loadFile = args.includes("--load") ? args[args.indexOf("--load") + 1] : null;
  if (args.includes("--patch-geo")) {
    await patchGeo();
    return;
  }
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
    log("citesc facturarea (getmgdb)…");
    const billing = await fetchBilling();
    log(`  ${billing.length} rânduri de facturare`);

    log("citesc lista contoarelor din SCADA (cei 10 clienți de gaz, inclusiv Defectate_*)…");
    const list = await fetchDevices(log);
    const all: Dev[] = list.devices;
    if (all.length === 0) throw new Error("SCADA a întors 0 dispozitive: opresc (nu șterg nimic).");
    devices = limit ? all.slice(0, limit) : all;
    log(`  ${all.length} contoare în total`);

    // paginile „Dispozitive LoRaWAN” și „Facturare”: rândurile brute se salvează ÎNAINTE de valorile din SCADA, ca să rămână la zi chiar dacă SCADA nu răspunde
    if (!dry && !limit && process.env.DATABASE_URL) {
      const c = await connectMongo(process.env.DATABASE_URL);
      try {
        const errors = await writeSources(c.db(), await fetchLorawan(), billing, log);
        if (errors.length) log(`ATENȚIE: sursele brute nu s-au scris complet — ${errors.join(" | ")}`);
      } catch (e) {
        log(`ATENȚIE: sursele brute nu s-au scris — ${(e as Error).message}`);
      } finally {
        await c.close();
      }
    }

    log("citesc valorile curente din SCADA (volum, ts, coordonate, semnal…)…");
    const { byId, failed } = await fetchLatest(all.slice(0, devices.length), 500, log);
    if (failed.size > devices.length * 0.2) throw new Error(`prea multe loturi eșuate (${failed.size} dispozitive): opresc.`);

    const { docs, stats } = buildDocs(all.slice(0, devices.length), billing, byId, new Date());
    const { custFil, ...s } = stats;
    log(`combinat: ${JSON.stringify(s)}`);
    log(`filială pe client (dedusă din facturare): ${JSON.stringify(custFil)}`);
    const withVol = docs.filter((d) => d.s.v !== null).length, withTs = docs.filter((d) => d.tel.Volume_m3_Total_ts).length, withGeo = docs.filter((d) => d.s.la !== null).length;
    log(`acoperire: ${withVol} cu Volume_m3_Total, ${withTs} cu Volume_m3_Total_ts, ${withGeo} cu coordonate (din ${docs.length})`);
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
    const coll = client.db().collection<{ _id: string; h: string; ing?: number; s?: { t?: number } }>(process.env.METERS_COLLECTION || "meters");
    await Promise.all([coll.createIndex({ updatedAt: -1 }), coll.createIndex({ "s.t": -1 })]);
    const existing = new Map<string, { h: string; ing?: number; s?: { t?: number } }>();
    for await (const d of coll.find({}, { projection: { h: 1, ing: 1, "s.t": 1 } })) existing.set(d._id, d);

    // contoarele ale căror date au venit DIRECT prin integrare și sunt la fel de noi sau mai noi decât cele din SCADA nu se suprascriu
    const keptIngest = fresh.filter((d) => existing.get(d._id)?.h !== d.h && ingestIsNewer(existing.get(d._id), d.s.t)).length;
    if (keptIngest) log(`integrare: ${keptIngest} contoare păstrate (datele primite direct sunt mai noi decât cele din SCADA)`);
    const changed = fresh.filter((d) => existing.get(d._id)?.h !== d.h && !ingestIsNewer(existing.get(d._id), d.s.t));
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
    // istoricul propriu de citiri (pentru „Consum nemăsurat”) și analiza nopților (o dată pe zi); o eroare aici NU strică sincronizarea
    if (!limit) {
      try {
        await appendReadings(client.db(), fresh, log);
        await maybeAnalyze(client.db(), log);
      } catch (e) {
        log(`ATENȚIE: istoricul / analiza nopților — ${(e as Error).message}`);
      }
    }
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] EROARE: ${(e as Error).message}`);
  process.exit(1);
});
