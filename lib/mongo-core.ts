import dns from "node:dns";
import { MongoClient } from "mongodb";

/**
 * Conectare MongoDB fără dependențe de Next (o folosesc și scripturile din /scripts).
 *
 * `mongodb+srv://` cere interogări DNS de tip SRV. Unele rutere / ISP-uri le refuză (ECONNREFUSED la `querySrv`) deși browserul și Windows
 * rezolvă normal. Dacă prima încercare pică din cauza asta, schimbăm rezolvatorul DNS al procesului pe unul public și încercăm încă o dată.
 * Poți controla lista cu MONGO_DNS_SERVERS="1.1.1.1,8.8.8.8" (gol = fără fallback).
 */
const DNS_FALLBACK = (process.env.MONGO_DNS_SERVERS ?? "1.1.1.1,8.8.8.8")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export async function connectMongo(url: string): Promise<MongoClient> {
  const make = () => new MongoClient(url, { maxPoolSize: 10, serverSelectionTimeoutMS: 15_000, appName: "moldovagaz" });
  let client = make();
  try {
    await client.connect();
    return client;
  } catch (e) {
    await client.close().catch(() => {});
    const msg = e instanceof Error ? `${e.message} ${(e as { code?: string }).code ?? ""}` : String(e);
    const dnsProblem = /querySrv|queryTxt|ECONNREFUSED|ENOTFOUND|ETIMEOUT|ESERVFAIL/i.test(msg);
    if (!url.startsWith("mongodb+srv://") || !dnsProblem || DNS_FALLBACK.length === 0) throw e;
    dns.setServers(DNS_FALLBACK);
    client = make();
    await client.connect();
    return client;
  }
}
