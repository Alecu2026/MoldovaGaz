/**
 * Calculează nopțile pentru „Consum nemăsurat” (lib/night-job.ts) din baza NOASTRĂ: istoricul de citiri (meter_readings) + arhiva veche de volum (meter_history).
 *   npm run analyze:nights   → recalculează acum (altfel se face automat, o dată pe zi, la sfârșitul sincronizării)
 * Nu citește nimic din SCADA și nu scrie decât în colecția meter_nights. Mediu: DATABASE_URL.
 */
import { connectMongo } from "../lib/mongo-core";
import { analyzeAll } from "../lib/night-job";

const log = (m: string) => console.log(`[${new Date().toISOString()}] ${m}`);

async function main() {
  try { process.loadEnvFile(".env.local"); } catch { /* variabilele pot veni din mediu */ }
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL lipsește.");
  const client = await connectMongo(url);
  try {
    await analyzeAll(client.db(), log);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(`[${new Date().toISOString()}] EROARE: ${(e as Error).message}`);
  process.exit(1);
});
