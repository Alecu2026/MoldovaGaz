/**
 * Verifică problemele (contoare care nu mai transmit, antene fără mesaje / cu eficiență scăzută) și trimite notificări push utilizatorilor care le primesc (lib/alert-job.ts).
 * Citește doar din baza noastră; nimic din SCADA. Din pm2 (aplicația „<nume>-alerts”) rulează la fiecare 10 minute.
 *   npm run alerts:check
 */
import { connectMongo } from "../lib/mongo-core";
import { runAlerts } from "../lib/alert-job";
import { webPushSender } from "../lib/push";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const client = await connectMongo(url);
  try {
    const db = client.db();
    await runAlerts(db, { send: await webPushSender(db), log });
  } finally {
    await client.close();
  }
}

main().catch((e) => { console.error(`[${new Date().toISOString()}] verificarea alertelor a eșuat:`, e); process.exit(1); });
