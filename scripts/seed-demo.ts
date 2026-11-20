/**
 * Date SINTETICE pentru a vedea tabelul la scară (virtualizare, filtre, cache).
 *   UPLINKS_COLLECTION=uplinks_demo npm run seed:demo -- 150000
 * Scrie DOAR în colecția din UPLINKS_COLLECTION și REFUZĂ să ruleze pe colecția reală `uplinks`.
 * Pornește aplicația cu aceeași variabilă (UPLINKS_COLLECTION=uplinks_demo npm run dev). Ștergere:
 *   UPLINKS_COLLECTION=uplinks_demo npm run seed:demo -- drop
 */
import { createHash } from "node:crypto";
import { connectMongo } from "../lib/mongo-core";
import { FLAG, type UplinkSummary } from "../lib/uplink-shared";

async function main() {
  process.loadEnvFile(".env.local");
  const name = process.env.UPLINKS_COLLECTION;
  if (!name || name === "uplinks") throw new Error("Setează UPLINKS_COLLECTION la o colecție de test (ex. uplinks_demo). Colecția reală nu se atinge.");
  const arg = process.argv[2] ?? "150000";
  const client = await connectMongo(process.env.DATABASE_URL as string);
  try {
    const coll = client.db().collection(name);
    if (arg === "drop") {
      await coll.drop().catch(() => {});
      console.log(`Colecția ${name} a fost ștearsă.`);
      return;
    }
    const n = Math.max(1, Number(arg) || 150_000);
    const days = 14;
    const now = Date.now();
    const devices = Array.from({ length: 1800 }, (_, i) => ({
      d: `${2154 + (i % 4)}_${String(70000 + i * 7).padStart(8, "0")}_${2022 + (i % 3)}`,
      e: (0x001a79881800 + i * 13).toString(16).padStart(16, "0"),
      a: i % 5 === 0 ? "App_Cimislia_Gaz_ABP_jooby" : "App_Comrat_Gaz_ABP_jooby",
    }));
    const gws = ["M4_Comrat_Gaz", "M-804750_Comrat_Novaia", "RAK_60FD_Reserve", "M2_Cimislia", "M7_Vulcanesti", "M9_Taraclia"];
    const types = [["CurrentTime", "CurrentDataMul"], ["HoursDataMul", "LastEventSeq"], ["LastEventSeq"], ["CurrentDataMul"], ["DayData", "LastEventSeq"]];
    let seed = 99;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
    const pick = <T,>(a: T[]) => a[Math.floor(rnd() * a.length)];
    console.log(`Generez ${n} mesaje în ${name}…`);
    for (let off = 0; off < n; off += 10_000) {
      const docs = [];
      for (let i = off; i < Math.min(n, off + 10_000); i++) {
        const ts = now - Math.floor(((n - i) / n) * days * 86_400_000) + Math.floor(rnd() * 1000);
        const dv = devices[Math.floor(rnd() * devices.length)];
        let fl = rnd() < 0.5 ? FLAG.ADR : 0;
        if (rnd() < 0.7) fl |= FLAG.STATUS;
        if (rnd() < 0.015) fl |= FLAG.BATT;
        if (rnd() < 0.02) fl |= FLAG.OFFLINE;
        if (rnd() < 0.01) fl |= FLAG.BTN;
        if (rnd() < 0.005) fl |= FLAG.MAG;
        const fc = Math.floor(rnd() * 40_000);
        const s: UplinkSummary = {
          t: ts, d: dv.d, e: dv.e, a: dv.a, g: rnd() < 0.01 ? null : pick(gws), gn: 1 + Math.floor(rnd() * 3),
          r: rnd() < 0.01 ? null : -(75 + Math.floor(rnd() * 50)), n: Math.round((rnd() * 20 - 12) * 10) / 10,
          f: pick([868100, 868300, 868500]), dr: Math.floor(rnd() * 6), fl, fc, pt: 1, ty: pick(types), v: rnd() < 0.1 ? null : 9000 + Math.floor(rnd() * 3000),
        };
        docs.push({
          _id: createHash("sha1").update(`${name}${i}`).digest("hex").slice(0, 24) as never,
          receivedAt: new Date(ts + 300), ts: new Date(ts), devEUI: dv.e, deviceName: dv.d, applicationName: dv.a, s,
          payload: { demo: true, devEUI: dv.e, deviceName: dv.d, applicationName: dv.a, fCnt: fc },
        });
      }
      await coll.insertMany(docs, { ordered: false });
      process.stdout.write(`\r${Math.min(n, off + 10_000)} / ${n}`);
    }
    await coll.createIndex({ receivedAt: -1 });
    await coll.createIndex({ ts: -1 });
    console.log("\nGata.");
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
