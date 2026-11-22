/**
 * Încarcă în baza de date (colecția `meter_history`) fișierul JSONL produs de `fetch-history.ts`. Nu citește nimic din ThingsBoard.
 *   npm run history:load -- history.jsonl
 * Un document pe contor, înlocuit la fiecare încărcare (idempotent). Vectorii de puncte se salvează ca date binare compacte (vezi lib/meter-history.ts).
 * Scrie DOAR în colecția din HISTORY_COLLECTION (implicit `meter_history`). Mediu: DATABASE_URL.
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { Binary } from "mongodb";
import { connectMongo } from "../lib/mongo-core";
import type { HistoryLine } from "../lib/meter-history";

const log = (m: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${m}`);
const bin = (b64: string) => new Binary(Buffer.from(b64, "base64"));

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  const file = process.argv[2];
  if (!file) throw new Error("folosește: npm run history:load -- history.jsonl");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const client = await connectMongo(url);
  try {
    const coll = client.db().collection<{ _id: string }>(process.env.HISTORY_COLLECTION || "meter_history");
    let batch: { replaceOne: { filter: { _id: string }; replacement: never; upsert: true } }[] = [];
    let n = 0, bad = 0;
    const flush = async () => {
      if (!batch.length) return;
      await coll.bulkWrite(batch, { ordered: false });
      batch = [];
    };
    for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let d: HistoryLine;
      try { d = JSON.parse(line) as HistoryLine; } catch { bad++; continue; }
      const doc = { _id: d._id, from: d.from, to: d.to, fetchedAt: d.fetchedAt, h: { n: d.h.n, t: bin(d.h.t), v: bin(d.h.v) }, x: { n: d.x.n, t: bin(d.x.t), v: bin(d.x.v) } };
      batch.push({ replaceOne: { filter: { _id: d._id }, replacement: doc as never, upsert: true } });
      if (++n % 500 === 0) { await flush(); if (n % 10_000 === 0) log(`${n} contoare încărcate`); }
    }
    await flush();
    log(`gata: ${n} contoare încărcate (${bad} linii invalide ignorate); în colecție acum ${await coll.estimatedDocumentCount()}`);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`EROARE: ${(e as Error).message}`);
  process.exit(1);
});
