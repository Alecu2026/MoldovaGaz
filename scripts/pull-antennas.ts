/**
 * Aduce din SCADA antenele (gateway-uri LoRaWAN: dispozitivele de tip gatewayType) în colecția noastră `antennas` (lib/antenna-job.ts). Doar CITIRE din SCADA.
 *   npm run antennas:pull                      → lista și atributele antenelor (puține cereri); fără poze
 *   npm run antennas:pull -- --photos          → plus pozele antenelor care n-au încă poză (mari: ~4 MB fiecare în SCADA)
 * Din pm2 (aplicația „<nume>-antennas”, în fiecare zi la 22:30 și o dată la creare): atributele mereu; pozele DOAR dacă în mediu e ANTENNA_PHOTO_PULL=1.
 */
import { connectMongo } from "../lib/mongo-core";
import { pullAntennas } from "../lib/antenna-job";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  // antenele stau pe alt server SCADA decât contoarele (gw.scada.md): doar pentru acest proces, adresa și contul de citire pot veni din ANTENNA_TB_*
  if (process.env.ANTENNA_TB_URL) { process.env.TB_URL = process.env.ANTENNA_TB_URL; if (process.env.ANTENNA_TB_USER) process.env.TB_USER = process.env.ANTENNA_TB_USER; if (process.env.ANTENNA_TB_PASS) process.env.TB_PASS = process.env.ANTENNA_TB_PASS; }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const photos = process.argv.includes("--photos") || process.env.ANTENNA_PHOTO_PULL === "1";
  let stop = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { stop = true; log(`${sig}: mă opresc după antena curentă`); });
  const client = await connectMongo(url);
  try {
    await pullAntennas(client.db(), { photos, log, shouldStop: () => stop });
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(`[${new Date().toISOString()}] extragerea antenelor a eșuat:`, e); process.exit(1); });
